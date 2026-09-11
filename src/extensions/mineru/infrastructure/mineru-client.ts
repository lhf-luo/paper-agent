import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { defaultFetcher, fetchWithTimeout } from "../../../shared/infrastructure/network-security.ts";
import type { MineruConfiguration, MineruJobCheckpoint } from "../domain/mineru-types.ts";

interface MineruEnvelope<T> {
	code?: number;
	msg?: string;
	data?: T;
}

interface BatchResult {
	file_name?: string;
	state?: string;
	err_msg?: string;
	full_zip_url?: string;
	data_id?: string;
	extract_progress?: { extracted_pages?: number; total_pages?: number };
}

async function jsonRequest<T>(url: URL, init: RequestInit, signal: AbortSignal): Promise<T> {
	const response = await fetchWithTimeout(url, signal, 30_000, init, defaultFetcher);
	const text = await response.text();
	let payload: MineruEnvelope<T>;
	try {
		payload = JSON.parse(text) as MineruEnvelope<T>;
	} catch {
		throw new Error(`MinerU returned invalid JSON (HTTP ${response.status})`);
	}
	if (!response.ok || payload.code !== 0 || !payload.data) {
		throw new Error(`MinerU request failed (HTTP ${response.status}): ${payload.msg ?? "unknown error"}`);
	}
	return payload.data;
}

export async function submitMineruFile(
	configuration: MineruConfiguration,
	input: { filename: string; body: Buffer; dataId: string },
	signal: AbortSignal,
): Promise<MineruJobCheckpoint> {
	const requested = await jsonRequest<{ batch_id?: string; file_urls?: string[] }>(
		new URL(`${configuration.baseUrl}/file-urls/batch`),
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${configuration.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				files: [{ name: input.filename, data_id: input.dataId, is_ocr: true }],
				model_version: configuration.modelVersion,
				language: configuration.language,
				enable_formula: true,
				enable_table: true,
			}),
		},
		signal,
	);
	if (!requested.batch_id || requested.file_urls?.length !== 1) {
		throw new Error("MinerU did not return one signed upload URL");
	}
	const uploadUrl = new URL(requested.file_urls[0]);
	if (uploadUrl.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(uploadUrl.hostname)) {
		throw new Error("MinerU signed upload URL must use HTTPS");
	}
	const uploaded = await fetchWithTimeout(
		uploadUrl,
		signal,
		10 * 60_000,
		{ method: "PUT", body: new Uint8Array(input.body) },
		defaultFetcher,
	);
	if (!uploaded.ok) {
		await uploaded.body?.cancel();
		throw new Error(`MinerU signed upload failed with HTTP ${uploaded.status}`);
	}
	await uploaded.body?.cancel();
	return { batchId: requested.batch_id, dataId: input.dataId, sourceSha256: input.dataId.replace(/^paper-/, "") };
}

export async function waitForMineruResult(
	configuration: MineruConfiguration,
	checkpoint: MineruJobCheckpoint,
	signal: AbortSignal,
	report: (progress: number, message: string) => void,
): Promise<string> {
	const deadline = Date.now() + 60 * 60_000;
	while (Date.now() < deadline) {
		const data = await jsonRequest<{ extract_result?: BatchResult[] }>(
			new URL(`${configuration.baseUrl}/extract-results/batch/${encodeURIComponent(checkpoint.batchId)}`),
			{ method: "GET", headers: { Authorization: `Bearer ${configuration.apiKey}` } },
			signal,
		);
		const result =
			data.extract_result?.find((entry) => entry.data_id === checkpoint.dataId) ?? data.extract_result?.[0];
		if (!result) throw new Error("MinerU batch result did not contain the uploaded PDF");
		if (result.state === "done" && result.full_zip_url) return result.full_zip_url;
		if (result.state === "failed") throw new Error(`MinerU extraction failed: ${result.err_msg || "unknown error"}`);
		const extracted = result.extract_progress?.extracted_pages;
		const total = result.extract_progress?.total_pages;
		const ratio = extracted && total ? Math.min(extracted / total, 1) : 0;
		report(
			0.3 + ratio * 0.45,
			total ? `MinerU parsing ${extracted ?? 0}/${total} pages` : `MinerU ${result.state ?? "pending"}`,
		);
		await delay(5_000, undefined, { signal });
	}
	throw new Error("MinerU extraction did not finish within 60 minutes");
}

export async function downloadMineruZip(
	url: string,
	destination: string,
	signal: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
	const { createHash } = await import("node:crypto");
	const packageUrl = new URL(url);
	if (packageUrl.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(packageUrl.hostname)) {
		throw new Error("MinerU package URL must use HTTPS");
	}
	const response = await fetchWithTimeout(packageUrl, signal, 10 * 60_000, { method: "GET" }, defaultFetcher);
	if (!response.ok || !response.body) throw new Error(`MinerU package download failed with HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length"));
	const limit = 500 * 1024 * 1024;
	if (Number.isFinite(declared) && declared > limit) throw new Error("MinerU package exceeds the 500 MB limit");
	const file = await open(destination, "wx");
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > limit) throw new Error("MinerU package exceeds the 500 MB limit");
			hash.update(chunk.value);
			await file.write(chunk.value);
		}
	} finally {
		await file.close();
	}
	return { bytes, sha256: hash.digest("hex") };
}
