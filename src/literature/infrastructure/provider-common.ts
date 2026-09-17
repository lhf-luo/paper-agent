import { decodeEntities } from "../../shared/infrastructure/network-content.ts";
import type { Fetcher } from "../../shared/infrastructure/network-security.ts";
import { paperRecordId } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord, ProviderFailure, SearchFilters } from "../domain/literature-types.ts";

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
	unpaywallEmail?: string;
}

export interface ProviderCredentials {
	semanticScholarApiKey?: string;
	coreApiKey?: string;
	exaApiKey?: string;
	unpaywallEmail?: string;
	openAlexMailto?: string;
	crossrefPoliteEmail?: string;
}

export let providerCredentials: ProviderCredentials = {};

export function setProviderCredentials(credentials: ProviderCredentials): void {
	providerCredentials = credentials ?? {};
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

export function providerFailureFromError(provider: LiteratureProvider, query: string, error: unknown): ProviderFailure {
	const message = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof LiteratureProviderHttpError
			? error.statusCode
			: /\b([1-5]\d\d)\b/.exec(message)?.[1]
				? Number(/\b([1-5]\d\d)\b/.exec(message)?.[1])
				: undefined;
	return {
		provider,
		query,
		message,
		retryable:
			statusCode === 408 ||
			statusCode === 425 ||
			statusCode === 429 ||
			(statusCode !== undefined && statusCode >= 500) ||
			/timed?\s*out|temporar|network|fetch failed|socket hang up|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message),
		statusCode,
		rateLimited: statusCode === 429,
		retryAfter: error instanceof LiteratureProviderHttpError ? error.retryAfter : undefined,
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

// arXiv and ACL escape inline markup in titles (`&lt;i&gt;ECG&lt;/i&gt;`), so entities must be
// decoded before tags are stripped or the tags survive as literal text.
function xmlTagText(value: string): string {
	return decodeEntities(decodeEntities(value).replace(/<[^>]+>/g, " "))
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractXmlTag(xml: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
	return match ? xmlTagText(match[1]) : undefined;
}

export function extractXmlTags(xml: string, tag: string): string[] {
	const matches = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"));
	return [...matches].map((match) => xmlTagText(match[1]));
}

export function passesFilters(record: PaperRecord, filters: SearchFilters | undefined): boolean {
	if (!filters) return true;
	if (filters.yearFrom !== undefined && (record.year === undefined || record.year < filters.yearFrom)) return false;
	if (filters.yearTo !== undefined && (record.year === undefined || record.year > filters.yearTo)) return false;
	if (
		filters.venues?.length &&
		(!record.venue || !filters.venues.some((venue) => record.venue?.toLowerCase().includes(venue.toLowerCase())))
	)
		return false;
	if (
		filters.authors?.length &&
		!filters.authors.every((wanted) =>
			record.authors.some((author) => author.toLowerCase().includes(wanted.toLowerCase())),
		)
	)
		return false;
	if (
		filters.types?.length &&
		(!record.publicationType ||
			!filters.types.some((type) => record.publicationType?.toLowerCase().includes(type.toLowerCase())))
	)
		return false;
	if (filters.openAccess === true && !record.links.some((link) => link.openAccess === true))
		return false;
	return true;
}

export function withId(record: Omit<PaperRecord, "id">): PaperRecord {
	const complete = { ...record, id: "" };
	complete.id = paperRecordId(complete);
	return complete;
}
