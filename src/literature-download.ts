import type { LiteratureStore } from "./literature-store.ts";
import type { PaperRecord, PaperVersion } from "./literature-types.ts";
import { type AddressResolver, type Fetcher, fetchPublicUrl, readResponseBody } from "./network-security.ts";
import {
	authorizeOperationExecution,
	type OperationExecutionAuthorization,
	type OperationPlan,
} from "./operation-consent.ts";

export interface LiteraturePdfDownloadRequest {
	paperIds?: string[];
	maxFiles: number;
	maxBytesPerFile: number;
	concurrency: number;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

export interface LiteraturePdfDownloadResult {
	downloaded: PaperVersion[];
	failures: Array<{ paperId: string; reason: string }>;
	missingPaperIds: string[];
	corpusPath: string;
}

async function selectedRecords(store: LiteratureStore, request: LiteraturePdfDownloadRequest) {
	const requested = request.paperIds
		? await Promise.all(request.paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })))
		: undefined;
	const missingPaperIds = requested?.filter((item) => !item.record).map((item) => item.id) ?? [];
	const available = requested
		? requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record))
		: await store.listPapers();
	return { records: available.slice(0, request.maxFiles), missingPaperIds };
}

export async function literaturePdfDownloadPlan(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
): Promise<OperationPlan> {
	return buildLiteraturePdfDownloadPlan(store, request, await selectedRecords(store, request));
}

function buildLiteraturePdfDownloadPlan(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
	selection: Awaited<ReturnType<typeof selectedRecords>>,
): OperationPlan {
	const { records, missingPaperIds } = selection;
	const pdfTargets = records.flatMap((record) => {
		const pdfLink = record.links.find((link) => link.kind === "pdf");
		return pdfLink ? [{ label: `pdf:${record.id}`, value: pdfLink.url, risk: "medium" as const }] : [];
	});
	return {
		kind: "pdf-download",
		summary: `Download up to ${request.maxFiles} PDFs into the personal corpus`,
		targets: [{ label: "corpus", value: store.root, risk: "medium" }, ...pdfTargets],
		details: {
			paperIds: records.map((record) => record.id),
			missingPaperIds,
			maxFiles: request.maxFiles,
			maxBytesPerFile: request.maxBytesPerFile,
			concurrency: request.concurrency,
			corpusPath: store.root,
		},
	};
}

export async function downloadLiteraturePdfs(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
	authorization: OperationExecutionAuthorization,
): Promise<LiteraturePdfDownloadResult> {
	if (!Number.isInteger(request.maxFiles) || request.maxFiles < 1 || request.maxFiles > 100) {
		throw new Error("maxFiles must be an integer between 1 and 100");
	}
	if (!Number.isInteger(request.maxBytesPerFile) || request.maxBytesPerFile < 1) {
		throw new Error("maxBytesPerFile must be a positive integer");
	}
	if (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 5) {
		throw new Error("concurrency must be an integer between 1 and 5");
	}
	const selection = await selectedRecords(store, request);
	await authorizeOperationExecution(authorization, buildLiteraturePdfDownloadPlan(store, request, selection));
	await store.initialize();
	const { records, missingPaperIds } = selection;
	const downloaded: PaperVersion[] = [];
	const failures: Array<{ paperId: string; reason: string }> = missingPaperIds.map((paperId) => ({
		paperId,
		reason: "paper id was not found in the corpus",
	}));
	let nextRecord = 0;
	const downloadOne = async (record: PaperRecord) => {
		const pdfLink = record.links.find((link) => link.kind === "pdf");
		if (!pdfLink) {
			failures.push({ paperId: record.id, reason: "no PDF link in provider metadata" });
			return;
		}
		try {
			const fetched = await fetchPublicUrl(new URL(pdfLink.url), {
				signal: request.signal,
				fetcher: request.fetcher,
				resolver: request.resolver,
			});
			if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
			const body = await readResponseBody(fetched.response, request.maxBytesPerFile);
			const contentType = fetched.response.headers.get("content-type") ?? "application/octet-stream";
			if (!contentType.toLowerCase().includes("pdf") && body.subarray(0, 5).toString() !== "%PDF-") {
				throw new Error("response is not a PDF");
			}
			const blob = await store.putBlob(body);
			const version: PaperVersion = {
				paperId: record.id,
				sourceUrl: pdfLink.url,
				finalUrl: fetched.finalUrl.href,
				retrievedAt: new Date().toISOString(),
				sha256: blob.sha256,
				bytes: body.length,
				blobPath: blob.path,
				contentType,
			};
			await store.savePaperVersion(version);
			downloaded.push(version);
		} catch (error) {
			failures.push({ paperId: record.id, reason: error instanceof Error ? error.message : String(error) });
		}
	};
	const worker = async () => {
		while (nextRecord < records.length) {
			const record = records[nextRecord++];
			if (record) await downloadOne(record);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(request.concurrency, Math.max(1, records.length)) }, () => worker()),
	);
	downloaded.sort((left, right) => left.paperId.localeCompare(right.paperId));
	failures.sort((left, right) => left.paperId.localeCompare(right.paperId));
	return { downloaded, failures, missingPaperIds, corpusPath: store.root };
}
