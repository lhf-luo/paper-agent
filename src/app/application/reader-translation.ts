import { createHash, randomUUID } from "node:crypto";
import type { PaperAgentConfig, ReaderTranslationProvider } from "../../config/domain/config-types.ts";
import { type Fetcher, fetchWithTimeout } from "../../shared/infrastructure/network-security.ts";

export type TranslationTarget = "zh-CN" | "en";

export class ReaderTranslationError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function availableReaderTranslationProviders(config: PaperAgentConfig): ReaderTranslationProvider[] {
	const credentials = config.credentials;
	return (["google", "deepl", "youdao", "baidu"] as const).filter((provider) => {
		if (provider === "google") return Boolean(credentials?.googleTranslateApiKey);
		if (provider === "deepl") return Boolean(credentials?.deeplApiKey);
		if (provider === "youdao") return Boolean(credentials?.youdaoAppId && credentials.youdaoAppSecret);
		return Boolean(credentials?.baiduTranslateAppId && credentials.baiduTranslateAppSecret);
	});
}

function upstreamError(response: Response): never {
	if (response.status === 401 || response.status === 403)
		throw new ReaderTranslationError(502, "翻译服务认证或权限失败，请检查密钥");
	if (response.status === 429) throw new ReaderTranslationError(429, "翻译服务已限流，请稍后重试");
	throw new ReaderTranslationError(502, `翻译服务请求失败（HTTP ${response.status}）`);
}

function translatedText(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new ReaderTranslationError(502, "翻译服务返回的译文无效");
	return value.trim();
}

export async function translateReaderSelection(input: {
	text: string;
	provider: ReaderTranslationProvider;
	targetLanguage: TranslationTarget;
	config: PaperAgentConfig;
	signal?: AbortSignal;
	fetcher?: Fetcher;
}): Promise<{ translation: string; provider: ReaderTranslationProvider; detectedLanguage?: string }> {
	const { provider, targetLanguage, config, signal, fetcher } = input;
	const text = input.text.trim();
	if (!text || Array.from(text).length > 5_000) throw new ReaderTranslationError(400, "选中文字须为 1–5000 个字符");
	if (!availableReaderTranslationProviders(config).includes(provider))
		throw new ReaderTranslationError(400, "该翻译服务尚未配置密钥");
	const credentials = config.credentials!;
	let url: URL;
	let init: RequestInit;
	if (provider === "google") {
		url = new URL("https://translation.googleapis.com/language/translate/v2");
		url.searchParams.set("key", credentials.googleTranslateApiKey!);
		init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ q: text, target: targetLanguage, format: "text" }),
		};
	} else if (provider === "deepl") {
		url = new URL(
			credentials.deeplApiKey!.endsWith(":fx")
				? "https://api-free.deepl.com/v2/translate"
				: "https://api.deepl.com/v2/translate",
		);
		init = {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `DeepL-Auth-Key ${credentials.deeplApiKey}` },
			body: JSON.stringify({ text: [text], target_lang: targetLanguage === "zh-CN" ? "ZH" : "EN" }),
		};
	} else if (provider === "youdao") {
		url = new URL("https://openapi.youdao.com/api");
		const salt = randomUUID();
		const curtime = String(Math.floor(Date.now() / 1000));
		const signatureInput = text.length <= 20 ? text : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
		const sign = createHash("sha256")
			.update(`${credentials.youdaoAppId}${signatureInput}${salt}${curtime}${credentials.youdaoAppSecret}`)
			.digest("hex");
		const body = new URLSearchParams({
			q: text,
			from: "auto",
			to: targetLanguage === "zh-CN" ? "zh-CHS" : "en",
			appKey: credentials.youdaoAppId!,
			salt,
			sign,
			signType: "v3",
			curtime,
		});
		init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body };
	} else {
		url = new URL("https://fanyi-api.baidu.com/api/trans/vip/translate");
		const salt = randomUUID().replaceAll("-", "");
		const sign = createHash("md5")
			.update(`${credentials.baiduTranslateAppId}${text}${salt}${credentials.baiduTranslateAppSecret}`)
			.digest("hex");
		const body = new URLSearchParams({
			q: text,
			from: "auto",
			to: targetLanguage === "zh-CN" ? "zh" : "en",
			appid: credentials.baiduTranslateAppId!,
			salt,
			sign,
		});
		init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body };
	}
	let response: Response;
	try {
		response = await fetchWithTimeout(url, signal, 15_000, init, fetcher);
	} catch (error) {
		if (signal?.aborted) throw new ReaderTranslationError(499, "翻译请求已取消");
		throw new ReaderTranslationError(
			504,
			error instanceof Error && /timeout|timed out|abort/i.test(error.message)
				? "翻译服务响应超时"
				: "翻译服务网络连接失败",
		);
	}
	if (!response.ok) upstreamError(response);
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new ReaderTranslationError(502, "翻译服务返回的数据无效");
	}
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new ReaderTranslationError(502, "翻译服务返回的数据无效");
	const value = data as Record<string, unknown>;
	if (provider === "google") {
		const translations = (
			value.data as
				| { translations?: Array<{ translatedText?: unknown; detectedSourceLanguage?: unknown }> }
				| undefined
		)?.translations;
		return {
			translation: translatedText(translations?.[0]?.translatedText),
			provider,
			detectedLanguage:
				typeof translations?.[0]?.detectedSourceLanguage === "string"
					? translations[0].detectedSourceLanguage
					: undefined,
		};
	}
	if (provider === "deepl") {
		const translations = value.translations as
			| Array<{ text?: unknown; detected_source_language?: unknown }>
			| undefined;
		return {
			translation: translatedText(translations?.[0]?.text),
			provider,
			detectedLanguage:
				typeof translations?.[0]?.detected_source_language === "string"
					? translations[0].detected_source_language
					: undefined,
		};
	}
	if (provider === "youdao") {
		if (String(value.errorCode) !== "0")
			throw new ReaderTranslationError(502, `有道翻译请求失败（错误码 ${String(value.errorCode ?? "unknown")}）`);
		const translations = value.translation as unknown;
		return {
			translation: translatedText(Array.isArray(translations) ? translations[0] : undefined),
			provider,
			detectedLanguage: typeof value.l === "string" ? value.l.split("2")[0] : undefined,
		};
	}
	if (value.error_code !== undefined) {
		const code = String(value.error_code);
		if (code === "54001")
			throw new ReaderTranslationError(502, "百度翻译签名验证失败，请检查 APP ID 和密钥（54001）");
		if (code === "54003") throw new ReaderTranslationError(429, "百度翻译调用过于频繁，请稍后重试（54003）");
		throw new ReaderTranslationError(502, `百度翻译请求失败（错误码 ${code}）`);
	}
	const translations = value.trans_result;
	if (!Array.isArray(translations) || !translations.length)
		throw new ReaderTranslationError(502, "百度翻译返回的译文无效");
	return {
		translation: translations
			.map((item: unknown) => translatedText((item as { dst?: unknown } | null)?.dst))
			.join("\n"),
		provider,
		detectedLanguage: typeof value.from === "string" ? value.from : undefined,
	};
}
