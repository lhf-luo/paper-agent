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
	url.searchParams.set("search_query", `all:${options.query}`);
	url.searchParams.set("start", String(start));
	url.searchParams.set("max_results", String(options.limit));
	url.searchParams.set("sortBy", "relevance");
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("arXiv", response);
	const xml = await response.text();
	const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
	const retrievedAt = new Date().toISOString();
	const records = entries
		.flatMap((entry): PaperRecord[] => {
			const title = extractXmlTag(entry, "title");
			const landing = extractXmlTag(entry, "id");
			if (!title || !landing) return [];
			const published = extractXmlTag(entry, "published");
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
		nextCursor: entries.length === options.limit ? String(start + options.limit) : undefined,
		requestUrl: url.href,
	};
}
