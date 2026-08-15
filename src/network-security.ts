import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string }>>;

/** 代理配置(从 config.json 的 network.proxy 读取)。留空则直连。 */
let configuredProxy: URL | undefined;

/**
 * 把任意错误转成可读消息。AggregateError 的 message 常为空字符串,
 * 真实原因在其 errors[] 里(例如连接超时 connect ETIMEDOUT)。
 */
export function readableErrorMessage(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length > 0) {
		const first = error.errors[0];
		if (first instanceof Error && first.message) return first.message;
		if (first !== undefined && first !== null) return String(first);
	}
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

const PYTHON_DOWNLOAD_SCRIPT = String.raw`
import sys, urllib.request, ssl
url = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
handlers = []
if proxy:
    handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
opener = urllib.request.build_opener(*handlers)
req = urllib.request.Request(url, headers={
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/pdf,*/*;q=0.8',
})
try:
    resp = opener.open(req, timeout=timeout)
    sys.stdout.buffer.write(resp.read())
except Exception as exc:
    sys.stderr.write(str(exc))
    sys.exit(1)
`;

/**
 * 用系统 Python(标准库 urllib)下载文件内容。
 *
 * 用途: 部分站点(如 arXiv)对 Node 的 TLS 指纹返回反爬挑战页,
 * 而标准 Python 客户端指纹与 curl 类似, 下载更稳定。
 * 仅在 arXiv/export.arxiv.org 等已知域名上启用, 失败时调用方回退到 Node 通道。
 */
export async function downloadViaPython(
	url: URL,
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Python download requires http(s) URL");
	}
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		throw new Error("Private hostname is not allowed: " + hostname);
	}
	if (isIP(hostname) && isPrivateAddress(hostname)) {
		throw new Error("Private or reserved address is not allowed: " + hostname);
	}
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
	const proxy = configuredProxy?.href ?? "";
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.env.PAPER_AGENT_PYTHON_BIN ?? "python3",
			["-c", PYTHON_DOWNLOAD_SCRIPT, url.href, proxy, String(timeoutMs / 1000)],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const chunks: Buffer[] = [];
		let total = 0;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`python download timeout after ${timeoutMs}ms`));
		}, timeoutMs + 5_000);
		child.stdout.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				child.kill("SIGKILL");
				clearTimeout(timer);
				reject(new Error(`python download exceeded ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`python download failed (exit ${code})${stderr ? ": " + stderr.slice(0, 200) : ""}`));
				return;
			}
			const body = Buffer.concat(chunks);
			if (body.length === 0) {
				reject(new Error("python download returned an empty body"));
				return;
			}
			resolve(new Uint8Array(body));
		});
	});
}

export function setProxyUrl(value: string | undefined): void {
	if (!value) {
		configuredProxy = undefined;
		return;
	}
	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Proxy URL must use http:// or https://");
	}
	configuredProxy = parsed;
}

function proxyTarget(
	target: URL,
	options: { method: string; headers: Record<string, string>; signal?: AbortSignal },
	handler: (response: IncomingMessage) => void,
): Promise<ClientRequest> {
	const proxy = configuredProxy as URL;
	const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
	if (target.protocol === "https:") {
		// HTTPS 目标: CONNECT 隧道 + 隧道内 TLS
		return new Promise((resolve, reject) => {
			const tunnel = httpRequest({
				host: proxy.hostname,
				port: proxyPort,
				method: "CONNECT",
				path: `${target.hostname}:443`,
				signal: options.signal,
			});
			tunnel.once("connect", (_response, socket, head) => {
				if (head && head.length) socket.unshift(head);
				const secured = httpsRequest(
					{
						host: target.hostname,
						servername: target.hostname,
						socket,
						method: options.method,
						headers: options.headers,
						signal: options.signal,
					} as unknown as import("node:https").RequestOptions,
					handler,
				);
				armTimeout(secured);
				resolve(secured);
			});
			tunnel.once("response", (response) => {
				response.resume();
				tunnel.destroy();
				reject(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode ?? 500}`));
			});
			armTimeout(tunnel);
			tunnel.once("error", reject);
			tunnel.end();
		});
	}
	// HTTP 目标: 代理的绝对形式请求
	const proxied = httpRequest(
		{
			host: proxy.hostname,
			port: proxyPort,
			path: target.href,
			method: options.method,
			headers: { ...options.headers, Host: target.host },
			signal: options.signal,
		},
		handler,
	);
	armTimeout(proxied);
	return Promise.resolve(proxied);
}

export const DEFAULT_USER_AGENT = "pi-paper-agent/0.2 (academic research assistant)";

/** 单次连接/空闲超时: 不可达 IP 快速失败, 不再干等 30 秒 */
const CONNECT_TIMEOUT_MS = 10_000;

function armTimeout(outgoing: ClientRequest): void {
	// Node 的 request.setTimeout 只在 socket 连接后才生效, 覆盖不了 TCP 连接阶段;
	// 改为在 socket 事件里直接设置, 让连接阶段(黑洞 IP)也能快速失败。
	outgoing.once("socket", (socket) => {
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
			socket.destroy(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
		});
	});
}

export function isPrivateIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
	const [a, b, c] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 4) return isPrivateIpv4(address);
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8:")
	);
}

const defaultResolver: AddressResolver = async (hostname) =>
	(await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address }));

export async function assertPublicUrl(url: URL, resolver: AddressResolver = defaultResolver): Promise<string[]> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Only http:// and https:// URLs are allowed");
	}
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		throw new Error("Private hostname is not allowed: " + hostname);
	}
	if (isIP(hostname)) {
		if (isPrivateAddress(hostname)) throw new Error("Private or reserved address is not allowed: " + hostname);
		return [hostname];
	}
	const addresses = await resolver(hostname);
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error("Hostname does not resolve exclusively to public addresses: " + hostname);
	}
	return [...new Set(addresses.map((entry) => entry.address))];
}

function fetchPinnedUrl(url: URL, init: RequestInit, verifiedAddresses: string[]): Promise<Response> {
	if (init.body !== undefined && init.body !== null) {
		throw new Error("Pinned public URL requests do not support request bodies");
	}
	const addresses = verifiedAddresses
		.map((address) => ({ address, family: isIP(address) }))
		.filter((entry) => entry.family);
	if (addresses.length === 0) throw new Error("Public URL request has no verified IP address");
	let nextAddress = 0;
	const lookupPinned = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
		const requestedFamily =
			typeof options === "number"
				? options
				: typeof options === "object" && options !== null && "family" in options
					? Number((options as { family?: unknown }).family ?? 0)
					: 0;
		const matching = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
		if (matching.length === 0) {
			callback(new Error("No verified address matches the requested IP family"));
			return;
		}
		if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
			callback(null, matching);
			return;
		}
		const selected = matching[nextAddress++ % matching.length];
		callback(null, selected.address, selected.family);
	};
	const requestHeaders = new Headers(init.headers);
	if (!requestHeaders.has("accept-encoding")) requestHeaders.set("accept-encoding", "identity");
	const headerRecord: Record<string, string> = {};
	requestHeaders.forEach((value, name) => {
		headerRecord[name] = value;
	});
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const onIncoming = (incoming: IncomingMessage) => {
			const status = incoming.statusCode ?? 500;
			if (status < 200) {
				incoming.destroy();
				reject(new Error(`Unsupported informational HTTP response: ${status}`));
				return;
			}
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (Array.isArray(value)) for (const item of value) headers.append(name, item);
				else if (value !== undefined) headers.set(name, value);
			}
			resolve(
				new Response(
					[204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
					{
						status,
						statusText: incoming.statusMessage,
						headers,
					},
				),
			);
		};
		const requestOptions = {
			method: init.method ?? "GET",
			headers: headerRecord,
			signal: init.signal ?? undefined,
		};
		if (configuredProxy) {
			void proxyTarget(url, requestOptions, onIncoming).then(
				(outgoing) => {
					armTimeout(outgoing);
					outgoing.once("error", reject);
					outgoing.end();
				},
				reject,
			);
			return;
		}
		const outgoing = request(
			url,
			{
				...requestOptions,
				lookup: lookupPinned as never,
			},
			onIncoming,
		);
		armTimeout(outgoing);
		outgoing.once("error", reject);
		outgoing.end();
	});
}

export async function fetchWithTimeout(
	url: URL,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	init: RequestInit = {},
	fetcher: Fetcher = fetch,
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return fetcher(url, {
		...init,
		signal: combinedSignal,
		headers: {
			Accept: "text/html,application/xhtml+xml,application/json,application/atom+xml,text/plain,*/*;q=0.5",
			"User-Agent": DEFAULT_USER_AGENT,
			...init.headers,
		},
	});
}

function retryAfterMilliseconds(response: Response): number | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return undefined;
	return Math.max(0, Math.min(date - Date.now(), 30_000));
}

export async function fetchWithRetry(
	url: URL,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		init?: RequestInit;
		fetcher?: Fetcher;
		maxRetries?: number;
		baseDelayMs?: number;
		beforeAttempt?: () => Promise<void>;
	} = {},
): Promise<Response> {
	const maxRetries = options.maxRetries ?? 2;
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			await options.beforeAttempt?.();
			const response = await fetchWithTimeout(
				url,
				options.signal,
				options.timeoutMs ?? 20_000,
				options.init,
				options.fetcher,
			);
			const retryable =
				response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
			if (!retryable || attempt === maxRetries) return response;
			const waitMs =
				retryAfterMilliseconds(response) ?? Math.min((options.baseDelayMs ?? 500) * 2 ** attempt, 8_000);
			await response.body?.cancel();
			await delay(waitMs, undefined, { signal: options.signal });
		} catch (error) {
			lastError = error;
			if (options.signal?.aborted || attempt === maxRetries) throw error;
			await delay(Math.min((options.baseDelayMs ?? 500) * 2 ** attempt, 8_000), undefined, {
				signal: options.signal,
			});
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

export async function fetchPublicUrl(
	initialUrl: URL,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxRedirects?: number;
		fetcher?: Fetcher;
		resolver?: AddressResolver;
		init?: RequestInit;
		maxRetries?: number;
		baseDelayMs?: number;
		requireHttps?: boolean;
	} = {},
): Promise<{ response: Response; finalUrl: URL }> {
	let currentUrl = initialUrl;
	if (options.requireHttps && currentUrl.protocol !== "https:") {
		throw new Error("Request and redirect targets must use HTTPS");
	}
	const maxRedirects = options.maxRedirects ?? 5;
	for (let redirect = 0; redirect <= maxRedirects; redirect++) {
		let verifiedAddresses: string[] = [];
		const response = await fetchWithRetry(currentUrl, {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 20_000,
			init: { ...options.init, redirect: "manual" },
			fetcher:
				options.fetcher ??
				((input, init) =>
					fetchPinnedUrl(
						input instanceof URL ? input : new URL(input instanceof Request ? input.url : input),
						init ?? {},
						verifiedAddresses,
					)),
			maxRetries: options.maxRetries,
			baseDelayMs: options.baseDelayMs,
			beforeAttempt: async () => {
				verifiedAddresses = await assertPublicUrl(currentUrl, options.resolver);
				// 打乱地址顺序: 重试时优先尝试不同 IP, 避免每次卡在同一个不可达地址
				for (let i = verifiedAddresses.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[verifiedAddresses[i], verifiedAddresses[j]] = [verifiedAddresses[j], verifiedAddresses[i]];
				}
			},
		});
		if (response.status < 300 || response.status >= 400) return { response, finalUrl: currentUrl };
		const location = response.headers.get("location");
		if (!location) throw new Error("HTTP " + response.status + " response did not include a redirect location");
		await response.body?.cancel();
		currentUrl = new URL(location, currentUrl);
		if (options.requireHttps && currentUrl.protocol !== "https:") {
			throw new Error("Request and redirect targets must use HTTPS");
		}
	}
	throw new Error("Too many redirects");
}

export async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error("Response is " + declaredLength + " bytes; limit is " + maxBytes + " bytes");
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("Response exceeded the " + maxBytes + "-byte limit");
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return Buffer.concat(chunks);
}

export function decodeEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
		if (code.startsWith("#")) {
			const point = Number.parseInt(
				code.startsWith("#x") ? code.slice(2) : code.slice(1),
				code.startsWith("#x") ? 16 : 10,
			);
			return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		}
		return named[code.toLowerCase()] ?? entity;
	});
}

export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
			.replace(/<(br|hr)\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|main|header|footer|li|tr|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function safeDownloadName(url: URL, fallback = "artifact.bin"): string {
	const raw = decodeURIComponent(basename(url.pathname) || fallback);
	const cleaned = raw
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 180);
	return cleaned || fallback;
}
