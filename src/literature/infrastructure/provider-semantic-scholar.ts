import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeArxivId, normalizeDoi } from "../domain/literature-identifiers.ts";
import type { PaperLink, PaperRecord, ProviderPage } from "../domain/literature-types.ts";
import {
	isRecord,
	LiteratureProviderHttpError,
	type ProviderSearchOptions,
	passesFilters,
	providerCredentials,
	readNumber,
	readString,
	withId,
} from "./provider-common.ts";

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
	const limit = Math.min(options.limit, 100);
	url.searchParams.set("query", options.query);
	url.searchParams.set("limit", String(limit));
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
		timeoutMs: 10_000,
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
				: offset + limit < (total ?? offset + limit)
					? String(offset + limit)
					: undefined,
		total,
		requestUrl: url.href,
	};
}

export async function searchSemanticScholarByDoi(
	doi: string,
	options: Pick<ProviderSearchOptions, "fetcher" | "semanticScholarApiKey" | "signal">,
): Promise<PaperRecord | undefined> {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new Error("Semantic Scholar DOI lookup requires a valid DOI");
	const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(normalizedDoi)}`);
	url.searchParams.set(
		"fields",
		"paperId,title,abstract,authors,year,venue,publicationTypes,externalIds,url,openAccessPdf,citationCount",
	);
	const headers: Record<string, string> = { Accept: "application/json" };
	const apiKey = options.semanticScholarApiKey ?? providerCredentials.semanticScholarApiKey ?? process.env.S2_API_KEY;
	if (apiKey) headers["x-api-key"] = apiKey;
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		init: { headers },
		fetcher: options.fetcher,
		baseDelayMs: 1_000,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Semantic Scholar", response);
	const payload: unknown = await response.json();
	const record = semanticScholarRecord(payload, normalizedDoi, url.href, new Date().toISOString());
	return record?.identifiers.doi === normalizedDoi ? record : undefined;
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
		timeoutMs: 10_000,
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
