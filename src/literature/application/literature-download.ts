import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import {
	authorizeOperationExecution,
	type OperationExecutionAuthorization,
	type OperationPlan,
} from "../../shared/application/operation-consent.ts";
import type { AddressResolver } from "../../shared/infrastructure/network-address.ts";
import { readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { type Fetcher, fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";
import { downloadViaPython } from "../../shared/infrastructure/python-download.ts";
import { normalizeArxivId, normalizeDoi, paperPdfUrl, uniquePaperLinks } from "../domain/literature-identifiers.ts";
import type { PaperRecord, PaperVersion } from "../domain/literature-types.ts";
import {
	discoverDoiPdfCandidates,
	type PdfDiscoveryCredentials,
	type PdfDiscoveryWarning,
	type ProviderPdfCandidateSource,
} from "../infrastructure/pdf-download-discovery.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface LiteraturePdfDownloadRequest {
	paperIds?: string[];
	maxFiles: number;
	maxBytesPerFile: number;
	concurrency: number;
	projectRoot?: string;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

export type PdfDownloadCandidateSource =
	| "record-primary"
	| "record-arxiv"
	| "record-alternative"
	| ProviderPdfCandidateSource;

export interface PdfDownloadCandidate {
	url: string;
	source: PdfDownloadCandidateSource;
	versionKind: "published" | "preprint" | "unknown";
}

export interface LiteraturePdfDownloadAttempt extends PdfDownloadCandidate {
	paperId: string;
	status: "succeeded" | "failed" | "skipped";
	reason?: string;
}

export interface LiteraturePdfDiscoveryWarning extends PdfDiscoveryWarning {
	paperId: string;
}

export interface PreparedLiteraturePdfDownload {
	plan: OperationPlan;
	papers: Array<{ record: PaperRecord; candidates: PdfDownloadCandidate[] }>;
	missingPaperIds: string[];
	discoveryWarnings: LiteraturePdfDiscoveryWarning[];
}

export interface LiteraturePdfDownloadResult {
	downloaded: PaperVersion[];
	failures: Array<{ paperId: string; reason: string }>;
	missingPaperIds: string[];
	attempts: LiteraturePdfDownloadAttempt[];
	discoveryWarnings: LiteraturePdfDiscoveryWarning[];
	corpusPath: string;
}

function isArxivUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return host === "arxiv.org" || host.endsWith(".arxiv.org") || host === "export.arxiv.org";
}

function normalizedPdfUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		if (isArxivUrl(url) && url.protocol === "http:") url.protocol = "https:";
		if (url.protocol !== "https:") return undefined;
		url.hash = "";
		return url;
	} catch {
		return undefined;
	}
}

function uniqueCandidates(candidates: PdfDownloadCandidate[]): PdfDownloadCandidate[] {
	const seen = new Set<string>();
	return candidates.flatMap((candidate) => {
		const url = normalizedPdfUrl(candidate.url);
		if (!url || seen.has(url.href)) return [];
		seen.add(url.href);
		return [{ ...candidate, url: url.href }];
	});
}

function recordPdfCandidates(record: PaperRecord): {
	primary: PdfDownloadCandidate[];
	arxiv: PdfDownloadCandidate[];
	alternatives: PdfDownloadCandidate[];
	warnings: LiteraturePdfDiscoveryWarning[];
} {
	const warnings: LiteraturePdfDiscoveryWarning[] = [];
	const validLinks = record.links.flatMap((link) => {
		const detected = paperPdfUrl(link);
		if (!detected) return [];
		const url = normalizedPdfUrl(detected);
		if (!url) {
			warnings.push({
				paperId: record.id,
				provider: "record",
				reason: `Rejected non-HTTPS or invalid PDF URL: ${link.url}`,
			});
			return [];
		}
		return [url];
	});
	const primaryUrl = validLinks[0];
	const primary: PdfDownloadCandidate[] = primaryUrl
		? [
				{
					url: primaryUrl.href,
					source: "record-primary",
					versionKind: isArxivUrl(primaryUrl) ? "preprint" : "unknown",
				},
			]
		: [];
	const arxiv = validLinks
		.slice(1)
		.flatMap((url): PdfDownloadCandidate[] =>
			isArxivUrl(url) ? [{ url: url.href, source: "record-arxiv", versionKind: "preprint" }] : [],
		);
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) {
		arxiv.push({
			url: `https://arxiv.org/pdf/${arxivId}.pdf`,
			source: "record-arxiv",
			versionKind: "preprint",
		});
	}
	const alternatives = validLinks
		.slice(1)
		.flatMap((url): PdfDownloadCandidate[] =>
			isArxivUrl(url) ? [] : [{ url: url.href, source: "record-alternative", versionKind: "unknown" }],
		);
	return { primary, arxiv, alternatives, warnings };
}

async function configuredDiscoveryCredentials(projectRoot: string): Promise<{
	credentials: PdfDiscoveryCredentials;
	warning?: string;
}> {
	try {
		const config = await loadPaperAgentConfig(projectRoot);
		return {
			credentials: {
				unpaywallEmail: config.credentials?.unpaywallEmail,
				semanticScholarApiKey: config.credentials?.semanticScholarApiKey,
				openAlexMailto: config.credentials?.openAlexMailto,
			},
		};
	} catch (error) {
		return { credentials: {}, warning: `Unable to load provider credentials: ${readableErrorMessage(error)}` };
	}
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

async function discoverPaperCandidates(
	record: PaperRecord,
	request: LiteraturePdfDownloadRequest,
	credentials: PdfDiscoveryCredentials,
	configWarning?: string,
): Promise<{ record: PaperRecord; candidates: PdfDownloadCandidate[]; warnings: LiteraturePdfDiscoveryWarning[] }> {
	const stored = recordPdfCandidates(record);
	const warnings = [...stored.warnings];
	if (configWarning) warnings.push({ paperId: record.id, provider: "record", reason: configWarning });
	const storedCandidates = [...stored.primary, ...stored.arxiv, ...stored.alternatives];
	const discovered =
		storedCandidates.length === 0 && record.identifiers.doi
			? await discoverDoiPdfCandidates({
					doi: record.identifiers.doi,
					credentials,
					signal: request.signal,
					fetcher: request.fetcher,
					resolver: request.resolver,
				})
			: { candidates: [], warnings: [] };
	warnings.push(...discovered.warnings.map((warning) => ({ ...warning, paperId: record.id })));
	return {
		record,
		candidates: uniqueCandidates([
			...stored.primary,
			...stored.arxiv,
			...discovered.candidates.filter((candidate) => candidate.versionKind === "preprint"),
			...stored.alternatives,
			...discovered.candidates.filter((candidate) => candidate.versionKind !== "preprint"),
		]),
		warnings,
	};
}

function hasDeferredDoiFallback(record: PaperRecord, candidates: PdfDownloadCandidate[]): boolean {
	return Boolean(
		normalizeDoi(record.identifiers.doi) &&
			candidates.length > 0 &&
			candidates.every((candidate) => candidate.source.startsWith("record-")),
	);
}

function buildLiteraturePdfDownloadPlan(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
	prepared: Omit<PreparedLiteraturePdfDownload, "plan">,
): OperationPlan {
	const candidateTargets = prepared.papers.flatMap(({ record, candidates }) =>
		candidates.map((candidate, index) => {
			const doi = normalizeDoi(record.identifiers.doi);
			const identifier = doi
				? `DOI ${doi}`
				: record.identifiers.arxivId
					? `arXiv ${record.identifiers.arxivId}`
					: record.id;
			return {
				label: `${record.title} | ${identifier} | candidate ${index + 1} (${candidate.source})`,
				value: candidate.url,
				risk: "medium" as const,
			};
		}),
	);
	const fallbackTargets = prepared.papers.flatMap(({ record, candidates }) => {
		const doi = normalizeDoi(record.identifiers.doi);
		return doi && hasDeferredDoiFallback(record, candidates)
			? [
					{
						label: `${record.title} | DOI fallback if saved links fail`,
						value: `https://doi.org/${doi}`,
						risk: "medium" as const,
					},
				]
			: [];
	});
	return {
		kind: "pdf-download",
		summary: `Download PDFs for ${prepared.papers.length} selected papers from ${candidateTargets.length} known candidates${fallbackTargets.length ? ` with ${fallbackTargets.length} conditional DOI fallbacks` : ""}`,
		targets: [{ label: "corpus", value: store.root, risk: "medium" }, ...candidateTargets, ...fallbackTargets],
		details: {
			requestedPaperIds: request.paperIds ?? null,
			paperIds: prepared.papers.map(({ record }) => record.id),
			missingPaperIds: prepared.missingPaperIds,
			candidateCount: candidateTargets.length,
			deferredDoiFallbackCount: fallbackTargets.length,
			candidateSources: [
				...new Set(prepared.papers.flatMap(({ candidates }) => candidates.map(({ source }) => source))),
			],
			discoveryWarningCount: prepared.discoveryWarnings.length,
			maxFiles: request.maxFiles,
			maxBytesPerFile: request.maxBytesPerFile,
			concurrency: request.concurrency,
			corpusPath: store.root,
		},
	};
}

export async function prepareLiteraturePdfDownload(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
): Promise<PreparedLiteraturePdfDownload> {
	const selection = await selectedRecords(store, request);
	const configured = await configuredDiscoveryCredentials(request.projectRoot ?? process.cwd());
	const papers: PreparedLiteraturePdfDownload["papers"] = [];
	const discoveryWarnings: LiteraturePdfDiscoveryWarning[] = [];
	let nextRecord = 0;
	const worker = async () => {
		while (nextRecord < selection.records.length) {
			const record = selection.records[nextRecord++];
			if (!record) continue;
			const result = await discoverPaperCandidates(record, request, configured.credentials, configured.warning);
			papers.push({ record: result.record, candidates: result.candidates });
			discoveryWarnings.push(...result.warnings);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(request.concurrency, Math.max(1, selection.records.length)) }, () => worker()),
	);
	papers.sort((left, right) => selection.records.indexOf(left.record) - selection.records.indexOf(right.record));
	const preparedWithoutPlan = { papers, missingPaperIds: selection.missingPaperIds, discoveryWarnings };
	return {
		...preparedWithoutPlan,
		plan: buildLiteraturePdfDownloadPlan(store, request, preparedWithoutPlan),
	};
}

async function downloadCandidate(
	candidate: PdfDownloadCandidate,
	request: LiteraturePdfDownloadRequest,
): Promise<{ body: Uint8Array; contentType: string; finalUrl: string }> {
	const pdfUrl = new URL(candidate.url);
	let body: Uint8Array;
	let contentType = "application/pdf";
	let finalUrl = pdfUrl.href;
	if (isArxivUrl(pdfUrl) && !request.fetcher) {
		try {
			body = await downloadViaPython(pdfUrl, { timeoutMs: 60_000, maxBytes: request.maxBytesPerFile });
		} catch {
			const fetched = await fetchPublicUrl(pdfUrl, {
				signal: request.signal,
				resolver: request.resolver,
				requireHttps: true,
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
			requireHttps: true,
		});
		if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
		body = await readResponseBody(fetched.response, request.maxBytesPerFile);
		contentType = fetched.response.headers.get("content-type") ?? "application/octet-stream";
		finalUrl = fetched.finalUrl.href;
	}
	const magicPdf = String.fromCharCode(...body.slice(0, 5)) === "%PDF-";
	if (!magicPdf) throw new Error("response does not have a PDF file signature");
	return { body, contentType, finalUrl };
}

export async function downloadLiteraturePdfs(
	store: LiteratureStore,
	request: LiteraturePdfDownloadRequest,
	prepared: PreparedLiteraturePdfDownload,
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
	await authorizeOperationExecution(
		authorization,
		buildLiteraturePdfDownloadPlan(store, request, {
			papers: prepared.papers,
			missingPaperIds: prepared.missingPaperIds,
			discoveryWarnings: prepared.discoveryWarnings,
		}),
	);
	await store.initialize();
	const downloaded: PaperVersion[] = [];
	const attempts: LiteraturePdfDownloadAttempt[] = [];
	const discoveryWarnings = [...prepared.discoveryWarnings];
	const failures: Array<{ paperId: string; reason: string }> = prepared.missingPaperIds.map((paperId) => ({
		paperId,
		reason: "paper id was not found in the corpus",
	}));
	let nextPaper = 0;
	let deferredCredentials: ReturnType<typeof configuredDiscoveryCredentials> | undefined;
	const discoverDeferredFallback = async (record: PaperRecord, tried: PdfDownloadCandidate[]) => {
		deferredCredentials ??= configuredDiscoveryCredentials(request.projectRoot ?? process.cwd());
		const configured = await deferredCredentials;
		if (configured.warning) {
			discoveryWarnings.push({ paperId: record.id, provider: "record", reason: configured.warning });
		}
		const discovered = await discoverDoiPdfCandidates({
			doi: record.identifiers.doi!,
			credentials: configured.credentials,
			signal: request.signal,
			fetcher: request.fetcher,
			resolver: request.resolver,
		});
		discoveryWarnings.push(...discovered.warnings.map((warning) => ({ ...warning, paperId: record.id })));
		const triedUrls = new Set(tried.map((candidate) => normalizedPdfUrl(candidate.url)?.href).filter(Boolean));
		return uniqueCandidates(discovered.candidates).filter((candidate) => !triedUrls.has(candidate.url));
	};
	const persistSuccessfulLink = async (record: PaperRecord, candidate: PdfDownloadCandidate, finalUrl: string) => {
		const providerDiscovered = !candidate.source.startsWith("record-");
		const links = [
			...record.links,
			{ url: candidate.url, kind: "pdf" as const, openAccess: providerDiscovered ? true : undefined },
		];
		if (finalUrl !== candidate.url) {
			links.push({ url: finalUrl, kind: "pdf", openAccess: providerDiscovered ? true : undefined });
		}
		await store.upsertPaper({ ...record, links: uniquePaperLinks(links) });
	};
	const downloadOne = async ({ record, candidates }: PreparedLiteraturePdfDownload["papers"][number]) => {
		const candidatesToTry = [...candidates];
		const deferredFallback = hasDeferredDoiFallback(record, candidates);
		let fallbackDiscovered = false;
		let index = 0;
		while (true) {
			if (index >= candidatesToTry.length) {
				if (deferredFallback && !fallbackDiscovered) {
					fallbackDiscovered = true;
					candidatesToTry.push(...(await discoverDeferredFallback(record, candidatesToTry)));
					continue;
				}
				break;
			}
			const candidate = candidatesToTry[index++];
			try {
				const acquired = await downloadCandidate(candidate, request);
				const blob = await store.putBlob(acquired.body);
				const version: PaperVersion = {
					paperId: record.id,
					sourceUrl: candidate.url,
					finalUrl: acquired.finalUrl,
					retrievedAt: new Date().toISOString(),
					sha256: blob.sha256,
					bytes: acquired.body.length,
					blobPath: blob.path,
					contentType: acquired.contentType,
					versionKind: candidate.versionKind,
				};
				await store.savePaperVersion(version);
				try {
					await persistSuccessfulLink(record, candidate, acquired.finalUrl);
				} catch (error) {
					discoveryWarnings.push({
						paperId: record.id,
						provider: "record",
						reason: `PDF was saved but its successful URL could not be persisted: ${readableErrorMessage(error)}`,
					});
				}
				downloaded.push(version);
				attempts.push({ paperId: record.id, ...candidate, status: "succeeded" });
				for (const skipped of candidatesToTry.slice(index)) {
					attempts.push({
						paperId: record.id,
						...skipped,
						status: "skipped",
						reason: "earlier candidate succeeded",
					});
				}
				return;
			} catch (error) {
				attempts.push({
					paperId: record.id,
					...candidate,
					status: "failed",
					reason: readableErrorMessage(error),
				});
			}
		}
		if (!candidatesToTry.length) {
			failures.push({ paperId: record.id, reason: "no safe PDF candidates were discovered" });
			return;
		}
		const reasons = attempts
			.filter((attempt) => attempt.paperId === record.id && attempt.status === "failed")
			.map((attempt) => `${attempt.source}: ${attempt.reason}`);
		failures.push({ paperId: record.id, reason: `all PDF candidates failed: ${reasons.join("; ")}` });
	};
	const worker = async () => {
		while (nextPaper < prepared.papers.length) {
			const paper = prepared.papers[nextPaper++];
			if (paper) await downloadOne(paper);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(request.concurrency, Math.max(1, prepared.papers.length)) }, () => worker()),
	);
	downloaded.sort((left, right) => left.paperId.localeCompare(right.paperId));
	failures.sort((left, right) => left.paperId.localeCompare(right.paperId));
	return {
		downloaded,
		failures,
		missingPaperIds: prepared.missingPaperIds,
		attempts,
		discoveryWarnings,
		corpusPath: store.root,
	};
}
