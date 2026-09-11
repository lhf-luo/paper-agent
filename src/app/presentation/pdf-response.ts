import type { IncomingMessage, ServerResponse } from "node:http";

interface PdfResponseOptions {
	request: IncomingMessage;
	response: ServerResponse;
	body: Buffer;
	filename: string;
	etag: string;
}

interface ByteRange {
	start: number;
	end: number;
}

function asciiFilename(filename: string): string {
	const cleaned = filename.replace(/[\r\n"\\/]/g, "_").trim();
	const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_");
	return ascii || "paper.pdf";
}

function contentDisposition(filename: string): string {
	const normalized = filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
	return `inline; filename="${asciiFilename(normalized)}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
}

export function parseSingleByteRange(value: string | undefined, total: number): ByteRange | undefined {
	if (!value) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match || (!match[1] && !match[2]) || total <= 0) throw new RangeError("Invalid byte range");
	if (!match[1]) {
		const suffixLength = Number(match[2]);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeError("Invalid byte range");
		return { start: Math.max(0, total - suffixLength), end: total - 1 };
	}
	const start = Number(match[1]);
	const requestedEnd = match[2] ? Number(match[2]) : total - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 0 ||
		start >= total ||
		requestedEnd < start
	) {
		throw new RangeError("Invalid byte range");
	}
	return { start, end: Math.min(requestedEnd, total - 1) };
}

export function sendPdfResponse(options: PdfResponseOptions): void {
	const { request, response, body, filename } = options;
	const etag = `"${options.etag.replace(/^"|"$/g, "")}"`;
	const commonHeaders = {
		"content-type": "application/pdf",
		"content-disposition": contentDisposition(filename),
		"accept-ranges": "bytes",
		etag,
		"cache-control": "private, max-age=0, must-revalidate",
		"x-content-type-options": "nosniff",
	};
	let range: ByteRange | undefined;
	try {
		range = parseSingleByteRange(typeof request.headers.range === "string" ? request.headers.range : undefined, body.length);
	} catch {
		response.writeHead(416, { ...commonHeaders, "content-range": `bytes */${body.length}`, "content-length": "0" });
		response.end();
		return;
	}
	if (!range) {
		response.writeHead(200, { ...commonHeaders, "content-length": String(body.length) });
		response.end(request.method === "HEAD" ? undefined : body);
		return;
	}
	const chunk = body.subarray(range.start, range.end + 1);
	response.writeHead(206, {
		...commonHeaders,
		"content-range": `bytes ${range.start}-${range.end}/${body.length}`,
		"content-length": String(chunk.length),
	});
	response.end(request.method === "HEAD" ? undefined : chunk);
}
