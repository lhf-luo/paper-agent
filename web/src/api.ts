const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const hashPdf = hash.get("pdf");

export function launchPdfPath(): string | undefined {
	return hashPdf || undefined;
}

/** 把浏览器 fetch 的网络错误转成更友好的中文提示。 */
export function friendlyNetworkError(reason: unknown): Error {
	if (reason instanceof Error) {
		const lower = reason.message.toLowerCase();
		if (
			lower.includes("failed to fetch") ||
			lower.includes("load failed") ||
			lower.includes("networkerror") ||
			lower.includes("network error") ||
			lower.includes("fetch failed") ||
			lower.includes("terminated") ||
			lower.includes("err_")
		) {
			return new Error("无法连接到本地服务，请确认服务已启动（或网络/代理连接断开）。");
		}
	}
	return reason instanceof Error ? reason : new Error(String(reason));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	let response: Response;
	try {
		response = await fetch(path, { ...init, headers });
	} catch (reason) {
		throw friendlyNetworkError(reason);
	}
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// Preserve the HTTP status when the response is not JSON.
		}
		throw new Error(message);
	}
	return (await response.json()) as T;
}

export async function apiBytes(path: string): Promise<Uint8Array> {
	const response = await fetch(path);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return new Uint8Array(await response.arrayBuffer());
}

export async function apiText(path: string): Promise<string> {
	let response: Response;
	try {
		response = await fetch(path);
	} catch (reason) {
		throw friendlyNetworkError(reason);
	}
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// Preserve the HTTP status when the response is not JSON.
		}
		throw new Error(message);
	}
	return await response.text();
}

export interface ApiServerSentEvent {
	event: string;
	data: unknown;
	id?: string;
}

export async function apiEventStream(
	path: string,
	onEvent: (event: ApiServerSentEvent) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	let response: Response;
	try {
		response = await fetch(path, {
			headers: { accept: "text/event-stream" },
			signal,
		});
	} catch (reason) {
		throw friendlyNetworkError(reason);
	}
	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// Preserve the HTTP status when the response is not JSON.
		}
		throw new Error(message);
	}
	if (!response.body) throw new Error("浏览器未提供流式响应体");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			let event = "message";
			let id: string | undefined;
			const data: string[] = [];
			for (const line of block.split("\n")) {
				if (!line || line.startsWith(":")) continue;
				const colon = line.indexOf(":");
				const field = colon >= 0 ? line.slice(0, colon) : line;
				const entry = colon >= 0 ? line.slice(colon + 1).replace(/^ /, "") : "";
				if (field === "event") event = entry;
				else if (field === "id") id = entry;
				else if (field === "data") data.push(entry);
			}
			if (data.length) {
				const raw = data.join("\n");
				let parsed: unknown = raw;
				try {
					parsed = JSON.parse(raw) as unknown;
				} catch {
					// Non-JSON data remains available as text.
				}
				await onEvent({ event, id, data: parsed });
			}
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
}

export function jsonBody(value: unknown, method: "POST" | "PATCH" = "POST"): RequestInit {
	return { method, body: JSON.stringify(value) };
}
