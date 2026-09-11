import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeDoi } from "../domain/literature-identifiers.ts";
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
	// 优先用 best_oa_location 的开放获取 PDF(主站可能需登录, 如 IEEE 论文常有 arXiv 开放版)。
	if (isRecord(work.best_oa_location)) {
		const oaPdf = readString(work.best_oa_location, "pdf_url");
		const oaLanding = readString(work.best_oa_location, "landing_page_url");
		if (oaPdf && !links.some((link) => link.url === oaPdf)) {
			links.push({ url: oaPdf, kind: "pdf", openAccess: true });
		}
		if (oaLanding && !links.some((link) => link.url === oaLanding)) {
			links.push({ url: oaLanding, kind: "landing", openAccess: true });
		}
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
		timeoutMs: 10_000,
		maxRetries: 1,
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

/**
 * 按 DOI 查单个 OpenAlex work, 返回带 openAlexId + referencedWorks 的 PaperRecord。
 * 用于给种子论文补全 OpenAlex 元数据, 使引用/被引扩展能走 OpenAlex(而非 Semantic Scholar)。
 */
export async function searchOpenAlexByDoi(
	doi: string,
	options: Pick<ProviderSearchOptions, "signal" | "fetcher" | "openAlexMailto"> & { queryLabel: string },
): Promise<PaperRecord | undefined> {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new Error("OpenAlex DOI lookup requires a valid DOI");
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("filter", `doi:${normalizedDoi}`);
	url.searchParams.set("per-page", "1");
	if (options.openAlexMailto) url.searchParams.set("mailto", options.openAlexMailto);
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) return undefined;
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.results)) return undefined;
	const value = payload.results[0];
	if (!value) return undefined;
	const record = openAlexRecord(value, options.queryLabel, url.href, new Date().toISOString());
	return record?.identifiers.doi === normalizedDoi ? record : undefined;
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
			timeoutMs: 10_000,
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
		timeoutMs: 10_000,
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
