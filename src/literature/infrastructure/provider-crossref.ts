import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeDoi, paperPdfUrl } from "../domain/literature-identifiers.ts";
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

function crossrefRecord(
	value: unknown,
	query: string,
	requestUrl: string,
	retrievedAt: string,
): PaperRecord | undefined {
	if (!isRecord(value)) return undefined;
	const title = firstString(value.title);
	const doi = normalizeDoi(readString(value, "DOI"));
	const landing = readString(value, "URL") ?? (doi ? `https://doi.org/${doi}` : undefined);
	if (!title || !landing) return undefined;
	const links: PaperLink[] = [{ url: landing, kind: doi ? "doi" : "landing" }];
	if (Array.isArray(value.link)) {
		for (const link of value.link) {
			if (!isRecord(link)) continue;
			const href = readString(link, "URL");
			const type = readString(link, "content-type");
			if (href) {
				const kind =
					type?.toLowerCase().includes("pdf") || paperPdfUrl({ url: href, kind: "other" }) ? "pdf" : "other";
				links.push({ url: href, kind, openAccess: false });
			}
		}
	}
	return withId({
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
				query,
				retrievedAt,
				providerRecordId: doi,
				rawUrl: requestUrl,
			},
		],
		mergedFrom: [],
	});
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
		timeoutMs: 10_000,
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
		.map((value) => crossrefRecord(value, options.query, url.href, retrievedAt))
		.filter((record): record is PaperRecord => Boolean(record))
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

export async function searchCrossrefByDoi(
	doi: string,
	options: Pick<ProviderSearchOptions, "signal" | "fetcher">,
): Promise<PaperRecord | undefined> {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) throw new Error("Crossref DOI lookup requires a valid DOI");
	const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(normalizedDoi)}`);
	const crossrefMailto = providerCredentials.crossrefPoliteEmail ?? process.env.CROSSREF_POLITE_EMAIL;
	if (crossrefMailto) url.searchParams.set("mailto", crossrefMailto);
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 10_000,
		init: { headers: { Accept: "application/json" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Crossref", response);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.message)) throw new Error("Crossref returned an unexpected DOI payload");
	const record = crossrefRecord(payload.message, normalizedDoi, url.href, new Date().toISOString());
	return record?.identifiers.doi === normalizedDoi ? record : undefined;
}
