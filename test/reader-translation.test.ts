import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	availableReaderTranslationProviders,
	ReaderTranslationError,
	translateReaderSelection,
} from "../src/app/application/reader-translation.ts";
import { defaultPaperAgentConfig } from "../src/config/domain/config-validation.ts";
import type { Fetcher } from "../src/shared/infrastructure/network-security.ts";

function configured() {
	const config = defaultPaperAgentConfig();
	config.credentials = {
		googleTranslateApiKey: "google-secret",
		deeplApiKey: "deepl-secret:fx",
		youdaoAppId: "app-id",
		youdaoAppSecret: "youdao-secret",
		baiduTranslateAppId: "baidu-app-id",
		baiduTranslateAppSecret: "baidu-secret",
	};
	return config;
}

describe("reader selection translation", () => {
	it("only exposes configured provider names and never needs the model registry", () => {
		expect(availableReaderTranslationProviders(defaultPaperAgentConfig())).toEqual([]);
		expect(availableReaderTranslationProviders(configured())).toEqual(["google", "deepl", "youdao", "baidu"]);
		const missingSecret = configured();
		delete missingSecret.credentials?.baiduTranslateAppSecret;
		expect(availableReaderTranslationProviders(missingSecret)).not.toContain("baidu");
	});

	it("sends Google text translation with a server-held API key", async () => {
		const fetcher = vi.fn<Fetcher>(async (url, init) => {
			expect(String(url)).toContain("key=google-secret");
			expect(JSON.parse(String(init?.body))).toEqual({ q: "hello", target: "zh-CN", format: "text" });
			return Response.json({ data: { translations: [{ translatedText: "你好", detectedSourceLanguage: "en" }] } });
		});
		expect(
			await translateReaderSelection({
				text: "hello",
				provider: "google",
				targetLanguage: "zh-CN",
				config: configured(),
				fetcher,
			}),
		).toEqual({ translation: "你好", provider: "google", detectedLanguage: "en" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("uses the DeepL free endpoint and translates into Chinese", async () => {
		const fetcher = vi.fn<Fetcher>(async (url, init) => {
			expect(String(url)).toBe("https://api-free.deepl.com/v2/translate");
			expect(new Headers(init?.headers).get("authorization")).toBe("DeepL-Auth-Key deepl-secret:fx");
			expect(JSON.parse(String(init?.body))).toEqual({ text: ["hello"], target_lang: "ZH" });
			return Response.json({ translations: [{ text: "你好", detected_source_language: "EN" }] });
		});
		expect(
			(
				await translateReaderSelection({
					text: "hello",
					provider: "deepl",
					targetLanguage: "zh-CN",
					config: configured(),
					fetcher,
				})
			).translation,
		).toBe("你好");
	});

	it("signs the Youdao request without exposing its secret in the form body", async () => {
		const fetcher = vi.fn<Fetcher>(async (_url, init) => {
			const body = init?.body as URLSearchParams;
			const expected = createHash("sha256")
				.update(`app-id${body.get("q")}${body.get("salt")}${body.get("curtime")}youdao-secret`)
				.digest("hex");
			expect(body.get("sign")).toBe(expected);
			expect(body.toString()).not.toContain("youdao-secret");
			return Response.json({ errorCode: "0", translation: ["你好"] });
		});
		expect(
			(
				await translateReaderSelection({
					text: "hello",
					provider: "youdao",
					targetLanguage: "zh-CN",
					config: configured(),
					fetcher,
				})
			).translation,
		).toBe("你好");
	});

	it("signs Baidu form data using the original UTF-8 text and returns every translated segment", async () => {
		const text = "hello & 世界";
		const fetcher = vi.fn<Fetcher>(async (url, init) => {
			expect(String(url)).toBe("https://fanyi-api.baidu.com/api/trans/vip/translate");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
			const body = init?.body as URLSearchParams;
			expect(body.get("q")).toBe(text);
			expect(body.get("from")).toBe("auto");
			expect(body.get("to")).toBe("zh");
			expect(body.get("appid")).toBe("baidu-app-id");
			expect(body.get("salt")).toMatch(/^[a-f0-9]{32}$/);
			expect(body.get("sign")).toBe(
				createHash("md5")
					.update(`baidu-app-id${text}${body.get("salt")}baidu-secret`)
					.digest("hex"),
			);
			expect(body.toString()).not.toContain("baidu-secret");
			return Response.json({
				from: "en",
				to: "zh",
				trans_result: [
					{ src: "hello", dst: "你好" },
					{ src: "world", dst: "世界" },
				],
			});
		});
		expect(
			await translateReaderSelection({
				text,
				provider: "baidu",
				targetLanguage: "zh-CN",
				config: configured(),
				fetcher,
			}),
		).toEqual({ translation: "你好\n世界", provider: "baidu", detectedLanguage: "en" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("reports Baidu authentication, rate-limit, and malformed success responses", async () => {
		const translate = (fetcher: Fetcher) =>
			translateReaderSelection({
				text: "apple",
				provider: "baidu",
				targetLanguage: "en" as const,
				config: configured(),
				fetcher,
			});
		await expect(
			translate(async (_url, init) => {
				expect((init?.body as URLSearchParams).get("to")).toBe("en");
				return Response.json({ error_code: "54001", error_msg: "Invalid Sign" });
			}),
		).rejects.toMatchObject({ status: 502, message: expect.stringContaining("54001") });
		await expect(translate(async () => Response.json({ error_code: "54003" }))).rejects.toMatchObject({
			status: 429,
		});
		await expect(translate(async () => Response.json({ trans_result: [] }))).rejects.toMatchObject({ status: 502 });
	});

	it("reports absent credentials, oversize selections, rate limits, and malformed responses", async () => {
		await expect(
			translateReaderSelection({
				text: "hello",
				provider: "google",
				targetLanguage: "zh-CN",
				config: defaultPaperAgentConfig(),
			}),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			translateReaderSelection({
				text: "x".repeat(5001),
				provider: "google",
				targetLanguage: "zh-CN",
				config: configured(),
			}),
		).rejects.toMatchObject({ status: 400 });
		const limited: Fetcher = async () => new Response("limited", { status: 429 });
		await expect(
			translateReaderSelection({
				text: "hello",
				provider: "google",
				targetLanguage: "zh-CN",
				config: configured(),
				fetcher: limited,
			}),
		).rejects.toMatchObject({ status: 429 });
		const invalid: Fetcher = async () => Response.json({ data: { translations: [] } });
		await expect(
			translateReaderSelection({
				text: "hello",
				provider: "google",
				targetLanguage: "zh-CN",
				config: configured(),
				fetcher: invalid,
			}),
		).rejects.toBeInstanceOf(ReaderTranslationError);
		const nullResponse: Fetcher = async () => Response.json(null);
		await expect(
			translateReaderSelection({
				text: "hello",
				provider: "google",
				targetLanguage: "zh-CN",
				config: configured(),
				fetcher: nullResponse,
			}),
		).rejects.toMatchObject({ status: 502 });
	});
});
