import type { LiteratureStore } from "./literature-store.ts";
import type { PaperRecord, PaperVersion } from "./literature-types.ts";
import { type AddressResolver, type Fetcher, downloadViaPython, fetchPublicUrl, readResponseBody, readableErrorMessage } from "./network-security.ts";
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
		const pdfUrl = new URL(pdfLink.url);
		const isArxivHost =
			pdfUrl.hostname === "arxiv.org" ||
			pdfUrl.hostname.endsWith(".arxiv.org") ||
			pdfUrl.hostname === "export.arxiv.org" ||
			pdfUrl.hostname.endsWith(".export.arxiv.org");
		// 部分历史记录/源会给 http 链接; arXiv 的 80 端口常被网络阻断(443 正常), 强制用 https
		if (isArxivHost && pdfUrl.protocol === "http:") pdfUrl.protocol = "https:";
		try {
			let body: Uint8Array;
			let contentType = "application/pdf";
			let finalUrl = pdfUrl.href;
			if (isArxivHost) {
				// arXiv 对 Node 的 TLS 指纹返回反爬挑战页, 改用 Python 标准库下载(指纹与 curl 类似)。
				try {
					body = await downloadViaPython(pdfUrl, {
						timeoutMs: 60_000,
						maxBytes: request.maxBytesPerFile,
					});
				} catch (_pythonError) {
					// Python 不可用或失败时回退到 Node 通道。
					const fetched = await fetchPublicUrl(pdfUrl, {
						signal: request.signal,
						fetcher: request.fetcher,
						resolver: request.resolver,
					});
					if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
					body = await readResponseBody(fetched.response, request.maxBytesPerFile);
					contentType = fetched.response.headers.get("content-type") ?? "application/octet-stream";
					finalUrl = fetched.finalUrl.href;
				}
			} else {
				const fetched = await fetchPublicUrl(pdfUrl, {
					signal: request.signal,
					fetcher: request.fetcher,
					resolver: request.resolver,
				});
				if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
				body = await readResponseBody(fetched.response, request.maxBytesPerFile);
				contentType = fetched.response.headers.get("content-type") ?? "application/octet-stream";
				finalUrl = fetched.finalUrl.href;
			}
			if (!contentType.toLowerCase().includes("pdf") && body.subarray(0, 5).toString() !== "%PDF-") {
				throw new Error("response is not a PDF");
			}
			const blob = await store.putBlob(body);
			const version: PaperVersion = {
				paperId: record.id,
				sourceUrl: pdfLink.url,
				finalUrl,
				retrievedAt: new Date().toISOString(),
				sha256: blob.sha256,
				bytes: body.length,
				blobPath: blob.path,
				contentType,
			};
			await store.savePaperVersion(version);
			downloaded.push(version);
		} catch (error) {
			failures.push({ paperId: record.id, reason: readableErrorMessage(error) });
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
