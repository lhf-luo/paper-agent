import { basename } from "node:path";

export async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`Response is ${declaredLength} bytes; limit is ${maxBytes} bytes`);
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
			throw new Error(`Response exceeded the ${maxBytes}-byte limit`);
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
