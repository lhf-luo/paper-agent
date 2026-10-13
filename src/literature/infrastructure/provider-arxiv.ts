import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeArxivId, normalizeDoi } from "../domain/literature-identifiers.ts";
import type { PaperLink, PaperRecord, ProviderPage } from "../domain/literature-types.ts";
import {
	extractXmlTag,
	extractXmlTags,
	LiteratureProviderHttpError,
	type ProviderSearchOptions,
	passesFilters,
	withId,
} from "./provider-common.ts";

export async function searchArxivPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const start = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(start) || start < 0) throw new Error("Invalid arXiv cursor");
	const url = new URL("https://export.arxiv.org/api/query");
	const dateRange =
		options.filters?.arxivSubmittedFrom && options.filters.arxivSubmittedTo
			? `submittedDate:[${options.filters.arxivSubmittedFrom.replaceAll("-", "")}0000 TO ${options.filters.arxivSubmittedTo.replaceAll("-", "")}2359]`
			: undefined;
	const keywordQuery = options.query.trim() === "*" ? undefined : `all:${options.query}`;
	const categoryQuery = options.arxivCategories?.length
		? `(${options.arxivCategories.map((category) => `cat:${category}`).join(" OR ")})`
		: undefined;
	const terms = [
		keywordQuery && (dateRange || categoryQuery) ? `(${keywordQuery})` : keywordQuery,
		categoryQuery,
		dateRange,
	].filter(Boolean);
	url.searchParams.set("search_query", terms.length ? terms.join(" AND ") : "all:*");
	url.searchParams.set("start", String(start));
	url.searchParams.set("max_results", String(options.limit));
	url.searchParams.set("sortBy", dateRange ? "submittedDate" : "relevance");
	if (dateRange) url.searchParams.set("sortOrder", "descending");
	let xml: string;
	try {
		const response = await fetchWithRetry(url, {
			signal: options.signal,
			timeoutMs: 60_000,
			fetcher: options.fetcher,
			beforeAttempt: options.beforeAttempt,
		});
		if (!response.ok) throw new LiteratureProviderHttpError("arXiv", response);
		xml = await response.text();
	} catch (error) {
		if (
			!options.signal?.aborted &&
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError")
		) {
			throw new Error(
				`arXiv page at offset ${start} timed out after 60 seconds; check the network or proxy settings`,
				{
					cause: error,
				},
			);
		}
		throw error;
	}
	if (/<title>\s*Error\s*<\/title>/i.test(xml)) {
		throw new Error(`arXiv API error: ${extractXmlTag(xml, "summary") || "invalid query or result range"}`);
	}
	const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
	const totalResultsValue = Number.parseInt(extractXmlTag(xml, "opensearch:totalResults") ?? "", 10);
	const totalResults = Number.isFinite(totalResultsValue) ? totalResultsValue : undefined;
	const retrievedAt = new Date().toISOString();
	const records = entries
		.flatMap((entry): PaperRecord[] => {
			const title = extractXmlTag(entry, "title");
			const landing = extractXmlTag(entry, "id");
			if (!title || !landing) return [];
			const published = extractXmlTag(entry, "published");
			if (
				dateRange &&
				(!published ||
					published.slice(0, 10) < options.filters!.arxivSubmittedFrom! ||
					published.slice(0, 10) > options.filters!.arxivSubmittedTo!)
			)
				return [];
			const doi = normalizeDoi(extractXmlTag(entry, "arxiv:doi"));
			const arxivId = normalizeArxivId(landing);
			const links: PaperLink[] = [
				{ url: landing, kind: "landing", openAccess: true },
				{ url: `${landing.replace("/abs/", "/pdf/")}.pdf`, kind: "pdf", openAccess: true },
			];
			if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
			return [
				withId({
					title,
					firstSubmittedAt: published || undefined,
					abstract: extractXmlTag(entry, "summary"),
					authors: extractXmlTags(entry, "name"),
					year: published ? Number.parseInt(published.slice(0, 4), 10) : undefined,
					venue: extractXmlTag(entry, "arxiv:journal_ref"),
					publicationType: "preprint",
					identifiers: { doi, arxivId },
					links,
					provenance: [
						{
							provider: "arxiv",
							query: options.query,
							retrievedAt,
							providerRecordId: arxivId,
							rawUrl: url.href,
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	return {
		provider: "arxiv",
		query: options.query,
		records,
		nextCursor:
			entries.length === options.limit && (totalResults === undefined || start + entries.length < totalResults)
				? String(start + options.limit)
				: undefined,
		requestUrl: url.href,
	};
}
