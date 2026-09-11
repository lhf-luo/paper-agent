import type { AddressResolver } from "../../shared/infrastructure/network-address.ts";
import { decodeEntities, readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { type Fetcher, fetchPublicUrl, fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeArxivId, normalizeDoi, paperPdfUrl } from "../domain/literature-identifiers.ts";
import { extractXmlTag } from "./provider-common.ts";
import { searchCrossrefByDoi } from "./provider-crossref.ts";

export type ProviderPdfCandidateSource =
	| "semantic-scholar-arxiv"
	| "arxiv-doi"
	| "crossref"
	| "unpaywall"
	| "semantic-scholar-oa"
	| "openalex"
	| "publisher-landing"
	| "publisher-derived";

export interface ProviderPdfCandidate {
	url: string;
	source: ProviderPdfCandidateSource;
	versionKind: "published" | "preprint" | "unknown";
}

export interface PdfDiscoveryWarning {
	provider: "crossref" | "unpaywall" | "semantic-scholar" | "arxiv" | "openalex" | "publisher" | "record";
	reason: string;
}

export interface PdfDiscoveryCredentials {
	unpaywallEmail?: string;
	semanticScholarApiKey?: string;
	openAlexMailto?: string;
}

export interface DiscoverDoiPdfCandidatesOptions {
	doi: string;
	credentials?: PdfDiscoveryCredentials;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

interface DiscoveryPart {
	candidates: ProviderPdfCandidate[];
	warnings: PdfDiscoveryWarning[];
}

function emptyPart(): DiscoveryPart {
	return { candidates: [], warnings: [] };
}

function httpsUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function providerPdfUrl(value: unknown): string | undefined {
	const candidate = httpsUrl(value);
	if (!candidate) return undefined;
	const hostname = new URL(candidate).hostname.toLowerCase();
	return hostname === "doi.org" || hostname === "dx.doi.org" ? undefined : candidate;
}

function htmlAttribute(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
	return match?.[2] ? decodeEntities(match[2].trim()) : undefined;
}

function publisherPdfLinks(html: string, baseUrl: URL): string[] {
	const values: string[] = [];
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const key = (htmlAttribute(tag, "name") ?? htmlAttribute(tag, "property"))?.toLowerCase();
		if (key === "citation_pdf_url") values.push(htmlAttribute(tag, "content") ?? "");
	}
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		if (htmlAttribute(tag, "type")?.toLowerCase() === "application/pdf") {
			values.push(htmlAttribute(tag, "href") ?? "");
		}
	}
	return [
		...new Set(
			values.flatMap((value) => {
				try {
					return [providerPdfUrl(new URL(value, baseUrl).href)].filter((url): url is string => Boolean(url));
				} catch {
					return [];
				}
			}),
		),
	];
}

async function jsonRequest(
	url: URL,
	options: DiscoverDoiPdfCandidatesOptions,
	headers: Record<string, string> = {},
): Promise<unknown> {
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		init: { headers: { Accept: "application/json", ...headers } },
		fetcher: options.fetcher,
		maxRetries: 1,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function discoverSemanticScholar(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	try {
		const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(options.doi)}`);
		url.searchParams.set("fields", "openAccessPdf,externalIds");
		const payload = (await jsonRequest(
			url,
			options,
			options.credentials?.semanticScholarApiKey ? { "x-api-key": options.credentials.semanticScholarApiKey } : {},
		)) as {
			externalIds?: Record<string, unknown>;
			openAccessPdf?: { url?: unknown; status?: unknown };
		};
		const returnedDoi = normalizeDoi(
			typeof payload.externalIds?.DOI === "string" ? payload.externalIds.DOI : undefined,
		);
		if (returnedDoi && returnedDoi !== options.doi) throw new Error("DOI mismatch in provider response");
		const candidates: ProviderPdfCandidate[] = [];
		const arxivId = normalizeArxivId(
			typeof payload.externalIds?.ArXiv === "string" ? payload.externalIds.ArXiv : undefined,
		);
		if (arxivId) {
			candidates.push({
				url: `https://arxiv.org/pdf/${arxivId}.pdf`,
				source: "semantic-scholar-arxiv",
				versionKind: "preprint",
			});
		}
		const oaUrl = payload.openAccessPdf?.status === "CLOSED" ? undefined : providerPdfUrl(payload.openAccessPdf?.url);
		if (oaUrl) candidates.push({ url: oaUrl, source: "semantic-scholar-oa", versionKind: "unknown" });
		return { candidates, warnings: [] };
	} catch (error) {
		return {
			candidates: [],
			warnings: [{ provider: "semantic-scholar", reason: readableErrorMessage(error) }],
		};
	}
}

async function discoverArxiv(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	try {
		const url = new URL("https://export.arxiv.org/api/query");
		url.searchParams.set("search_query", `doi:${options.doi}`);
		url.searchParams.set("start", "0");
		url.searchParams.set("max_results", "5");
		const response = await fetchWithRetry(url, {
			signal: options.signal,
			timeoutMs: 10_000,
			fetcher: options.fetcher,
			maxRetries: 1,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const xml = await response.text();
		const candidates = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].flatMap((match): ProviderPdfCandidate[] => {
			const entryDoi = normalizeDoi(extractXmlTag(match[1], "arxiv:doi"));
			if (entryDoi !== options.doi) return [];
			const arxivId = normalizeArxivId(extractXmlTag(match[1], "id"));
			return arxivId
				? [{ url: `https://arxiv.org/pdf/${arxivId}.pdf`, source: "arxiv-doi", versionKind: "preprint" }]
				: [];
		});
		return { candidates, warnings: [] };
	} catch (error) {
		return { candidates: [], warnings: [{ provider: "arxiv", reason: readableErrorMessage(error) }] };
	}
}

async function discoverUnpaywall(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	const email = options.credentials?.unpaywallEmail;
	if (!email) {
		return { candidates: [], warnings: [{ provider: "unpaywall", reason: "unpaywallEmail is not configured" }] };
	}
	try {
		const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(options.doi)}`);
		url.searchParams.set("email", email);
		const payload = (await jsonRequest(url, options)) as {
			best_oa_location?: { url_for_pdf?: unknown };
			first_oa_location?: { url_for_pdf?: unknown };
		};
		const candidates = [payload.best_oa_location, payload.first_oa_location].flatMap(
			(location): ProviderPdfCandidate[] => {
				const candidate = providerPdfUrl(location?.url_for_pdf);
				return candidate ? [{ url: candidate, source: "unpaywall", versionKind: "published" }] : [];
			},
		);
		return { candidates, warnings: [] };
	} catch (error) {
		return { candidates: [], warnings: [{ provider: "unpaywall", reason: readableErrorMessage(error) }] };
	}
}

async function discoverOpenAlex(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	try {
		const url = new URL("https://api.openalex.org/works");
		url.searchParams.set("filter", `doi:${options.doi}`);
		url.searchParams.set("per-page", "1");
		if (options.credentials?.openAlexMailto) url.searchParams.set("mailto", options.credentials.openAlexMailto);
		const payload = (await jsonRequest(url, options)) as {
			results?: Array<{
				doi?: unknown;
				best_oa_location?: { pdf_url?: unknown };
				primary_location?: { pdf_url?: unknown };
			}>;
		};
		const work = payload.results?.[0];
		if (!work) return emptyPart();
		const returnedDoi = normalizeDoi(typeof work.doi === "string" ? work.doi : undefined);
		if (returnedDoi && returnedDoi !== options.doi) throw new Error("DOI mismatch in provider response");
		const candidates = [work.best_oa_location?.pdf_url, work.primary_location?.pdf_url].flatMap(
			(value): ProviderPdfCandidate[] => {
				const candidate = providerPdfUrl(value);
				return candidate ? [{ url: candidate, source: "openalex", versionKind: "published" }] : [];
			},
		);
		return { candidates, warnings: [] };
	} catch (error) {
		return { candidates: [], warnings: [{ provider: "openalex", reason: readableErrorMessage(error) }] };
	}
}

async function discoverCrossref(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	try {
		const record = await searchCrossrefByDoi(options.doi, {
			signal: options.signal,
			fetcher: options.fetcher,
		});
		const candidates = (record?.links ?? []).flatMap((link): ProviderPdfCandidate[] => {
			const url = paperPdfUrl(link);
			if (!url) return [];
			const output: ProviderPdfCandidate[] = [{ url, source: "crossref", versionKind: "published" }];
			const derived = record ? mdpiStaticPdfUrl(record.venue, url) : undefined;
			if (derived) output.push({ url: derived, source: "publisher-derived", versionKind: "published" });
			return output;
		});
		return { candidates, warnings: [] };
	} catch (error) {
		return { candidates: [], warnings: [{ provider: "crossref", reason: readableErrorMessage(error) }] };
	}
}

function mdpiStaticPdfUrl(venue: string | undefined, value: string): string | undefined {
	if (!venue || !/^[\p{L}\p{N}]+$/u.test(venue.trim())) return undefined;
	const url = new URL(value);
	if (!/(^|\.)mdpi\.com$/i.test(url.hostname)) return undefined;
	const match = url.pathname.match(/^\/\d{4}-\d{3,4}\/(\d+)\/(?:\d+\/)?(\d+)\/pdf\/?$/i);
	if (!match) return undefined;
	const journal = venue
		.trim()
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (!journal) return undefined;
	const volume = match[1].padStart(2, "0");
	const article = match[2].padStart(5, "0");
	const stem = `${journal}-${volume}-${article}`;
	return `https://mdpi-res.com/d_attachment/${journal}/${stem}/article_deploy/${stem}.pdf`;
}

async function discoverPublisherLanding(options: DiscoverDoiPdfCandidatesOptions): Promise<DiscoveryPart> {
	try {
		const fetched = await fetchPublicUrl(new URL(`https://doi.org/${options.doi}`), {
			signal: options.signal,
			timeoutMs: 10_000,
			maxRetries: 1,
			fetcher: options.fetcher,
			resolver: options.resolver,
			requireHttps: true,
			init: { headers: { Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9" } },
		});
		if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
		const contentType = fetched.response.headers.get("content-type")?.toLowerCase() ?? "";
		if (contentType.includes("application/pdf")) {
			const url = providerPdfUrl(fetched.finalUrl.href);
			return url
				? { candidates: [{ url, source: "publisher-landing", versionKind: "published" }], warnings: [] }
				: emptyPart();
		}
		const html = (await readResponseBody(fetched.response, 2 * 1024 * 1024)).toString("utf8");
		return {
			candidates: publisherPdfLinks(html, fetched.finalUrl).map((url) => ({
				url,
				source: "publisher-landing" as const,
				versionKind: "published" as const,
			})),
			warnings: [],
		};
	} catch (error) {
		return { candidates: [], warnings: [{ provider: "publisher", reason: readableErrorMessage(error) }] };
	}
}

export async function discoverDoiPdfCandidates(
	options: DiscoverDoiPdfCandidatesOptions,
): Promise<{ candidates: ProviderPdfCandidate[]; warnings: PdfDiscoveryWarning[] }> {
	const doi = normalizeDoi(options.doi);
	if (!doi) return { candidates: [], warnings: [{ provider: "record", reason: "DOI is invalid" }] };
	const normalized = { ...options, doi };
	const [semanticScholar, arxiv, unpaywall, openAlex] = await Promise.all([
		discoverSemanticScholar(normalized),
		discoverArxiv(normalized),
		discoverUnpaywall(normalized),
		discoverOpenAlex(normalized),
	]);
	const providerCandidates = [
		...semanticScholar.candidates.filter((candidate) => candidate.source === "semantic-scholar-arxiv"),
		...arxiv.candidates,
		...unpaywall.candidates,
		...semanticScholar.candidates.filter((candidate) => candidate.source === "semantic-scholar-oa"),
		...openAlex.candidates,
	];
	const crossref = providerCandidates.length ? emptyPart() : await discoverCrossref(normalized);
	const publisher =
		providerCandidates.length || crossref.candidates.length
			? emptyPart()
			: await discoverPublisherLanding(normalized);
	return {
		candidates: [...providerCandidates, ...crossref.candidates, ...publisher.candidates],
		warnings: [
			...semanticScholar.warnings,
			...arxiv.warnings,
			...unpaywall.warnings,
			...openAlex.warnings,
			...crossref.warnings,
			...publisher.warnings,
		],
	};
}
