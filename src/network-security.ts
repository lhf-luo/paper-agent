import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export const DEFAULT_USER_AGENT = "pi-paper-agent/0.2 (academic research assistant)";

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
		const outgoing = request(
			url,
			{
				method: init.method ?? "GET",
				headers: headerRecord,
				lookup: lookupPinned as never,
				signal: init.signal ?? undefined,
			},
			(incoming) => {
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
			},
		);
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
			timeoutMs: options.timeoutMs ?? 30_000,
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
