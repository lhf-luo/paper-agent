import { decodeEntities } from "../../shared/infrastructure/network-content.ts";
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
		timeoutMs: 10_000,
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
