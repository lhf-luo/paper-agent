import { decodeEntities, readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { type Fetcher, fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeArxivId, normalizeDoi, normalizeTitle } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord } from "../domain/literature-types.ts";
import {
	extractXmlTag,
	extractXmlTags,
	isRecord,
	LiteratureProviderHttpError,
	providerCredentials,
	readNumber,
	readString,
	withId,
} from "./provider-common.ts";
import { openAlexRecord } from "./provider-openalex.ts";
import { semanticScholarRecord } from "./provider-semantic-scholar.ts";

export type AuthorPaperProvider = Extract<LiteratureProvider, "openalex" | "semanticscholar" | "dblp">;

export interface AuthorSourceResult {
	provider: AuthorPaperProvider;
	status: "succeeded" | "partial" | "unresolved";
	authorId?: string;
	profileUrl?: string;
	records: PaperRecord[];
	total?: number;
	truncated: boolean;
	message?: string;
}

export interface AuthorSourceOptions {
	seed: PaperRecord;
	authorName: string;
	limit: number;
	yearFrom?: number;
	yearTo?: number;
	signal?: AbortSignal;
	fetcher?: Fetcher;
}

function normalizedAuthor(value: string): string {
	const parts = value
		.trim()
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const ordered = parts.length === 2 ? `${parts[1]} ${parts[0]}` : value;
	return ordered
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function sameAuthorName(left: string, right: string): boolean {
	return Boolean(normalizedAuthor(left) && normalizedAuthor(left) === normalizedAuthor(right));
}

export function isSeedWork(seed: PaperRecord, candidate: PaperRecord, authorName: string): boolean {
	if (!candidate.authors.some((name) => sameAuthorName(name, authorName))) return false;
	const seedDoi = normalizeDoi(seed.identifiers.doi);
	const candidateDoi = normalizeDoi(candidate.identifiers.doi);
	if (seedDoi && candidateDoi && seedDoi !== candidateDoi) return false;
	const seedArxiv = normalizeArxivId(seed.identifiers.arxivId);
	const candidateArxiv = normalizeArxivId(candidate.identifiers.arxivId);
	if (seedArxiv && candidateArxiv && seedArxiv !== candidateArxiv) return false;
	if (seedDoi && candidateDoi === seedDoi) return true;
	if (seedArxiv && candidateArxiv === seedArxiv) return true;
	if (
		seed.identifiers.openAlexId &&
		seed.identifiers.openAlexId.toLowerCase() === candidate.identifiers.openAlexId?.toLowerCase()
	)
		return true;
	if (
		seed.identifiers.semanticScholarId &&
		seed.identifiers.semanticScholarId.toLowerCase() === candidate.identifiers.semanticScholarId?.toLowerCase()
	)
		return true;
	if (seed.identifiers.dblpKey && seed.identifiers.dblpKey === candidate.identifiers.dblpKey) return true;
	return Boolean(normalizeTitle(seed.title) && normalizeTitle(seed.title) === normalizeTitle(candidate.title));
}

async function request(
	url: URL,
	provider: AuthorPaperProvider,
	options: AuthorSourceOptions,
	accept: string,
): Promise<Response | undefined> {
	const headers: Record<string, string> = { Accept: accept };
	if (provider === "semanticscholar") {
		const key = providerCredentials.semanticScholarApiKey ?? process.env.S2_API_KEY;
		if (key) headers["x-api-key"] = key;
	}
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		fetcher: options.fetcher,
		init: { headers },
		maxRetries: 1,
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new LiteratureProviderHttpError(provider, response);
	return response;
}

async function jsonRequest(url: URL, provider: AuthorPaperProvider, options: AuthorSourceOptions): Promise<unknown> {
	const response = await request(url, provider, options, "application/json");
	return response ? response.json() : undefined;
}

function openAlexWorkId(value: string | undefined): string | undefined {
	const id = value?.replace(/^https:\/\/openalex\.org\//i, "").toUpperCase();
	return id && /^W\d+$/.test(id) ? id : undefined;
}

function openAlexAuthorId(value: string | undefined): string | undefined {
	const id = value?.replace(/^https:\/\/openalex\.org\//i, "").toUpperCase();
	return id && /^A\d+$/.test(id) ? id : undefined;
}

function openAlexUrl(path = "works"): URL {
	const url = new URL(`https://api.openalex.org/${path}`);
	const mailto = providerCredentials.openAlexMailto ?? process.env.OPENALEX_MAILTO;
	if (mailto) url.searchParams.set("mailto", mailto);
	return url;
}

function openAlexWork(value: unknown, options: AuthorSourceOptions, url: URL): PaperRecord | undefined {
	return openAlexRecord(value, `author:${options.authorName}`, url.href, new Date().toISOString());
}

async function resolveOpenAlex(options: AuthorSourceOptions): Promise<{ id: string; profileUrl: string } | undefined> {
	const seed = options.seed;
	const workId = openAlexWorkId(seed.identifiers.openAlexId);
	const doi = normalizeDoi(seed.identifiers.doi);
	let candidates: unknown[] = [];
	let requestUrl: URL;
	if (workId) {
		requestUrl = openAlexUrl(`works/${workId}`);
		const work = await jsonRequest(requestUrl, "openalex", options);
		if (work) candidates = [work];
	} else {
		requestUrl = openAlexUrl();
		requestUrl.searchParams.set("per-page", doi ? "2" : "20");
		if (doi) requestUrl.searchParams.set("filter", `doi:${doi}`);
		else requestUrl.searchParams.set("search", seed.title);
		const payload = await jsonRequest(requestUrl, "openalex", options);
		if (!isRecord(payload) || !Array.isArray(payload.results)) {
			if (payload === undefined) return undefined;
			throw new Error("OpenAlex returned an unexpected author seed response");
		}
		candidates = payload.results;
	}
	const matched = candidates.flatMap((value) => {
		const record = openAlexWork(value, options, requestUrl);
		if (!record || !isSeedWork(seed, record, options.authorName) || !isRecord(value)) return [];
		const authorships = Array.isArray(value.authorships) ? value.authorships : [];
		return authorships.flatMap((authorship) => {
			if (!isRecord(authorship) || !isRecord(authorship.author)) return [];
			const name = readString(authorship.author, "display_name") ?? readString(authorship, "raw_author_name");
			const id = openAlexAuthorId(readString(authorship.author, "id"));
			return name && id && sameAuthorName(name, options.authorName)
				? [{ id, profileUrl: `https://openalex.org/${id}` }]
				: [];
		});
	});
	const ids = [...new Set(matched.map((value) => value.id))];
	return ids.length === 1 ? matched[0] : undefined;
}

async function searchOpenAlexAuthor(options: AuthorSourceOptions): Promise<AuthorSourceResult> {
	const provider = "openalex";
	const author = await resolveOpenAlex(options);
	if (!author)
		return {
			provider,
			status: "unresolved",
			records: [],
			truncated: false,
			message: "Seed work or author identity could not be confirmed",
		};
	const records: PaperRecord[] = [];
	let cursor: string | undefined = "*";
	let total: number | undefined;
	let warning: string | undefined;
	while (cursor && records.length < options.limit) {
		try {
			const url = openAlexUrl();
			const filters = [`author.id:${author.id}`];
			if (options.yearFrom) filters.push(`from_publication_date:${options.yearFrom}-01-01`);
			if (options.yearTo) filters.push(`to_publication_date:${options.yearTo}-12-31`);
			url.searchParams.set("filter", filters.join(","));
			url.searchParams.set("per-page", String(Math.min(100, options.limit - records.length)));
			url.searchParams.set("cursor", cursor);
			const payload = await jsonRequest(url, provider, options);
			if (!isRecord(payload) || !Array.isArray(payload.results))
				throw new Error("OpenAlex returned an unexpected author works response");
			const page = payload.results.flatMap((value) => {
				const record = openAlexWork(value, options, url);
				return record ? [record] : [];
			});
			records.push(...page);
			const meta = isRecord(payload.meta) ? payload.meta : undefined;
			total = meta ? readNumber(meta, "count") : total;
			const next = meta ? readString(meta, "next_cursor") : undefined;
			cursor = page.length && next && next !== cursor ? next : undefined;
		} catch (error) {
			if (!records.length) throw error;
			warning = error instanceof Error ? error.message : String(error);
			break;
		}
	}
	return {
		provider,
		status: warning ? "partial" : "succeeded",
		authorId: author.id,
		profileUrl: author.profileUrl,
		records,
		total,
		truncated: Boolean(warning || cursor || (total !== undefined && total > records.length)),
		message: warning,
	};
}

function semanticPaperId(value: string | undefined): string | undefined {
	return value && /^[A-Za-z0-9]{1,100}$/.test(value) ? value : undefined;
}

function semanticUrl(path: string): URL {
	return new URL(`https://api.semanticscholar.org/graph/v1/${path}`);
}

async function resolveSemanticScholar(
	options: AuthorSourceOptions,
): Promise<{ id: string; profileUrl: string } | undefined> {
	const seed = options.seed;
	const paperId = semanticPaperId(seed.identifiers.semanticScholarId);
	const doi = normalizeDoi(seed.identifiers.doi);
	let candidates: unknown[] = [];
	let url: URL;
	if (paperId || doi) {
		url = semanticUrl(`paper/${paperId ?? `DOI:${encodeURIComponent(doi ?? "")}`}`);
		url.searchParams.set("fields", "paperId,title,authors,externalIds");
		const paper = await jsonRequest(url, "semanticscholar", options);
		if (paper) candidates = [paper];
	} else {
		url = semanticUrl("paper/search");
		url.searchParams.set("query", seed.title);
		url.searchParams.set("limit", "20");
		url.searchParams.set("fields", "paperId,title,authors,externalIds");
		const payload = await jsonRequest(url, "semanticscholar", options);
		if (!isRecord(payload) || !Array.isArray(payload.data))
			throw new Error("Semantic Scholar returned an unexpected author seed response");
		candidates = payload.data;
	}
	const matched = candidates.flatMap((value) => {
		const record = semanticScholarRecord(value, `author:${options.authorName}`, url.href, new Date().toISOString());
		if (!record || !isSeedWork(seed, record, options.authorName) || !isRecord(value)) return [];
		const authors = Array.isArray(value.authors) ? value.authors : [];
		return authors.flatMap((author) => {
			if (!isRecord(author)) return [];
			const name = readString(author, "name");
			const id = readString(author, "authorId");
			return name && id && /^\d+$/.test(id) && sameAuthorName(name, options.authorName)
				? [{ id, profileUrl: `https://www.semanticscholar.org/author/${id}` }]
				: [];
		});
	});
	const ids = [...new Set(matched.map((value) => value.id))];
	return ids.length === 1 ? matched[0] : undefined;
}

async function searchSemanticAuthor(options: AuthorSourceOptions): Promise<AuthorSourceResult> {
	const provider = "semanticscholar";
	const author = await resolveSemanticScholar(options);
	if (!author)
		return {
			provider,
			status: "unresolved",
			records: [],
			truncated: false,
			message: "Seed work or author identity could not be confirmed",
		};
	const records: PaperRecord[] = [];
	let offset = 0;
	let next: number | undefined = 0;
	let warning: string | undefined;
	while (next !== undefined && records.length < options.limit) {
		try {
			const url = semanticUrl(`author/${author.id}/papers`);
			url.searchParams.set(
				"fields",
				"paperId,title,abstract,authors,year,venue,publicationTypes,externalIds,url,openAccessPdf,citationCount",
			);
			url.searchParams.set("offset", String(offset));
			url.searchParams.set("limit", String(Math.min(100, options.limit - records.length)));
			if (options.yearFrom || options.yearTo)
				url.searchParams.set("publicationDateOrYear", `${options.yearFrom ?? ""}:${options.yearTo ?? ""}`);
			const payload = await jsonRequest(url, provider, options);
			if (!isRecord(payload) || !Array.isArray(payload.data))
				throw new Error("Semantic Scholar returned an unexpected author works response");
			const page = payload.data.flatMap((value) => {
				const record = semanticScholarRecord(
					value,
					`author:${options.authorName}`,
					url.href,
					new Date().toISOString(),
				);
				return record ? [record] : [];
			});
			records.push(...page);
			const candidate = readNumber(payload, "next");
			next = page.length && candidate !== undefined && candidate > offset ? candidate : undefined;
			offset = next ?? offset;
		} catch (error) {
			if (!records.length) throw error;
			warning = error instanceof Error ? error.message : String(error);
			break;
		}
	}
	return {
		provider,
		status: warning ? "partial" : "succeeded",
		authorId: author.id,
		profileUrl: author.profileUrl,
		records,
		truncated: Boolean(warning || next !== undefined),
		message: warning,
	};
}

function xmlAttribute(value: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}="([^"]+)"`, "i").exec(value);
	return match ? decodeEntities(match[1]) : undefined;
}

function dblpRecord(
	xml: string,
	tag: string,
	attrs: string,
	authorName: string,
	requestUrl: string,
): PaperRecord | undefined {
	const key = xmlAttribute(attrs, "key");
	const title = extractXmlTag(xml, "title");
	if (!key || !title) return undefined;
	const ee = extractXmlTags(xml, "ee");
	const doi = normalizeDoi(extractXmlTag(xml, "doi")) ?? ee.map(normalizeDoi).find(Boolean);
	const links: PaperRecord["links"] = [{ url: `https://dblp.org/rec/${key}`, kind: "landing" }];
	for (const url of ee) links.push({ url, kind: /\.pdf(?:[?#]|$)/i.test(url) ? "pdf" : "other" });
	if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
	return withId({
		title,
		authors: extractXmlTags(xml, "author"),
		year: Number.parseInt(extractXmlTag(xml, "year") ?? "", 10) || undefined,
		venue: extractXmlTag(xml, "booktitle") ?? extractXmlTag(xml, "journal"),
		publicationType: tag,
		identifiers: { doi, dblpKey: key },
		links,
		provenance: [
			{
				provider: "dblp",
				query: `author:${authorName}`,
				retrievedAt: new Date().toISOString(),
				providerRecordId: key,
				rawUrl: requestUrl,
			},
		],
		mergedFrom: [],
	});
}

export function parseDblpPersonXml(xml: string, authorName: string, requestUrl: string): PaperRecord[] {
	const records: PaperRecord[] = [];
	const pattern = /<(article|inproceedings|book|incollection|phdthesis|mastersthesis)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
	for (const match of xml.matchAll(pattern)) {
		const record = dblpRecord(match[3], match[1], match[2], authorName, requestUrl);
		if (record) records.push(record);
	}
	return records;
}

async function searchDblpAuthor(options: AuthorSourceOptions): Promise<AuthorSourceResult> {
	const provider = "dblp";
	const url = new URL("https://dblp.org/search/author/api");
	url.searchParams.set("q", options.authorName);
	url.searchParams.set("h", "10");
	url.searchParams.set("format", "json");
	const payload = await jsonRequest(url, provider, options);
	if (!isRecord(payload) || !isRecord(payload.result) || !isRecord(payload.result.hits))
		throw new Error("DBLP returned an unexpected author search response");
	const rawHits = payload.result.hits.hit;
	const hits = Array.isArray(rawHits) ? rawHits : rawHits ? [rawHits] : [];
	const matchingProfiles: Array<{ id: string; profileUrl: string; records: PaperRecord[] }> = [];
	for (const hit of hits) {
		if (!isRecord(hit) || !isRecord(hit.info)) continue;
		const displayName = readString(hit.info, "author")?.replace(/\s+\d{4}$/, "") ?? "";
		const profileUrl = readString(hit.info, "url") ?? "";
		const pid = /^https:\/\/dblp\.org\/pid\/([A-Za-z0-9/_-]+)\/?$/.exec(profileUrl)?.[1];
		if (!pid || !sameAuthorName(displayName, options.authorName)) continue;
		const personUrl = new URL(`https://dblp.org/pid/${pid}.xml`);
		const response = await request(personUrl, provider, options, "application/xml");
		if (!response) continue;
		const xml = (await readResponseBody(response, 8_000_000)).toString("utf8");
		const records = parseDblpPersonXml(xml, options.authorName, personUrl.href);
		if (records.some((record) => isSeedWork(options.seed, record, options.authorName))) {
			matchingProfiles.push({ id: pid, profileUrl: `https://dblp.org/pid/${pid}`, records });
		}
	}
	if (matchingProfiles.length !== 1)
		return {
			provider,
			status: "unresolved",
			records: [],
			truncated: false,
			message: matchingProfiles.length
				? "Multiple DBLP author profiles contain the seed work"
				: "Seed work was not found in a matching DBLP author profile",
		};
	const profile = matchingProfiles[0];
	const eligible = profile.records.filter(
		(record) =>
			(options.yearFrom === undefined || (record.year !== undefined && record.year >= options.yearFrom)) &&
			(options.yearTo === undefined || (record.year !== undefined && record.year <= options.yearTo)),
	);
	return {
		provider,
		status: "succeeded",
		authorId: profile.id,
		profileUrl: profile.profileUrl,
		records: eligible.slice(0, options.limit),
		total: eligible.length,
		truncated: eligible.length > options.limit,
	};
}

export function findAuthorSourcePapers(
	provider: AuthorPaperProvider,
	options: AuthorSourceOptions,
): Promise<AuthorSourceResult> {
	if (provider === "openalex") return searchOpenAlexAuthor(options);
	if (provider === "semanticscholar") return searchSemanticAuthor(options);
	return searchDblpAuthor(options);
}
