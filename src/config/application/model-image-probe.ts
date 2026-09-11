import { deflateSync } from "node:zlib";
import {
	type ModelProbeResult,
	type PaperAgentModelConfig,
	supportsAutomaticToolCallingProbe,
} from "../domain/config-types.ts";

function endpoint(baseUrl: string, suffix: string): string {
	return `${baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function crc32(value: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of value) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array): Buffer {
	const type = Buffer.from(name, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
	return Buffer.concat([length, type, data, checksum]);
}

function colorProbe(modelId: string): { dataUrl: string; answer: string } {
	const colors = [
		{ name: "RED", rgb: [230, 35, 45] },
		{ name: "GREEN", rgb: [25, 180, 80] },
		{ name: "BLUE", rgb: [35, 90, 225] },
	] as const;
	let seed = [...modelId].reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 5381);
	const sequence = Array.from({ length: 4 }, () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return colors[seed % colors.length];
	});
	const width = 128;
	const height = 32;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * (width * 3 + 1);
		for (let x = 0; x < width; x += 1) {
			const color = sequence[Math.floor(x / (width / sequence.length))];
			raw.set(color.rgb, row + 1 + x * 3);
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const png = Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return {
		dataUrl: `data:image/png;base64,${png.toString("base64")}`,
		answer: sequence.map((color) => color.name).join(" "),
	};
}

function imageProbeOutput(body: any, responsesApi: boolean): string {
	if (!responsesApi) {
		const content = body?.choices?.[0]?.message?.content;
		if (typeof content === "string" && content.trim()) return content;
		const reasoning = body?.choices?.[0]?.message?.reasoning_content;
		return typeof reasoning === "string" ? reasoning : "";
	}
	if (typeof body?.output_text === "string") return body.output_text;
	return (body?.output ?? [])
		.flatMap((entry: any) => entry?.content ?? [])
		.map((entry: any) => entry?.text ?? entry?.output_text ?? "")
		.join(" ");
}

function failure(reason: string, started: number, checkedAt: string, status?: number): ModelProbeResult {
	return { supported: false, reason, latencyMs: Date.now() - started, checkedAt, ...(status ? { status } : {}) };
}

export async function probeModelImageInput(
	model: PaperAgentModelConfig,
	timeoutMs = 30_000,
	fetcher: typeof fetch = fetch,
): Promise<ModelProbeResult> {
	const checkedAt = new Date().toISOString();
	const started = Date.now();
	const apiKey =
		model.apiKey ?? (model.apiKeyEnvironmentVariable ? process.env[model.apiKeyEnvironmentVariable] : undefined);
	if (!apiKey) return failure("No API key configured", started, checkedAt);
	if (!supportsAutomaticToolCallingProbe(model.api))
		return failure(`Image probing is not implemented for ${model.api}`, started, checkedAt);
	const responsesApi = model.api === "openai-responses";
	const challenge = colorProbe(model.modelId);
	const prompt =
		"Read the four vertical color bands from left to right. Reply with exactly four words chosen from RED, GREEN, BLUE.";
	const content = responsesApi
		? [
				{ type: "input_text", text: prompt },
				{ type: "input_image", image_url: challenge.dataUrl },
			]
		: [
				{ type: "text", text: prompt },
				{ type: "image_url", image_url: { url: challenge.dataUrl, detail: "low" } },
			];
	const probeMaxTokens = model.reasoning ? 8192 : 512;
	const body = responsesApi
		? { model: model.modelId, input: [{ role: "user", content }], max_output_tokens: probeMaxTokens }
		: { model: model.modelId, messages: [{ role: "user", content }], max_tokens: probeMaxTokens };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(endpoint(model.baseUrl, responsesApi ? "responses" : "chat/completions"), {
			method: "POST",
			headers: { ...model.headers, authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const raw = await response.text();
		if (!response.ok)
			return failure(
				`Provider returned HTTP ${response.status}: ${raw.slice(0, 300)}`,
				started,
				checkedAt,
				response.status,
			);
		const output = imageProbeOutput(JSON.parse(raw), responsesApi)
			.toUpperCase()
			.replace(/[^A-Z]+/g, " ")
			.trim();
		const supported = output === challenge.answer;
		return {
			supported,
			reason: supported
				? "The model read the image challenge correctly"
				: `Unexpected image answer: ${output || "(empty)"}`,
			latencyMs: Date.now() - started,
			checkedAt,
			status: response.status,
		};
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "AbortError"
				? "Image capability probe timed out"
				: error instanceof Error
					? error.message
					: String(error);
		return failure(reason, started, checkedAt);
	} finally {
		clearTimeout(timer);
	}
}
