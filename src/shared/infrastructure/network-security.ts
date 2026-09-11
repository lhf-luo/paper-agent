import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

import { type AddressResolver, assertPublicUrl } from "./network-address.ts";
import { getConfiguredProxy, getProxyAgent, shouldBypassProxy } from "./network-proxy-config.ts";

export function proxyRequestPath(target: URL): string {
	return `${target.pathname || "/"}${target.search}`;
}

function proxyTarget(
	target: URL,
	options: { method: string; headers: Record<string, string>; signal?: AbortSignal },
	handler: (response: IncomingMessage) => void,
): Promise<ClientRequest> {
	const proxy = getConfiguredProxy();
	if (!proxy) throw new Error("Proxy is not configured");
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
				if (head?.length) socket.unshift(head);
				const secured = httpsRequest(
					{
						host: target.hostname,
						servername: target.hostname,
						socket,
						path: proxyRequestPath(target),
						method: options.method,
						headers: { ...options.headers, Host: target.host },
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
		const onTimeout = () => socket.destroy(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
		socket.setTimeout(CONNECT_TIMEOUT_MS);
		socket.once("timeout", onTimeout);
		outgoing.once("close", () => {
			socket.off("timeout", onTimeout);
			if (!socket.destroyed) socket.setTimeout(0);
		});
	});
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
		if (getConfiguredProxy()) {
			void proxyTarget(url, requestOptions, onIncoming).then((outgoing) => {
				outgoing.once("error", reject);
				outgoing.end();
			}, reject);
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

/**
 * 默认 fetcher: 配置了代理且目标不在直连白名单时走代理, 否则直连。
 * 供 provider 等通用 HTTP 请求使用(区别于 fetchPublicUrl 的 IP 固定请求)。
 */
export function defaultFetcher(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const target = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
	const proxyAgent = getProxyAgent();
	if (proxyAgent && !shouldBypassProxy(target)) {
		const undiciInit = { ...init, dispatcher: proxyAgent } as unknown as RequestInit;
		return fetch(target, undiciInit);
	}
	return fetch(target, init);
}

export async function fetchWithTimeout(
	url: URL,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	init: RequestInit = {},
	fetcher: Fetcher = defaultFetcher,
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
	const maxRetries = options.maxRetries ?? 1;
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
	// 跟随重定向的公共逻辑。fetcherFor 返回当前循环用的 fetcher,
	// 以便 IP 固定通道能共享 verifiedAddresses(在 beforeAttempt 中填充)。
	const follow = async (
		fetcherFor: (getAddresses: () => string[]) => Fetcher,
		options2: { verify?: boolean } = {},
	): Promise<{ response: Response; finalUrl: URL }> => {
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
				fetcher: fetcherFor(() => verifiedAddresses),
				maxRetries: options.maxRetries,
				baseDelayMs: options.baseDelayMs,
				beforeAttempt: async () => {
					if (options2.verify === false) return;
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
			if (!location) throw new Error(`HTTP ${response.status} response did not include a redirect location`);
			await response.body?.cancel();
			currentUrl = new URL(location, currentUrl);
			if (options.requireHttps && currentUrl.protocol !== "https:") {
				throw new Error("Request and redirect targets must use HTTPS");
			}
		}
		throw new Error("Too many redirects");
	};

	const pinnedFetcher =
		(getAddresses: () => string[]): Fetcher =>
		(input, init) =>
			fetchPinnedUrl(
				input instanceof URL ? input : new URL(input instanceof Request ? input.url : input),
				init ?? {},
				getAddresses(),
			);
	try {
		// 显式传了 fetcher 就按调用方意图走, 不回退。
		if (options.fetcher) return await follow(() => options.fetcher as Fetcher);
		// 先用 IP 固定通道(保留安全校验), 某些站点(如 ieeexplore.ieee.org)会返回重定向挑战循环。
		return await follow(pinnedFetcher);
	} catch (pinnedError) {
		if (!options.fetcher && pinnedError instanceof Error && /too many redirects/i.test(pinnedError.message)) {
			// IEEE 等站点对 IP 固定/隧道返回重定向挑战: 回退到 undici 代理/直连通道(跳过 IP 固定校验)。
			return await follow(() => defaultFetcher, { verify: false });
		}
		throw pinnedError;
	}
}
