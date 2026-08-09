let sessionToken = sessionStorage.getItem("paper-agent-session-token") ?? "";
const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const hashToken = hash.get("token");
const hashPdf = hash.get("pdf");
if (hashToken) {
	sessionToken = hashToken;
	sessionStorage.setItem("paper-agent-session-token", hashToken);
	history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

export function launchPdfPath(): string | undefined {
	return hashPdf || undefined;
}

export function hasSessionToken(): boolean {
	return Boolean(sessionToken);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${sessionToken}`);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	const response = await fetch(path, { ...init, headers });
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
	const response = await fetch(path, { headers: { authorization: `Bearer ${sessionToken}` } });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return new Uint8Array(await response.arrayBuffer());
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
	const response = await fetch(path, {
		headers: { authorization: `Bearer ${sessionToken}`, accept: "text/event-stream" },
		signal,
	});
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

export function jsonBody(value: unknown): RequestInit {
	return { method: "POST", body: JSON.stringify(value) };
}
