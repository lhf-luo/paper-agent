import { readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeDoi } from "../domain/literature-identifiers.ts";
import type { PaperLink, PaperRecord, ProviderPage, SearchFilters } from "../domain/literature-types.ts";
import {
	extractXmlTag,
	LiteratureProviderHttpError,
	passesFilters,
	type ProviderSearchOptions,
	withId,
} from "./provider-common.ts";

export const ACL_ANTHOLOGY_VENUES = [
	"aacl",
	"acl",
	"anlp",
	"coling",
	"conll",
	"eacl",
	"emnlp",
	"ijcnlp",
	"lrec",
	"naacl",
	"semeval",
	"tacl",
] as const;

const venueSet = new Set<string>(ACL_ANTHOLOGY_VENUES);
const XML_CACHE_TTL_MS = 5 * 60_000;
const XML_CACHE_LIMIT = 8;
const XML_MAX_BYTES = 30 * 1024 * 1024;
const xmlCache = new Map<string, { expiresAt: number; xml: string }>();

function normalizedVenue(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function aclAnthologyVenueId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizedVenue(value);
	for (const venue of ACL_ANTHOLOGY_VENUES) {
		if (normalized === venue) return venue;
	}
	const aliases: Array<[RegExp, string]> = [
		[/empirical methods.*natural language processing|\bemnlp\b/i, "emnlp"],
		[/northamerican.*computational linguistics|\bnaacl\b/i, "naacl"],
		[/european.*computational linguistics|\beacl\b/i, "eacl"],
		[/asia.*computational linguistics|\baacl\b/i, "aacl"],
		[/computational naturallanguage learning|\bconll\b/i, "conll"],
		[/international conference on computational linguistics|\bcoling\b/i, "coling"],
		[/language resources and evaluation conference|\blrec\b/i, "lrec"],
		[/transactions.*computational linguistics|\btacl\b/i, "tacl"],
		[/semantic evaluation|\bsemeval\b/i, "semeval"],
		[/association for computational linguistics|\bacl\b/i, "acl"],
	];
	return aliases.find(([pattern]) => pattern.test(value))?.[1];
}

export function aclAnthologyConstraintError(filters: SearchFilters | undefined): string | undefined {
	if (filters?.yearFrom === undefined || filters.yearFrom !== filters.yearTo) {
		return "ACL Anthology requires one exact year (yearFrom and yearTo must be equal)";
	}
	if (filters.venues?.length !== 1) return "ACL Anthology requires exactly one supported venue";
	if (!aclAnthologyVenueId(filters.venues[0])) {
		return `ACL Anthology venue is not supported: ${filters.venues[0]}`;
	}
	return undefined;
}

export function aclAnthologyFiltersForRecord(record: PaperRecord): SearchFilters | undefined {
	const venue = aclAnthologyVenueId(record.venue);
	return record.year && venue ? { yearFrom: record.year, yearTo: record.year, venues: [venue] } : undefined;
}

function authorsFromPaper(xml: string): string[] {
	return [...xml.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].flatMap((match) => {
		const name = [extractXmlTag(match[1], "first"), extractXmlTag(match[1], "middle"), extractXmlTag(match[1], "last")]
			.filter(Boolean)
			.join(" ")
			.trim();
		return name ? [name] : [];
	});
}

function matchesTerms(record: PaperRecord, query: string): boolean {
	const terms = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return true;
	const haystack = [record.title, record.abstract, record.authors.join(" "), record.venue]
		.filter(Boolean)
		.join(" ")
		.normalize("NFKC")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

function passesNonVenueFilters(record: PaperRecord, filters: SearchFilters | undefined): boolean {
	if (!filters) return true;
	const { venues: _venues, ...remaining } = filters;
	return passesFilters(record, remaining);
}

function trimCache(): void {
	const now = Date.now();
	for (const [key, value] of xmlCache) if (value.expiresAt <= now) xmlCache.delete(key);
	while (xmlCache.size >= XML_CACHE_LIMIT) xmlCache.delete(xmlCache.keys().next().value as string);
}

async function collectionXml(url: URL, options: ProviderSearchOptions): Promise<string> {
	if (!options.fetcher) {
		const cached = xmlCache.get(url.href);
		if (cached && cached.expiresAt > Date.now()) return cached.xml;
	}
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 30_000,
		init: { headers: { Accept: "application/xml" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("ACL Anthology", response);
	const xml = (await readResponseBody(response, XML_MAX_BYTES)).toString("utf8");
	if (!/<collection\b/i.test(xml) || !/<volume\b/i.test(xml)) {
		throw new Error("ACL Anthology returned an unexpected collection payload");
	}
	if (!options.fetcher) {
		trimCache();
		xmlCache.set(url.href, { expiresAt: Date.now() + XML_CACHE_TTL_MS, xml });
	}
	return xml;
}

function recordsFromXml(xml: string, options: ProviderSearchOptions, venueId: string, year: number, requestUrl: string) {
	const records: PaperRecord[] = [];
	const retrievedAt = new Date().toISOString();
	for (const volumeMatch of xml.matchAll(/<volume\b([^>]*)>([\s\S]*?)<\/volume>/gi)) {
		const volume = volumeMatch[2];
		const meta = /<meta\b[^>]*>([\s\S]*?)<\/meta>/i.exec(volume)?.[1] ?? "";
		const venue = extractXmlTag(meta, "booktitle") ?? extractXmlTag(meta, "venue") ?? venueId.toUpperCase();
		const recordYear = Number(extractXmlTag(meta, "year") ?? year);
		for (const paperMatch of volume.matchAll(/<paper\b[^>]*>([\s\S]*?)<\/paper>/gi)) {
			const paper = paperMatch[1];
			const title = extractXmlTag(paper, "title")
				?.replace(/\s+([:;,.)])/g, "$1")
				.replace(/([(])\s+/g, "$1");
			const anthologyId = extractXmlTag(paper, "url");
			if (!title || !anthologyId) continue;
			const doi = normalizeDoi(extractXmlTag(paper, "doi"));
			const landing = `https://aclanthology.org/${anthologyId}/`;
			const links: PaperLink[] = [
				{ url: landing, kind: "landing", openAccess: true },
				{ url: `https://aclanthology.org/${anthologyId}.pdf`, kind: "pdf", openAccess: true },
			];
			if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
			const record = withId({
				title,
				abstract: extractXmlTag(paper, "abstract"),
				authors: authorsFromPaper(paper),
				year: Number.isInteger(recordYear) ? recordYear : year,
				venue,
				publicationType: "conference paper",
				identifiers: { doi },
				links,
				provenance: [{ provider: "acl_anthology", query: options.query, retrievedAt, providerRecordId: anthologyId, rawUrl: requestUrl }],
				mergedFrom: [],
			});
			if (matchesTerms(record, options.query) && passesNonVenueFilters(record, options.filters)) records.push(record);
		}
	}
	return records;
}

export async function searchAclAnthologyPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const problem = aclAnthologyConstraintError(options.filters);
	if (problem) throw new Error(problem);
	const year = options.filters?.yearFrom as number;
	const venueId = aclAnthologyVenueId(options.filters?.venues?.[0]) as string;
	if (!venueSet.has(venueId)) throw new Error(`ACL Anthology venue is not supported: ${venueId}`);
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid ACL Anthology cursor");
	if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
		throw new Error("ACL Anthology page limit must be between 1 and 1000");
	}
	const requestUrl = `https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml/${year}.${venueId}.xml`;
	const xml = await collectionXml(new URL(requestUrl), options);
	const records = recordsFromXml(xml, options, venueId, year, requestUrl);
	const pageRecords = records.slice(offset, offset + options.limit);
	return {
		provider: "acl_anthology",
		query: options.query,
		records: pageRecords,
		nextCursor: offset + pageRecords.length < records.length ? String(offset + pageRecords.length) : undefined,
		total: records.length,
		requestUrl,
	};
}
