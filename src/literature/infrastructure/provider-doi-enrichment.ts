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
		timeoutMs: 10_000,
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
		timeoutMs: 10_000,
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
