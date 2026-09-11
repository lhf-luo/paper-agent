import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { type Fetcher, fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";
import { normalizeArxivId, normalizeDoi } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { preparePdfImport } from "./literature-import-metadata.ts";
import type { LiteratureStore } from "./literature-store.ts";

export const CONNECTOR_MAX_PDF_BYTES = 100 * 1024 * 1024;

export interface CapturedPageMetadata {
	pageUrl?: string;
	pdfUrl?: string;
	title?: string;
	authors?: string[];
	doi?: string;
	arxivId?: string;
}

export interface CapturedPdfImportInput {
	metadata: CapturedPageMetadata;
	collection?: string;
	body?: Uint8Array;
	signal?: AbortSignal;
	fetcher?: Fetcher;
}

export class CapturedPdfDownloadError extends Error {}
export class CapturedPdfValidationError extends Error {}

function boundedText(value: string | undefined, maximum: number): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function normalizedMetadata(input: CapturedPageMetadata): CapturedPageMetadata {
	const pageUrl = boundedText(input.pageUrl, 32_768);
	const pdfUrl = boundedText(input.pdfUrl, 32_768);
	for (const [label, value] of [
		["pageUrl", pageUrl],
		["pdfUrl", pdfUrl],
	] as const) {
		if (!value) continue;
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			throw new CapturedPdfValidationError(`${label} must be an absolute URL`);
		}
		if (parsed.protocol !== "https:") throw new CapturedPdfValidationError(`${label} must use HTTPS`);
	}
	if (!pageUrl && !pdfUrl) throw new CapturedPdfValidationError("A captured page URL or PDF URL is required");
	const authors = (input.authors ?? []).map((author) => author.trim()).filter(Boolean);
	if (authors.length > 100 || authors.some((author) => author.length > 500)) {
		throw new CapturedPdfValidationError("Captured authors are invalid");
	}
	return {
		pageUrl,
		pdfUrl,
		title: boundedText(input.title, 2_000),
		authors: [...new Set(authors)],
		doi: normalizeDoi(input.doi),
		arxivId: normalizeArxivId(input.arxivId),
	};
}

function assertPdf(body: Uint8Array): void {
	if (body.byteLength < 5 || Buffer.from(body.subarray(0, 5)).toString("latin1") !== "%PDF-") {
		throw new CapturedPdfValidationError("Captured content does not have a PDF file signature");
	}
	if (body.byteLength > CONNECTOR_MAX_PDF_BYTES) {
		throw new CapturedPdfValidationError(`Captured PDF exceeds the ${CONNECTOR_MAX_PDF_BYTES}-byte limit`);
	}
}

async function downloadCapturedPdf(input: CapturedPdfImportInput, metadata: CapturedPageMetadata): Promise<Uint8Array> {
	if (input.body) {
		assertPdf(input.body);
		return input.body;
	}
	if (!metadata.pdfUrl) throw new CapturedPdfValidationError("A PDF URL or uploaded PDF body is required");
	try {
		const fetched = await fetchPublicUrl(new URL(metadata.pdfUrl), {
			signal: input.signal,
			fetcher: input.fetcher,
			requireHttps: true,
		});
		if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
		const body = await readResponseBody(fetched.response, CONNECTOR_MAX_PDF_BYTES);
		assertPdf(body);
		return body;
	} catch (error) {
		throw new CapturedPdfDownloadError(`Paper Agent could not download this PDF: ${readableErrorMessage(error)}`);
	}
}

function capturedRecord(record: PaperRecord, metadata: CapturedPageMetadata, sourceUrl: string): PaperRecord {
	const links = [...record.links];
	for (const link of [
		metadata.pageUrl ? { url: metadata.pageUrl, kind: "landing" as const } : undefined,
		metadata.pdfUrl ? { url: metadata.pdfUrl, kind: "pdf" as const } : undefined,
	]) {
		if (link && !links.some((existing) => existing.url === link.url)) links.push(link);
	}
	return {
		...record,
		links,
		provenance: record.provenance.map((entry) =>
			entry.provider === "local-pdf" ? { ...entry, query: "browser-connector", rawUrl: sourceUrl } : entry,
		),
	};
}

export async function importCapturedPdf(
	store: LiteratureStore,
	executor: CommandExecutor,
	projectRoot: string,
	input: CapturedPdfImportInput,
) {
	const metadata = normalizedMetadata(input.metadata);
	const collection = input.collection?.trim() || undefined;
	if (collection && collection.length > 500) {
		throw new CapturedPdfValidationError("Collection name must be at most 500 characters");
	}
	const body = await downloadCapturedPdf(input, metadata);
	const sourceUrl = metadata.pdfUrl ?? metadata.pageUrl!;
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "paper-agent-connector-"));
	const temporaryPdf = join(temporaryDirectory, "capture.pdf");
	try {
		await writeFile(temporaryPdf, body, { flag: "wx" });
		const prepared = await preparePdfImport(temporaryPdf, executor, projectRoot, input.signal, {
			hints: {
				doi: metadata.doi,
				arxivId: metadata.arxivId,
				urls: [metadata.pageUrl, metadata.pdfUrl].filter((value): value is string => Boolean(value)),
			},
		});
		if (!prepared.record) {
			const missing = prepared.needsMetadata?.missingFields.join(", ") ?? "title, authors";
			throw new CapturedPdfValidationError(`PDF requires manual metadata review: missing ${missing}`);
		}
		const record = capturedRecord(prepared.record, metadata, sourceUrl);
		const reportId = `connector-${randomUUID()}`;
		const report = {
			schemaVersion: 1,
			id: reportId,
			source: "browser-connector",
			sourceUrl,
			capturedAt: new Date().toISOString(),
			metadataSource: prepared.metadataSource,
			providerWarnings: prepared.warnings.filter((warning) => warning.stage === "provider"),
			sha256: createHash("sha256").update(body).digest("hex"),
		};
		const result = await store.importLocalPapersAtomically([{ record, sourcePath: temporaryPdf, sourceUrl, body }], {
			collectionName: collection,
			reportId,
			report,
		});
		return {
			...result,
			record: result.records[0],
			outcome: result.outcomes[0],
			metadataSource: prepared.metadataSource,
			providerWarnings: report.providerWarnings,
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
