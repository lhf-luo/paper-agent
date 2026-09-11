import { decodeEntities, htmlToText } from "../../shared/infrastructure/network-content.ts";
import { fetchWithRetry } from "../../shared/infrastructure/network-security.ts";
import { normalizeDoi } from "../domain/literature-identifiers.ts";
import type { PaperLink, PaperRecord, ProviderFailure, ProviderPage } from "../domain/literature-types.ts";
import {
	LiteratureProviderHttpError,
	passesFilters,
	providerFailureFromError,
	type ProviderSearchOptions,
	withId,
} from "./provider-common.ts";

const USENIX_ORIGIN = "https://www.usenix.org";
const DETAIL_LIMIT = 10;
const DETAIL_CONCURRENCY = 2;

function htmlAttribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
	return match?.[2] ? decodeEntities(match[2].trim()) : undefined;
}

function metaValues(html: string, name: string): string[] {
	const result: string[] = [];
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const key = htmlAttribute(match[0], "name") ?? htmlAttribute(match[0], "property");
		if (key?.toLowerCase() !== name.toLowerCase()) continue;
		const content = htmlAttribute(match[0], "content");
		if (content) result.push(content.replace(/[{}]/g, "").replace(/\s+/g, " ").trim());
	}
	return result;
}

function presentationLinks(html: string): string[] {
	const result: string[] = [];
	for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
		const href = htmlAttribute(match[0], "href");
		if (!href) continue;
		try {
			const url = new URL(href, USENIX_ORIGIN);
			if (
				url.hostname === "www.usenix.org" &&
				/^\/conference\/[^/]+\/presentation\/[^/]+\/?$/i.test(url.pathname) &&
				!result.includes(url.href)
			) {
				result.push(url.href);
			}
		} catch {
			// Ignore malformed links on the remote search page.
		}
	}
	return result;
}

function conferenceRecordId(url: URL): string {
	return /^\/conference\/([^/]+)\/presentation\/([^/]+)/i.exec(url.pathname)?.slice(1).join("/") ?? url.pathname;
}

function publicationYear(url: URL, date: string | undefined): number | undefined {
	const explicit = /\b(?:19|20)\d{2}\b/.exec(date ?? "")?.[0];
	if (explicit) return Number(explicit);
	const short = /^\/conference\/[a-z-]+(\d{2})\//i.exec(url.pathname)?.[1];
	return short ? Number(`20${short}`) : undefined;
}

function abstractText(html: string): string | undefined {
	const metadata = metaValues(html, "citation_abstract")[0];
	if (metadata) return metadata;
	const start = html.search(/class=["'][^"']*field-name-field-paper-description[^"']*["']/i);
	if (start < 0) return undefined;
	const tail = html.slice(start);
	const end = tail.search(/class=["'][^"']*field-name-field-paper-people[^"']*["']/i);
	const text = htmlToText(end < 0 ? tail.slice(0, 20_000) : tail.slice(0, end));
	return text || undefined;
}

function artifactLinks(html: string, paperDoi: string | undefined): PaperLink[] {
	const result: PaperLink[] = [];
	for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
		const href = htmlAttribute(match[0], "href");
		if (!href) continue;
		try {
			const url = new URL(href, USENIX_ORIGIN);
			const host = url.hostname.toLowerCase().replace(/^www\./, "");
			if (!["github.com", "gitlab.com", "zenodo.org", "figshare.com", "doi.org"].includes(host)) continue;
			if (paperDoi && url.href === `https://doi.org/${paperDoi}`) continue;
			if (!result.some((item) => item.url === url.href)) {
				result.push({ url: url.href, kind: "artifact", openAccess: true });
			}
		} catch {
			// Ignore malformed external links.
		}
	}
	return result;
}

function recordFromHtml(html: string, pageUrl: string, query: string, retrievedAt: string): PaperRecord | undefined {
	const url = new URL(pageUrl);
	const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
	const title = metaValues(html, "citation_title")[0] ?? htmlToText(heading);
	if (!title) return undefined;
	const authors = metaValues(html, "citation_author");
	const publicationDate = metaValues(html, "citation_publication_date")[0];
	const venue = metaValues(html, "citation_conference_title")[0];
	const doi = normalizeDoi(metaValues(html, "citation_doi")[0]);
	const pdfMeta = metaValues(html, "citation_pdf_url")[0];
	const pdfHref =
		pdfMeta ??
		[...html.matchAll(/<a\b[^>]*>/gi)]
			.map((match) => htmlAttribute(match[0], "href"))
			.find((href) => href && /\.pdf(?:[?#]|$)/i.test(href));
	const links: PaperLink[] = [{ url: pageUrl, kind: "landing" }];
	if (pdfHref) links.push({ url: new URL(pdfHref, pageUrl).href, kind: "pdf", openAccess: true });
	if (doi) links.push({ url: `https://doi.org/${doi}`, kind: "doi" });
	links.push(...artifactLinks(html, doi));
	return withId({
		title,
		abstract: abstractText(html),
		authors,
		year: publicationYear(url, publicationDate),
		venue,
		publicationType: "conference paper",
		identifiers: { doi },
		links,
		provenance: [{ provider: "usenix", query, retrievedAt, providerRecordId: conferenceRecordId(url), rawUrl: pageUrl }],
		mergedFrom: [],
	});
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function searchUsenixPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	const page = Number.parseInt(options.cursor ?? "0", 10);
	if (!Number.isInteger(page) || page < 0) throw new Error("Invalid USENIX search cursor");
	const url = new URL(`/search/site/${encodeURIComponent(options.query.trim())}`, USENIX_ORIGIN);
	if (page) url.searchParams.set("page", String(page));
	const response = await fetchWithRetry(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		init: { headers: { Accept: "text/html" } },
		fetcher: options.fetcher,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("USENIX", response);
	const searchHtml = await response.text();
	if (!/<html\b/i.test(searchHtml) && !/<(?:ol|form)\b[^>]*(?:search-results|search-form)/i.test(searchHtml)) {
		throw new Error("USENIX returned an unexpected search payload");
	}
	const urls = presentationLinks(searchHtml).slice(0, Math.min(options.limit, DETAIL_LIMIT));
	const retrievedAt = new Date().toISOString();
	const failures: ProviderFailure[] = [];
	const records = (
		await mapConcurrent(urls, DETAIL_CONCURRENCY, async (presentationUrl) => {
			try {
				const detailResponse = await fetchWithRetry(new URL(presentationUrl), {
					signal: options.signal,
					timeoutMs: 20_000,
					init: { headers: { Accept: "text/html" } },
					fetcher: options.fetcher,
				});
				if (!detailResponse.ok) throw new LiteratureProviderHttpError("USENIX", detailResponse);
				const record = recordFromHtml(await detailResponse.text(), presentationUrl, options.query, retrievedAt);
				if (!record) throw new Error(`USENIX detail page has no paper title: ${presentationUrl}`);
				return passesFilters(record, options.filters) ? record : undefined;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				const failure = providerFailureFromError("usenix", options.query, error);
				failures.push({ ...failure, message: `${presentationUrl}: ${failure.message}` });
				return undefined;
			}
		})
	).filter((record): record is PaperRecord => Boolean(record));
	if (urls.length > 0 && records.length === 0 && failures.length === urls.length) {
		throw new Error(`USENIX could not read any paper detail page: ${failures[0].message}`);
	}
	return {
		provider: "usenix",
		query: options.query,
		records,
		nextCursor: /class=["'][^"']*pager-next[^"']*["']/i.test(searchHtml) ? String(page + 1) : undefined,
		requestUrl: url.href,
		failures: failures.length ? failures : undefined,
	};
}
