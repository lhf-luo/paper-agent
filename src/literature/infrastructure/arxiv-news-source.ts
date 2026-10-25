import { type Fetcher, fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { type ArxivNewsPaper, validateArxivNewsCategories, validateArxivNewsDate } from "../domain/arxiv-news.ts";
import { normalizeArxivId, normalizeDoi } from "../domain/literature-identifiers.ts";
import { extractXmlTag, extractXmlTags, LiteratureProviderHttpError, withId } from "./provider-common.ts";

export interface ArxivNewsFetchOptions {
	date: string;
	categories: string[];
	limit: number;
	cursor?: string;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	beforeAttempt?: () => Promise<void>;
}

export interface ArxivNewsPage {
	provider: "arxiv";
	query: string;
	records: ArxivNewsPaper[];
	nextCursor?: string;
	requestUrl: string;
}

async function fetchNewsXml(url: URL, options: ArxivNewsFetchOptions): Promise<string> {
	try {
		const response = await fetchWithRetry(url, {
			signal: options.signal,
			timeoutMs: 60_000,
			fetcher: options.fetcher,
			beforeAttempt: options.beforeAttempt,
		});
		if (!response.ok) throw new LiteratureProviderHttpError("arXiv", response);
		return await response.text();
	} catch (error) {
		if (!options.signal?.aborted && error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
			throw new Error(
				`arXiv page at offset ${options.cursor ?? "0"} timed out after 60 seconds; check the network or proxy settings`,
				{ cause: error },
			);
		}
		throw error;
	}
}

function parseNewsEntry(entry: string, date: string, url: URL, retrievedAt: string): ArxivNewsPaper[] {
	const title = extractXmlTag(entry, "title");
	const landing = extractXmlTag(entry, "id");
	const published = extractXmlTag(entry, "published");
	if (!title || !landing || !published || published.slice(0, 10) !== date) return [];
	const doi = normalizeDoi(extractXmlTag(entry, "arxiv:doi"));
	const arxivId = normalizeArxivId(landing);
	if (!arxivId) return [];
	const record = withId({
		title,
		abstract: extractXmlTag(entry, "summary"),
		authors: extractXmlTags(entry, "name"),
		year: Number.parseInt(published.slice(0, 4), 10),
		venue: extractXmlTag(entry, "arxiv:journal_ref"),
		publicationType: "preprint",
		identifiers: { doi, arxivId },
		links: [
			{ url: landing, kind: "landing", openAccess: true },
			{ url: `${landing.replace("/abs/", "/pdf/")}.pdf`, kind: "pdf", openAccess: true },
			...(doi ? [{ url: `https://doi.org/${doi}`, kind: "doi" as const }] : []),
		],
		provenance: [
			{
				provider: "arxiv",
				query: url.searchParams.get("search_query")!,
				retrievedAt,
				providerRecordId: arxivId,
				rawUrl: url.href,
			},
		],
		mergedFrom: [],
	});
	return [{ ...record, firstSubmittedAt: published }];
}

/** News-only daily UTC query; the generic keyword adapter has no dependency on this module. */
export async function fetchArxivNewsPage(options: ArxivNewsFetchOptions): Promise<ArxivNewsPage> {
	const date = validateArxivNewsDate(options.date);
	const categories = validateArxivNewsCategories(options.categories);
	const start = Number(options.cursor ?? "0");
	if (!Number.isInteger(start) || start < 0) throw new Error("Invalid arXiv news cursor");
	if (start >= 30_000) throw new Error(`arXiv result limit reached on ${date}; this day was not saved`);
	if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
		throw new Error("Invalid arXiv news page size");
	const day = date.replaceAll("-", "");
	const query = `(${categories.map((category) => `cat:${category}`).join(" OR ")}) AND submittedDate:[${day}0000 TO ${day}2359]`;
	const url = new URL("https://export.arxiv.org/api/query");
	url.search = new URLSearchParams({
		search_query: query,
		start: String(start),
		max_results: String(options.limit),
		sortBy: "submittedDate",
		sortOrder: "descending",
	}).toString();
	const xml = await fetchNewsXml(url, options);
	if (/<title>\s*Error\s*<\/title>/i.test(xml)) {
		throw new Error(`arXiv API error: ${extractXmlTag(xml, "summary") || "invalid query or result range"}`);
	}
	const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
	const total = Number.parseInt(extractXmlTag(xml, "opensearch:totalResults") ?? "", 10);
	const retrievedAt = new Date().toISOString();
	return {
		provider: "arxiv",
		query,
		records: entries.flatMap((entry) => parseNewsEntry(entry, date, url, retrievedAt)),
		nextCursor:
			entries.length === options.limit && (!Number.isFinite(total) || start + entries.length < total)
				? String(start + options.limit)
				: undefined,
		requestUrl: url.href,
	};
}
