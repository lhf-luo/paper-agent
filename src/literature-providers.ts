import { normalizeArxivId, normalizeDoi, paperRecordId } from "./literature-identifiers.ts";
import type { LiteratureProvider, PaperLink, PaperRecord, ProviderPage, SearchFilters } from "./literature-types.ts";
import { decodeEntities, type Fetcher, fetchWithRetry } from "./network-security.ts";

export interface ProviderSearchOptions {
	query: string;
	limit: number;
	cursor?: string;
	filters?: SearchFilters;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	openAlexMailto?: string;
	semanticScholarApiKey?: string;
	coreApiKey?: string;
	pubmedApiKey?: string;
	pubmedEmail?: string;
	unpaywallEmail?: string;
}

function retryAfterTimestamp(response: Response): string | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return new Date(Date.now() + Math.min(seconds, 86_400) * 1_000).toISOString();
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export class LiteratureProviderHttpError extends Error {
	readonly statusCode: number;
	readonly retryAfter?: string;

	constructor(provider: string, response: Response) {
		const retryAfter = retryAfterTimestamp(response);
		super(`${provider} returned HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ""}`);
		this.statusCode = response.status;
		this.retryAfter = retryAfter;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

function extractXmlTag(xml: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
	return match
		? decodeEntities(
				match[1]
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			)
		: undefined;
}

function extractXmlTags(xml: string, tag: string): string[] {
	const matches = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"));
	return [...matches].map((match) =>
		decodeEntities(
			match[1]
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		),
	);
}

function passesFilters(record: PaperRecord, filters: SearchFilters | undefined): boolean {
	if (!filters) return true;
	if (filters.yearFrom !== undefined && (record.year === undefined || record.year < filters.yearFrom)) return false;
	if (filters.yearTo !== undefined && (record.year === undefined || record.year > filters.yearTo)) return false;
	if (
		filters.venues?.length &&
		(!record.venue || !filters.venues.some((venue) => record.venue?.toLowerCase().includes(venue.toLowerCase())))
	) {
		return false;
	}
	if (
		filters.authors?.length &&
		!filters.authors.every((wanted) =>
			record.authors.some((author) => author.toLowerCase().includes(wanted.toLowerCase())),
		)
	) {
		return false;
	}
	if (
		filters.types?.length &&
		(!record.publicationType ||
			!filters.types.some((type) => record.publicationType?.toLowerCase().includes(type.toLowerCase())))
	) {
		return false;
	}
	if (filters.openAccess === true && !record.links.some((link) => link.openAccess === true || link.kind === "pdf")) {
		return false;
	}
	return true;
}

function withId(record: Omit<PaperRecord, "id">): PaperRecord {
	const complete = { ...record, id: "" };
	complete.id = paperRecordId(complete);
	return complete;
}

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
		timeoutMs: 20_000,
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

function openAlexAuthors(work: Record<string, unknown>): string[] {
	if (!Array.isArray(work.authorships)) return [];
	return work.authorships.flatMap((authorship) => {
		if (!isRecord(authorship) || !isRecord(authorship.author)) return [];
		const name = readString(authorship.author, "display_name");
		return name ? [name] : [];
	});
}

function openAlexAbstract(work: Record<string, unknown>): string | undefined {
	if (!isRecord(work.abstract_inverted_index)) return undefined;
	const positioned: Array<{ position: number; word: string }> = [];
	for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
		if (!Array.isArray(positions)) continue;
		for (const position of positions) if (typeof position === "number") positioned.push({ position, word });
	}
	positioned.sort((left, right) => left.position - right.position);
	return positioned.map((item) => item.word).join(" ") || undefined;
}

function openAlexVenue(work: Record<string, unknown>): string | undefined {
	if (!isRecord(work.primary_location) || !isRecord(work.primary_location.source)) return undefined;
	return readString(work.primary_location.source, "display_name");
}

function openAlexLinks(work: Record<string, unknown>): PaperLink[] {
	const links: PaperLink[] = [];
	if (isRecord(work.primary_location)) {
		const landing = readString(work.primary_location, "landing_page_url");
		const pdf = readString(work.primary_location, "pdf_url");
		if (landing) links.push({ url: landing, kind: "landing" });
		if (pdf) links.push({ url: pdf, kind: "pdf", openAccess: true });
	}
	const doi = normalizeDoi(readString(work, "doi"));
	if (doi && !links.some((link) => link.url === `https://doi.org/${doi}`)) {
		links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
	}
	const id = readString(work, "id");
	if (id && !links.some((link) => link.url === id)) links.push({ url: id, kind: "landing" });
	return links;
}

function openAlexRecord(
	value: unknown,
	query: string,
	requestUrl: string,
	retrievedAt: string,
): PaperRecord | undefined {
	if (!isRecord(value)) return undefined;
	const title = readString(value, "display_name") ?? readString(value, "title");
	if (!title) return undefined;
	const openAlexId = readString(value, "id");
	const record = withId({
		title,
		abstract: openAlexAbstract(value),
		authors: openAlexAuthors(value),
		year: readNumber(value, "publication_year"),
		venue: openAlexVenue(value),
		publicationType: readString(value, "type"),
		identifiers: {
			doi: normalizeDoi(readString(value, "doi")),
			openAlexId,
		},
		links: openAlexLinks(value),
		citationCount: readNumber(value, "cited_by_count"),
		referencedWorks: Array.isArray(value.referenced_works)
			? value.referenced_works.filter((item): item is string => typeof item === "string")
			: undefined,
		citedByApiUrl: readString(value, "cited_by_api_url"),
		provenance: [
			{
				provider: "openalex",
				query,
				retrievedAt,
				providerRecordId: openAlexId,
				rawUrl: requestUrl,
			},
		],
		mergedFrom: [],
	});
	return record;
}

export async function searchOpenAlexPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const cursor = options.cursor ?? "*";
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("per-page", String(options.limit));
	url.searchParams.set("cursor", cursor);
	const openAlexMailto = options.openAlexMailto ?? providerCredentials.openAlexMailto ?? process.env.OPENALEX_MAILTO;
	if (openAlexMailto) url.searchParams.set("mailto", openAlexMailto);
	const filters: string[] = [`title_and_abstract.search:${options.query}`];
	if (options.filters?.yearFrom) filters.push(`from_publication_date:${options.filters.yearFrom}-01-01`);
	if (options.filters?.yearTo) filters.push(`to_publication_date:${options.filters.yearTo}-12-31`);
	if (options.filters?.openAccess) filters.push("is_oa:true");
	url.searchParams.set("filter", filters.join(","));
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("OpenAlex", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.results))
		throw new Error("OpenAlex returned an unexpected payload");
	const retrievedAt = new Date().toISOString();
	const records = payload.results
		.map((value) => openAlexRecord(value, options.query, url.href, retrievedAt))
		.filter((record): record is PaperRecord => Boolean(record))
		.filter((record) => passesFilters(record, options.filters));
	const meta = isRecord(payload.meta) ? payload.meta : undefined;
	return {
		provider: "openalex",
		query: options.query,
		records,
		nextCursor: meta ? readString(meta, "next_cursor") : undefined,
		total: meta ? readNumber(meta, "count") : undefined,
		requestUrl: url.href,
	};
}

function crossrefAuthors(item: Record<string, unknown>): string[] {
	if (!Array.isArray(item.author)) return [];
	return item.author.flatMap((value) => {
		if (!isRecord(value)) return [];
		const name = [readString(value, "given"), readString(value, "family")].filter(Boolean).join(" ");
		return name ? [name] : [];
	});
}

function crossrefYear(item: Record<string, unknown>): number | undefined {
	for (const key of ["published-print", "published-online", "issued", "created"]) {
		const value = item[key];
		if (!isRecord(value) || !Array.isArray(value["date-parts"])) continue;
		const first = value["date-parts"][0];
		if (Array.isArray(first) && typeof first[0] === "number") return first[0];
	}
	return undefined;
}

function firstString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
	return undefined;
}

export async function searchCrossrefPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid Crossref cursor");
	const url = new URL("https://api.crossref.org/works");
	url.searchParams.set("query.bibliographic", options.query);
	url.searchParams.set("rows", String(options.limit));
	url.searchParams.set("offset", String(offset));
	const crossrefMailto = providerCredentials.crossrefPoliteEmail ?? process.env.CROSSREF_POLITE_EMAIL;
	if (crossrefMailto) url.searchParams.set("mailto", crossrefMailto);
	if (options.filters?.yearFrom || options.filters?.yearTo) {
		const from = options.filters.yearFrom ?? 1000;
		const until = options.filters.yearTo ?? 9999;
		url.searchParams.set("filter", `from-pub-date:${from}-01-01,until-pub-date:${until}-12-31`);
	}
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Crossref", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.message) || !Array.isArray(payload.message.items)) {
		throw new Error("Crossref returned an unexpected payload");
	}
	const retrievedAt = new Date().toISOString();
	const records = payload.message.items
		.flatMap((value): PaperRecord[] => {
			if (!isRecord(value)) return [];
			const title = firstString(value.title);
			const doi = normalizeDoi(readString(value, "DOI"));
			const landing = readString(value, "URL") ?? (doi ? `https://doi.org/${doi}` : undefined);
			if (!title || !landing) return [];
			const links: PaperLink[] = [{ url: landing, kind: doi ? "doi" : "landing" }];
			if (Array.isArray(value.link)) {
				for (const link of value.link) {
					if (!isRecord(link)) continue;
					const href = readString(link, "URL");
					const type = readString(link, "content-type");
					if (href) links.push({ url: href, kind: type?.includes("pdf") ? "pdf" : "other", openAccess: false });
				}
			}
			return [
				withId({
					title,
					abstract: readString(value, "abstract")?.replace(/<[^>]+>/g, " "),
					authors: crossrefAuthors(value),
					year: crossrefYear(value),
					venue: firstString(value["container-title"]),
					publicationType: readString(value, "type"),
					identifiers: { doi },
					links,
					citationCount: readNumber(value, "is-referenced-by-count"),
					provenance: [
						{
							provider: "crossref",
							query: options.query,
							retrievedAt,
							providerRecordId: doi,
							rawUrl: url.href,
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	const total = readNumber(payload.message, "total-results");
	return {
		provider: "crossref",
		query: options.query,
		records,
		nextCursor:
			offset + options.limit < (total ?? offset + options.limit) ? String(offset + options.limit) : undefined,
		total,
		requestUrl: url.href,
	};
}

function semanticScholarRecord(
	value: unknown,
	query: string,
	requestUrl: string,
	retrievedAt: string,
): PaperRecord | undefined {
	if (!isRecord(value)) return undefined;
	const title = readString(value, "title");
	const paperId = readString(value, "paperId");
	if (!title || !paperId) return undefined;
	const externalIds = isRecord(value.externalIds) ? value.externalIds : {};
	const doi = normalizeDoi(readString(externalIds, "DOI"));
	const arxivId = normalizeArxivId(readString(externalIds, "ArXiv"));
	const links: PaperLink[] = [];
	const landing = readString(value, "url");
	if (landing) links.push({ url: landing, kind: "landing" });
	if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
	if (arxivId) {
		links.push({ url: `https://arxiv.org/abs/${arxivId}`, kind: "landing", openAccess: true });
		links.push({ url: `https://arxiv.org/pdf/${arxivId}.pdf`, kind: "pdf", openAccess: true });
	}
	if (isRecord(value.openAccessPdf)) {
		const pdf = readString(value.openAccessPdf, "url");
		if (pdf && !links.some((link) => link.url === pdf)) links.push({ url: pdf, kind: "pdf", openAccess: true });
	}
	const authors = Array.isArray(value.authors)
		? value.authors.flatMap((author) => {
				if (!isRecord(author)) return [];
				const name = readString(author, "name");
				return name ? [name] : [];
			})
		: [];
	const publicationTypes = Array.isArray(value.publicationTypes)
		? value.publicationTypes.filter((item): item is string => typeof item === "string")
		: [];
	return withId({
		title,
		abstract: readString(value, "abstract"),
		authors,
		year: readNumber(value, "year"),
		venue: readString(value, "venue"),
		publicationType: publicationTypes[0],
		identifiers: { doi, arxivId, semanticScholarId: paperId },
		links,
		citationCount: readNumber(value, "citationCount"),
		provenance: [
			{
				provider: "semanticscholar",
				query,
				retrievedAt,
				providerRecordId: paperId,
				rawUrl: requestUrl,
			},
		],
		mergedFrom: [],
	});
}

export async function searchSemanticScholarPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid Semantic Scholar cursor");
	const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
	url.searchParams.set("query", options.query);
	url.searchParams.set("limit", String(Math.min(options.limit, 100)));
	url.searchParams.set("offset", String(offset));
	url.searchParams.set(
		"fields",
		"paperId,title,abstract,authors,year,venue,publicationTypes,externalIds,url,openAccessPdf,citationCount",
	);
	const headers: Record<string, string> = { Accept: "application/json" };
	const apiKey = options.semanticScholarApiKey ?? providerCredentials.semanticScholarApiKey ?? process.env.S2_API_KEY;
	if (apiKey) headers["x-api-key"] = apiKey;
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers },
		fetcher: options.fetcher,
		baseDelayMs: 1_000,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Semantic Scholar", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Semantic Scholar returned an unexpected payload");
	}
	const retrievedAt = new Date().toISOString();
	const records = payload.data
		.map((value) => semanticScholarRecord(value, options.query, url.href, retrievedAt))
		.filter((record): record is PaperRecord => Boolean(record))
		.filter((record) => passesFilters(record, options.filters));
	const total = readNumber(payload, "total");
	const next = readNumber(payload, "next");
	return {
		provider: "semanticscholar",
		query: options.query,
		records,
		nextCursor:
			next !== undefined
				? String(next)
				: offset + options.limit < (total ?? offset + options.limit)
					? String(offset + options.limit)
					: undefined,
		total,
		requestUrl: url.href,
	};
}

export async function searchSemanticScholarCitations(
	paperId: string,
	direction: "references" | "citations",
	options: Pick<ProviderSearchOptions, "fetcher" | "semanticScholarApiKey" | "signal"> & {
		limit: number;
		cursor?: string;
		queryLabel: string;
	},
): Promise<ProviderPage> {
	if (!paperId.trim() || /[/?#]/.test(paperId)) throw new Error("Invalid Semantic Scholar paper id");
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid Semantic Scholar citation cursor");
	const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}/${direction}`);
	url.searchParams.set("limit", String(Math.min(options.limit, 100)));
	url.searchParams.set("offset", String(offset));
	url.searchParams.set(
		"fields",
		"paperId,title,abstract,authors,year,venue,publicationTypes,externalIds,url,openAccessPdf,citationCount",
	);
	const headers: Record<string, string> = { Accept: "application/json" };
	const apiKey = options.semanticScholarApiKey ?? providerCredentials.semanticScholarApiKey ?? process.env.S2_API_KEY;
	if (apiKey) headers["x-api-key"] = apiKey;
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers },
		fetcher: options.fetcher,
		baseDelayMs: 1_000,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Semantic Scholar", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Semantic Scholar returned an unexpected citation payload");
	}
	const retrievedAt = new Date().toISOString();
	const edgeKey = direction === "references" ? "citedPaper" : "citingPaper";
	const records = payload.data
		.flatMap((edge) => (isRecord(edge) ? [edge[edgeKey]] : []))
		.map((value) => semanticScholarRecord(value, options.queryLabel, url.href, retrievedAt))
		.filter((record): record is PaperRecord => Boolean(record));
	const next = readNumber(payload, "next");
	return {
		provider: "semanticscholar",
		query: options.queryLabel,
		records,
		nextCursor: next === undefined ? undefined : String(next),
		requestUrl: url.href,
	};
}

function textValue(value: unknown): string | undefined {
	if (typeof value === "string")
		return decodeEntities(
			value
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		);
	if (isRecord(value)) {
		for (const key of ["text", "name", "value"]) {
			const text = readString(value, key);
			if (text)
				return decodeEntities(
					text
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim(),
				);
		}
	}
	return undefined;
}

function stringValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((entry) => stringValues(entry));
	const text = textValue(value);
	return text ? [text] : [];
}

export async function searchDblpPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid DBLP cursor");
	const url = new URL("https://dblp.org/search/publ/api");
	url.searchParams.set("q", options.query);
	url.searchParams.set("h", String(Math.min(options.limit, 1000)));
	url.searchParams.set("f", String(offset));
	url.searchParams.set("format", "json");
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json", "User-Agent": "paper-agent/0.1 literature research" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("DBLP", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.result) || !isRecord(payload.result.hits)) {
		throw new Error("DBLP returned an unexpected payload");
	}
	const hits = Array.isArray(payload.result.hits.hit) ? payload.result.hits.hit : [];
	const retrievedAt = new Date().toISOString();
	const records = hits
		.flatMap((hit): PaperRecord[] => {
			if (!isRecord(hit) || !isRecord(hit.info)) return [];
			const info = hit.info;
			const title = textValue(info.title);
			const dblpKey = readString(info, "key");
			const landing = readString(info, "url") ?? (dblpKey ? `https://dblp.org/rec/${dblpKey}` : undefined);
			if (!title || !landing) return [];
			const doi = normalizeDoi(readString(info, "doi"));
			const authorsContainer = isRecord(info.authors) ? info.authors.author : undefined;
			const links: PaperLink[] = [{ url: landing, kind: "landing" }];
			for (const ee of stringValues(info.ee)) {
				const kind = /\.pdf(?:[?#]|$)/i.test(ee) ? "pdf" : ee.includes("doi.org") ? "doi" : "other";
				links.push({ url: ee, kind, openAccess: kind === "pdf" ? undefined : false });
			}
			if (doi && !links.some((link) => link.url === `https://doi.org/${doi}`))
				links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
			return [
				withId({
					title,
					authors: stringValues(authorsContainer),
					year: Number.parseInt(readString(info, "year") ?? "", 10) || undefined,
					venue: textValue(info.venue),
					publicationType: readString(info, "type"),
					identifiers: { doi, dblpKey },
					links,
					provenance: [
						{
							provider: "dblp",
							query: options.query,
							retrievedAt,
							providerRecordId: dblpKey,
							rawUrl: url.href,
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	const total = Number.parseInt(textValue(payload.result.hits.total) ?? "", 10) || undefined;
	return {
		provider: "dblp",
		query: options.query,
		records,
		nextCursor:
			offset + options.limit < (total ?? offset + hits.length) && hits.length
				? String(offset + options.limit)
				: undefined,
		total,
		requestUrl: url.href,
	};
}

export async function searchPubmedPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid PubMed cursor");
	const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
	searchUrl.searchParams.set("db", "pubmed");
	searchUrl.searchParams.set("term", options.query);
	searchUrl.searchParams.set("retmode", "json");
	searchUrl.searchParams.set("retstart", String(offset));
	searchUrl.searchParams.set("retmax", String(Math.min(options.limit, 200)));
	const apiKey = options.pubmedApiKey ?? providerCredentials.pubmedApiKey ?? process.env.NCBI_API_KEY;
	const email = options.pubmedEmail ?? providerCredentials.ncbiEmail ?? process.env.NCBI_EMAIL;
	if (apiKey) searchUrl.searchParams.set("api_key", apiKey);
	if (email) searchUrl.searchParams.set("email", email);
	if (options.filters?.yearFrom || options.filters?.yearTo) {
		searchUrl.searchParams.set("datetype", "pdat");
		searchUrl.searchParams.set("mindate", String(options.filters.yearFrom ?? 1000));
		searchUrl.searchParams.set("maxdate", String(options.filters.yearTo ?? 9999));
	}
	const searchResponse = await fetchWithRetry(searchUrl, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!searchResponse.ok) throw new LiteratureProviderHttpError("PubMed search", searchResponse);
	const searchPayload: unknown = await searchResponse.json();
	if (
		!isRecord(searchPayload) ||
		!isRecord(searchPayload.esearchresult) ||
		!Array.isArray(searchPayload.esearchresult.idlist)
	) {
		throw new Error("PubMed search returned an unexpected payload");
	}
	const ids = searchPayload.esearchresult.idlist.filter((entry): entry is string => typeof entry === "string");
	const total = Number.parseInt(readString(searchPayload.esearchresult, "count") ?? "", 10) || undefined;
	if (!ids.length) return { provider: "pubmed", query: options.query, records: [], total, requestUrl: searchUrl.href };
	const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
	summaryUrl.searchParams.set("db", "pubmed");
	summaryUrl.searchParams.set("id", ids.join(","));
	summaryUrl.searchParams.set("retmode", "json");
	if (apiKey) summaryUrl.searchParams.set("api_key", apiKey);
	if (email) summaryUrl.searchParams.set("email", email);
	const summaryResponse = await fetchWithRetry(summaryUrl, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!summaryResponse.ok) throw new LiteratureProviderHttpError("PubMed summary", summaryResponse);
	const summaryPayload: unknown = await summaryResponse.json();
	if (!isRecord(summaryPayload) || !isRecord(summaryPayload.result))
		throw new Error("PubMed summary returned an unexpected payload");
	const summaryResult = summaryPayload.result;
	const retrievedAt = new Date().toISOString();
	const records = ids
		.flatMap((pmid): PaperRecord[] => {
			const value = summaryResult[pmid];
			if (!isRecord(value)) return [];
			const title = readString(value, "title")?.replace(/\s+/g, " ").trim();
			if (!title) return [];
			const articleIds = Array.isArray(value.articleids) ? value.articleids.filter(isRecord) : [];
			const doi = normalizeDoi(
				readString(articleIds.find((entry) => readString(entry, "idtype") === "doi") ?? {}, "value"),
			);
			const links: PaperLink[] = [{ url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, kind: "landing" }];
			if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
			const authors = Array.isArray(value.authors)
				? value.authors.flatMap((author) =>
						isRecord(author) && readString(author, "name") ? [readString(author, "name")!] : [],
					)
				: [];
			const publicationDate = readString(value, "pubdate") ?? readString(value, "epubdate");
			const yearMatch = /\b(1[6-9]\d{2}|20\d{2}|21\d{2})\b/.exec(publicationDate ?? "");
			return [
				withId({
					title,
					authors,
					year: yearMatch ? Number(yearMatch[1]) : undefined,
					venue: readString(value, "fulljournalname") ?? readString(value, "source"),
					publicationType: Array.isArray(value.pubtype) ? textValue(value.pubtype[0]) : undefined,
					identifiers: { doi, pmid },
					links,
					provenance: [
						{
							provider: "pubmed",
							query: options.query,
							retrievedAt,
							providerRecordId: pmid,
							rawUrl: searchUrl.href.replace(apiKey ?? "", apiKey ? "[redacted]" : ""),
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	return {
		provider: "pubmed",
		query: options.query,
		records,
		nextCursor: offset + ids.length < (total ?? offset + ids.length) ? String(offset + ids.length) : undefined,
		total,
		requestUrl: searchUrl.href.replace(apiKey ?? "", apiKey ? "[redacted]" : ""),
	};
}

export async function searchCorePage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const apiKey = options.coreApiKey ?? providerCredentials.coreApiKey ?? process.env.CORE_API_KEY;
	if (!apiKey) throw new Error("CORE_API_KEY is required for the CORE provider");
	const offset = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid CORE cursor");
	const url = new URL("https://api.core.ac.uk/v3/search/works");
	url.searchParams.set("q", options.query);
	url.searchParams.set("limit", String(Math.min(options.limit, 100)));
	url.searchParams.set("offset", String(offset));
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 25_000,
		init: { headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("CORE", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error("CORE returned an unexpected payload");
	const retrievedAt = new Date().toISOString();
	const records = payload.results
		.flatMap((value): PaperRecord[] => {
			if (!isRecord(value)) return [];
			const title = readString(value, "title");
			const coreIdValue = value.id;
			const coreId =
				typeof coreIdValue === "number" || typeof coreIdValue === "string" ? String(coreIdValue) : undefined;
			if (!title || !coreId) return [];
			const doi = normalizeDoi(readString(value, "doi"));
			const links: PaperLink[] = [
				{ url: `https://core.ac.uk/works/${encodeURIComponent(coreId)}`, kind: "landing" },
			];
			for (const candidate of [readString(value, "downloadUrl"), ...stringValues(value.sourceFulltextUrls)]) {
				if (candidate && !links.some((link) => link.url === candidate))
					links.push({ url: candidate, kind: "pdf", openAccess: true });
			}
			if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
			const authors = Array.isArray(value.authors)
				? value.authors.flatMap((author) =>
						isRecord(author) && readString(author, "name") ? [readString(author, "name")!] : stringValues(author),
					)
				: [];
			return [
				withId({
					title,
					abstract: readString(value, "abstract"),
					authors,
					year: readNumber(value, "yearPublished"),
					venue: readString(value, "publisher"),
					publicationType: readString(value, "documentType"),
					identifiers: { doi, coreId },
					links,
					provenance: [
						{
							provider: "core",
							query: options.query,
							retrievedAt,
							providerRecordId: coreId,
							rawUrl: url.href,
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	const total = readNumber(payload, "totalHits") ?? readNumber(payload, "total");
	return {
		provider: "core",
		query: options.query,
		records,
		nextCursor:
			offset + options.limit < (total ?? offset + payload.results.length) && payload.results.length
				? String(offset + options.limit)
				: undefined,
		total,
		requestUrl: url.href,
	};
}

function doiOnlyQuery(query: string, provider: string): string {
	const doi = normalizeDoi(query);
	if (!doi) throw new Error(`${provider} requires a DOI query; use it as an enrichment provider after discovery`);
	return doi;
}

export async function searchOpenCitationsPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	if (options.cursor) throw new Error("OpenCitations metadata lookup does not support pagination");
	const doi = doiOnlyQuery(options.query, "OpenCitations");
	const url = new URL(`https://api.opencitations.net/meta/api/v1/metadata/doi:${encodeURIComponent(doi)}`);
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("OpenCitations", response);
	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) throw new Error("OpenCitations returned an unexpected payload");
	const retrievedAt = new Date().toISOString();
	const records = payload
		.flatMap((value): PaperRecord[] => {
			if (!isRecord(value)) return [];
			const title = readString(value, "title");
			if (!title) return [];
			const id = readString(value, "id") ?? `doi:${doi}`;
			const date = readString(value, "pub_date");
			return [
				withId({
					title,
					authors: (readString(value, "author") ?? "").split(/\s*;\s*/).filter(Boolean),
					year: date ? Number.parseInt(date.slice(0, 4), 10) || undefined : undefined,
					venue: readString(value, "venue"),
					publicationType: readString(value, "type"),
					identifiers: { doi, openCitationsId: id },
					links: [{ url: `https://doi.org/${doi}`, kind: "doi" }],
					citationCount: Number.parseInt(readString(value, "citation_count") ?? "", 10) || undefined,
					provenance: [
						{
							provider: "opencitations",
							query: options.query,
							retrievedAt,
							providerRecordId: id,
							rawUrl: url.href,
						},
					],
					mergedFrom: [],
				}),
			];
		})
		.filter((record) => passesFilters(record, options.filters));
	return { provider: "opencitations", query: options.query, records, total: records.length, requestUrl: url.href };
}

export async function searchUnpaywallPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	if (options.cursor) throw new Error("Unpaywall DOI lookup does not support pagination");
	const doi = doiOnlyQuery(options.query, "Unpaywall");
	const email = options.unpaywallEmail ?? providerCredentials.unpaywallEmail ?? process.env.UNPAYWALL_EMAIL;
	if (!email) throw new Error("UNPAYWALL_EMAIL is required for the Unpaywall provider");
	const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
	url.searchParams.set("email", email);
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Unpaywall", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || typeof payload.title !== "string")
		throw new Error("Unpaywall returned an unexpected payload");
	const retrievedAt = new Date().toISOString();
	const links: PaperLink[] = [{ url: `https://doi.org/${doi}`, kind: "doi" }];
	for (const location of [payload.best_oa_location, payload.first_oa_location]) {
		if (!isRecord(location)) continue;
		const landing = readString(location, "url_for_landing_page");
		const pdf = readString(location, "url_for_pdf");
		if (landing && !links.some((link) => link.url === landing))
			links.push({ url: landing, kind: "landing", openAccess: true });
		if (pdf && !links.some((link) => link.url === pdf)) links.push({ url: pdf, kind: "pdf", openAccess: true });
	}
	const authors = Array.isArray(payload.z_authors)
		? payload.z_authors.flatMap((author) => {
				if (!isRecord(author)) return [];
				const name = [readString(author, "given"), readString(author, "family")].filter(Boolean).join(" ");
				return name ? [name] : [];
			})
		: [];
	const record = withId({
		title: payload.title,
		authors,
		year: readNumber(payload, "year"),
		venue: readString(payload, "journal_name"),
		publicationType: readString(payload, "genre"),
		identifiers: { doi },
		links,
		provenance: [
			{
				provider: "unpaywall",
				query: options.query,
				retrievedAt,
				providerRecordId: doi,
				rawUrl: `${url.origin}${url.pathname}?email=[redacted]`,
			},
		],
		mergedFrom: [],
	});
	return {
		provider: "unpaywall",
		query: options.query,
		records: passesFilters(record, options.filters) ? [record] : [],
		total: 1,
		requestUrl: `${url.origin}${url.pathname}?email=[redacted]`,
	};
}

export interface LiteratureProviderDefinition {
	id: LiteratureProvider;
	label: string;
	description: string;
	queryMode: "search" | "doi-enrichment";
	requiresEnvironmentVariable?: string;
	search(options: ProviderSearchOptions): Promise<ProviderPage>;
}

export const literatureProviderDefinitions: readonly LiteratureProviderDefinition[] = [
	{
		id: "arxiv",
		label: "arXiv",
		description: "Open preprints and public PDFs",
		queryMode: "search",
		search: searchArxivPage,
	},
	{
		id: "openalex",
		label: "OpenAlex",
		description: "Broad scholarly graph and citations",
		queryMode: "search",
		search: searchOpenAlexPage,
	},
	{
		id: "crossref",
		label: "Crossref",
		description: "DOI registration metadata",
		queryMode: "search",
		search: searchCrossrefPage,
	},
	{
		id: "semanticscholar",
		label: "Semantic Scholar",
		description: "Scholarly search and citation graph",
		queryMode: "search",
		search: searchSemanticScholarPage,
	},
	{
		id: "dblp",
		label: "DBLP",
		description: "Computer science bibliography",
		queryMode: "search",
		search: searchDblpPage,
	},
	{
		id: "pubmed",
		label: "PubMed",
		description: "Biomedical literature",
		queryMode: "search",
		search: searchPubmedPage,
	},
	{
		id: "core",
		label: "CORE",
		description: "Open-access aggregator",
		queryMode: "search",
		requiresEnvironmentVariable: "CORE_API_KEY",
		search: searchCorePage,
	},
	{
		id: "opencitations",
		label: "OpenCitations",
		description: "DOI metadata and citation enrichment",
		queryMode: "doi-enrichment",
		search: searchOpenCitationsPage,
	},
	{
		id: "unpaywall",
		label: "Unpaywall",
		description: "Open-access locations by DOI",
		queryMode: "doi-enrichment",
		requiresEnvironmentVariable: "UNPAYWALL_EMAIL",
		search: searchUnpaywallPage,
	},
	{
		id: "exa",
		label: "Exa",
		description: "Neural web and academic search via Exa MCP (no API key)",
		queryMode: "search",
		search: searchExaPage,
	},
] as const;

const literatureProviderRegistry = new Map(
	literatureProviderDefinitions.map((definition) => [definition.id, definition]),
);

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

/** 来自 config.json 的 provider 凭据; 优先级: 调用参数 > 配置文件 > 环境变量 */
let providerCredentials: {
	semanticScholarApiKey?: string;
	pubmedApiKey?: string;
	coreApiKey?: string;
	exaApiKey?: string;
	unpaywallEmail?: string;
	openAlexMailto?: string;
	crossrefPoliteEmail?: string;
	ncbiEmail?: string;
} = {};

export function setProviderCredentials(credentials: typeof providerCredentials): void {
	providerCredentials = credentials ?? {};
}

async function exaMCPCall(
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			// 可选: 设置 EXA_API_KEY 环境变量走自有配额; 未设置则匿名(配额较低)
			...(providerCredentials.exaApiKey ?? process.env.EXA_API_KEY ? { "x-api-key": providerCredentials.exaApiKey ?? process.env.EXA_API_KEY } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Exa", response);
	const raw = await response.text();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data: ")) continue;
		try {
			const payload = JSON.parse(line.slice(6)) as {
				result?: Record<string, unknown>;
				error?: { message?: string };
			};
			if (payload.error) throw new Error(`Exa MCP error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
			if (payload.result !== undefined) return payload.result;
		} catch (error) {
			if (error instanceof SyntaxError) continue; // 跳过非 JSON 的 SSE 行
			throw error;
		}
	}
	throw new Error("Exa MCP returned no result");
}

function parseExaResults(text: string): Array<{ title: string; url: string; published?: string; author?: string; highlights?: string }> {
	const chunks = text.split(/\r?\n(?=Title: )/);
	const results: Array<{ title: string; url: string; published?: string; author?: string; highlights?: string }> = [];
	for (const chunk of chunks) {
		const title = /^Title: (.*)$/m.exec(chunk)?.[1]?.trim();
		const url = /^URL: (.*)$/m.exec(chunk)?.[1]?.trim();
		if (!title || !url) continue;
		if (!/^https?:\/\//i.test(url)) continue;
		const published = /^Published: (.*)$/m.exec(chunk)?.[1]?.trim();
		const author = /^Author: (.*)$/m.exec(chunk)?.[1]?.trim();
		const highlights = chunk.split(/^Highlights:/m)[1]?.trim().slice(0, 2_000);
		results.push({
			title,
			url,
			...(published && published !== "N/A" ? { published } : {}),
			...(author && author !== "N/A" ? { author } : {}),
			...(highlights ? { highlights } : {}),
		});
	}
	return results;
}

export async function searchExaPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	try {
		await exaMCPCall(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "paper-agent", version: "0.2" },
			},
			options.signal,
		);
	} catch {
		// 部分部署无需 initialize; 失败忽略, 后续 tools/call 会暴露真实错误。
	}
	const numResults = Math.min(Math.max(options.limit, 1), 10);
	const result = await exaMCPCall(
		"tools/call",
		{
			name: "web_search_exa",
			arguments: { query: options.query, numResults },
		},
		options.signal,
	);
	const content = result.content;
	const text = Array.isArray(content)
		? content.map((entry) => (entry && typeof entry === "object" ? String((entry as { text?: unknown }).text ?? "") : "")).join("\n")
		: "";
	const retrievedAt = new Date().toISOString();
	const records = parseExaResults(text)
		.map((entry) => {
			const year = entry.published ? Number.parseInt(entry.published.slice(0, 4), 10) : undefined;
			const links: PaperLink[] = [{ url: entry.url, kind: "landing" }];
			// arXiv URL(abs/html/pdf) → 生成可下载的 pdf 链接(kind: pdf), 让下载流程可用
			const arxivMatch =
				/(?:arxiv\.org\/(?:abs|html|pdf)\/|export\.arxiv\.org\/pdf\/)(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(
					entry.url,
				);
			if (arxivMatch) {
				links[0].openAccess = true;
				links.push({
					url: `https://arxiv.org/pdf/${arxivMatch[1]}.pdf`,
					kind: "pdf",
					openAccess: true,
				});
			} else if (entry.url.endsWith(".pdf") || entry.url.includes(".pdf?")) {
				links[0].openAccess = true;
				links.push({ url: entry.url, kind: "pdf", openAccess: true });
			}
			return withId({
				title: entry.title,
				...(entry.highlights ? { abstract: entry.highlights } : {}),
				authors: entry.author ? [entry.author] : [],
				...(Number.isInteger(year) && year ? { year } : {}),
				publicationType: "unknown",
				identifiers: {},
				links,
				provenance: [
					{
						provider: "exa",
						query: options.query,
						retrievedAt,
						providerRecordId: entry.url,
						rawUrl: entry.url,
					},
				],
				mergedFrom: [],
			});
		})
		.filter((record) => passesFilters(record, options.filters));
	return {
		provider: "exa",
		query: options.query,
		records,
		nextCursor: undefined,
		requestUrl: EXA_MCP_URL,
	};
}

export function searchProviderPage(
	provider: LiteratureProvider,
	options: ProviderSearchOptions,
): Promise<ProviderPage> {
	const definition = literatureProviderRegistry.get(provider);
	if (!definition) throw new Error(`Unknown literature provider: ${provider}`);
	return definition.search(options);
}

export async function fetchOpenAlexWorks(
	ids: string[],
	options: Pick<ProviderSearchOptions, "signal" | "fetcher" | "openAlexMailto"> & { queryLabel: string },
): Promise<PaperRecord[]> {
	if (ids.length === 0) return [];
	const normalized = [
		...new Set(
			ids
				.map((id) =>
					id
						.replace(/^https:\/\/openalex\.org\//i, "")
						.trim()
						.toUpperCase(),
				)
				.filter((id) => /^W\d+$/.test(id)),
		),
	];
	const records: PaperRecord[] = [];
	for (let offset = 0; offset < normalized.length; offset += 50) {
		const batch = normalized.slice(offset, offset + 50);
		const url = new URL("https://api.openalex.org/works");
		url.searchParams.set("filter", `ids.openalex:${batch.join("|")}`);
		url.searchParams.set("per-page", String(batch.length));
		if (options.openAlexMailto) url.searchParams.set("mailto", options.openAlexMailto);
		const response = await fetchWithRetry(url, {
			signal: options.signal,
			timeoutMs: 20_000,
			init: { headers: { Accept: "application/json" } },
			fetcher: options.fetcher,
		});
		if (!response.ok) throw new LiteratureProviderHttpError("OpenAlex", response);
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.results)) {
			throw new Error("OpenAlex returned an unexpected payload");
		}
		const retrievedAt = new Date().toISOString();
		records.push(
			...payload.results
				.map((value) => openAlexRecord(value, options.queryLabel, url.href, retrievedAt))
				.filter((record): record is PaperRecord => Boolean(record)),
		);
	}
	return records;
}

export async function searchOpenAlexCitations(
	workId: string,
	options: Pick<ProviderSearchOptions, "signal" | "fetcher" | "openAlexMailto"> & {
		limit: number;
		cursor?: string;
		queryLabel: string;
	},
): Promise<ProviderPage> {
	const normalized = workId.replace(/^https:\/\/openalex\.org\//i, "");
	if (!/^W\d+$/i.test(normalized)) throw new Error("Citation expansion requires an OpenAlex work id");
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("filter", `cites:${normalized}`);
	url.searchParams.set("per-page", String(options.limit));
	url.searchParams.set("cursor", options.cursor ?? "*");
	if (options.openAlexMailto) url.searchParams.set("mailto", options.openAlexMailto);
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("OpenAlex", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.results))
		throw new Error("OpenAlex returned an unexpected payload");
	const retrievedAt = new Date().toISOString();
	const records = payload.results
		.map((value) => openAlexRecord(value, options.queryLabel, url.href, retrievedAt))
		.filter((record): record is PaperRecord => Boolean(record));
	const meta = isRecord(payload.meta) ? payload.meta : undefined;
	return {
		provider: "openalex",
		query: options.queryLabel,
		records,
		nextCursor: meta ? readString(meta, "next_cursor") : undefined,
		total: meta ? readNumber(meta, "count") : undefined,
		requestUrl: url.href,
	};
}
