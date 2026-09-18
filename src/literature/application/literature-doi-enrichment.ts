import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import {
	mergePaperMetadataConflicts,
	normalizeArxivId,
	normalizeDoi,
	uniquePaperLinks,
	withCanonicalPaperLinks,
} from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord } from "../domain/literature-types.ts";
import {
	enrichProviderByDoi,
	literatureProviderDefinitions,
	type ProviderDoiLookupOptions,
} from "../infrastructure/literature-providers.ts";

export type DoiProviderLookup = typeof enrichProviderByDoi;

export interface DoiEnrichmentAttempt {
	recordId: string;
	doi: string;
	provider: LiteratureProvider;
	status: "matched" | "not-found" | "failed";
	message?: string;
}

export interface DoiEnrichmentWarning {
	recordId?: string;
	doi?: string;
	provider: string;
	message: string;
	code?: "identity-conflict";
}

export interface DoiEnrichmentResult {
	records: PaperRecord[];
	attempts: DoiEnrichmentAttempt[];
	warnings: DoiEnrichmentWarning[];
	skippedWithoutDoi: number;
	skippedComplete: number;
}

export interface DoiEnrichmentOptions {
	signal?: AbortSignal;
	concurrency?: number;
	lookup?: DoiProviderLookup;
	refreshExisting?: boolean;
	refreshIdentityFields?: boolean;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const itemKey = key(value);
		if (seen.has(itemKey)) return false;
		seen.add(itemKey);
		return true;
	});
}

export function mergeMissingPaperMetadata(record: PaperRecord, candidate: PaperRecord): PaperRecord {
	return {
		...record,
		abstract: record.abstract?.trim() ? record.abstract : candidate.abstract,
		year: record.year ?? candidate.year,
		venue: record.venue?.trim() ? record.venue : candidate.venue,
		venueRank: record.venueRank ?? candidate.venueRank,
		publicationType: record.publicationType?.trim() ? record.publicationType : candidate.publicationType,
		metadataConflicts: mergePaperMetadataConflicts(record, candidate),
		identifiers: {
			doi: record.identifiers.doi ?? candidate.identifiers.doi,
			arxivId: record.identifiers.arxivId ?? candidate.identifiers.arxivId,
			openAlexId: record.identifiers.openAlexId ?? candidate.identifiers.openAlexId,
			semanticScholarId: record.identifiers.semanticScholarId ?? candidate.identifiers.semanticScholarId,
			dblpKey: record.identifiers.dblpKey ?? candidate.identifiers.dblpKey,
			coreId: record.identifiers.coreId ?? candidate.identifiers.coreId,
			openCitationsId: record.identifiers.openCitationsId ?? candidate.identifiers.openCitationsId,
		},
		links: uniquePaperLinks([...record.links, ...candidate.links]),
		citationCount: record.citationCount ?? candidate.citationCount,
		referencedWorks: record.referencedWorks ?? candidate.referencedWorks,
		citedByApiUrl: record.citedByApiUrl ?? candidate.citedByApiUrl,
		provenance: uniqueBy(
			[...record.provenance, ...candidate.provenance],
			(item) => `${item.provider}\u0000${item.providerRecordId ?? ""}\u0000${item.rawUrl ?? ""}`,
		),
	};
}

type RefreshField =
	| "title"
	| "authors"
	| "abstract"
	| "year"
	| "venue"
	| "venueRank"
	| "publicationType"
	| "citationCount"
	| "referencedWorks"
	| "citedByApiUrl"
	| keyof PaperRecord["identifiers"];

function usefulValue(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return Boolean(value.trim());
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

function fieldValue(record: PaperRecord, field: RefreshField): string | number | string[] | undefined {
	if (field in record.identifiers) return record.identifiers[field as keyof PaperRecord["identifiers"]];
	const value = record[field as keyof PaperRecord];
	return typeof value === "string" || typeof value === "number" || Array.isArray(value)
		? (value as string | number | string[])
		: undefined;
}

function normalizedValue(value: string | number | string[]): string {
	if (Array.isArray(value)) return JSON.stringify(value.map((item) => item.trim().toLowerCase()));
	return typeof value === "string" ? value.trim().toLowerCase() : String(value);
}

function addRefreshConflicts(
	base: PaperRecord["metadataConflicts"],
	records: PaperRecord[],
	fields: RefreshField[],
): PaperRecord["metadataConflicts"] {
	const conflicts = structuredClone(base ?? {});
	const add = (field: RefreshField, value: string | number | string[], sources: string[]) => {
		const bucket = conflicts[field] ?? [];
		const existing = bucket.find((entry) => normalizedValue(entry.value) === normalizedValue(value));
		if (existing) existing.sources = [...new Set([...existing.sources, ...sources])];
		else bucket.push({ value: Array.isArray(value) ? [...value] : value, sources: [...sources] });
		conflicts[field] = bucket;
	};
	for (const record of records) {
		for (const field of fields) {
			for (const item of record.metadataConflicts?.[field] ?? []) add(field, item.value, item.sources);
		}
	}
	for (const field of fields) {
		const values = records
			.map((record) => ({ value: fieldValue(record, field), sources: metadataSources(record) }))
			.filter((item): item is { value: string | number | string[]; sources: string[] } => usefulValue(item.value));
		if (new Set(values.map((item) => normalizedValue(item.value))).size < 2) continue;
		for (const item of values) add(field, item.value, item.sources);
	}
	return Object.keys(conflicts).length ? conflicts : undefined;
}

function metadataSources(record: PaperRecord): string[] {
	return [...new Set(record.provenance.map((item) => item.provider))];
}

function firstValue<T>(candidates: PaperRecord[], read: (candidate: PaperRecord) => T | undefined): T | undefined {
	for (const candidate of candidates) {
		const value = read(candidate);
		if (usefulValue(value)) return value;
	}
	return undefined;
}

/** Refreshes provider-owned metadata while preserving personal curation and stable paper identity. */
export function mergeRefreshedPaperMetadata(
	record: PaperRecord,
	candidates: PaperRecord[],
	options: { refreshIdentityFields?: boolean } = {},
): PaperRecord {
	if (!candidates.length) return withCanonicalPaperLinks(record);
	const refreshIdentity = options.refreshIdentityFields === true;
	const title = refreshIdentity ? firstValue(candidates, (candidate) => candidate.title) ?? record.title : record.title;
	const authors = refreshIdentity
		? firstValue(candidates, (candidate) => candidate.authors) ?? record.authors
		: record.authors.length
			? record.authors
			: firstValue(candidates, (candidate) => candidate.authors) ?? record.authors;
	const identifiers = {
		doi: record.identifiers.doi ?? firstValue(candidates, (candidate) => candidate.identifiers.doi),
		arxivId: record.identifiers.arxivId ?? firstValue(candidates, (candidate) => candidate.identifiers.arxivId),
		openAlexId: firstValue(candidates, (candidate) => candidate.identifiers.openAlexId) ?? record.identifiers.openAlexId,
		semanticScholarId:
			firstValue(candidates, (candidate) => candidate.identifiers.semanticScholarId) ??
			record.identifiers.semanticScholarId,
		dblpKey: firstValue(candidates, (candidate) => candidate.identifiers.dblpKey) ?? record.identifiers.dblpKey,
		coreId: firstValue(candidates, (candidate) => candidate.identifiers.coreId) ?? record.identifiers.coreId,
		openCitationsId:
			firstValue(candidates, (candidate) => candidate.identifiers.openCitationsId) ??
			record.identifiers.openCitationsId,
	};
	const conflictFields: RefreshField[] = [
		...(refreshIdentity ? (["title", "authors"] as const) : []),
		"abstract",
		"year",
		"venue",
		"venueRank",
		"publicationType",
		"citationCount",
		"referencedWorks",
		"citedByApiUrl",
		"doi",
		"arxivId",
		"openAlexId",
		"semanticScholarId",
		"dblpKey",
		"coreId",
		"openCitationsId",
	];
	return withCanonicalPaperLinks({
		...record,
		title,
		authors,
		abstract: firstValue(candidates, (candidate) => candidate.abstract) ?? record.abstract,
		year: firstValue(candidates, (candidate) => candidate.year) ?? record.year,
		venue: firstValue(candidates, (candidate) => candidate.venue) ?? record.venue,
		venueRank: firstValue(candidates, (candidate) => candidate.venueRank) ?? record.venueRank,
		publicationType:
			firstValue(candidates, (candidate) => candidate.publicationType) ?? record.publicationType,
		metadataConflicts: addRefreshConflicts(
			record.metadataConflicts,
			[record, ...candidates],
			conflictFields,
		),
		identifiers,
		links: uniquePaperLinks([record, ...candidates].flatMap((candidate) => candidate.links)),
		citationCount: firstValue(candidates, (candidate) => candidate.citationCount) ?? record.citationCount,
		referencedWorks:
			firstValue(candidates, (candidate) => candidate.referencedWorks) ?? record.referencedWorks,
		citedByApiUrl: firstValue(candidates, (candidate) => candidate.citedByApiUrl) ?? record.citedByApiUrl,
		provenance: uniqueBy(
			[record, ...candidates].flatMap((candidate) => candidate.provenance),
			(item) => `${item.provider}\u0000${item.providerRecordId ?? ""}\u0000${item.rawUrl ?? ""}`,
		),
	});
}

function missingBibliographicMetadata(record: PaperRecord): boolean {
	return (
		!record.abstract?.trim() || record.year === undefined || !record.venue?.trim() || !record.publicationType?.trim()
	);
}

function missingOpenAccessLocation(record: PaperRecord): boolean {
	return !record.links.some((link) => link.kind === "pdf" && link.openAccess === true);
}

export function paperNeedsDoiProvider(record: PaperRecord, provider: LiteratureProvider): boolean {
	const missingBibliographic = missingBibliographicMetadata(record);
	const missingCitations = record.citationCount === undefined;
	const missingOpenAccess = missingOpenAccessLocation(record);
	switch (provider) {
		case "crossref":
			return missingBibliographic || missingOpenAccess;
		case "openalex":
		case "semanticscholar":
			return missingBibliographic || missingCitations || missingOpenAccess;
		case "opencitations":
			return missingBibliographic || missingCitations;
		case "unpaywall":
			return missingOpenAccess;
		default:
			return false;
	}
}

function lookupOptions(projectRoot: string, signal?: AbortSignal): ProviderDoiLookupOptions {
	const credentials = loadPaperAgentConfigSync(projectRoot).credentials;
	return {
		signal,
		semanticScholarApiKey: credentials?.semanticScholarApiKey,
		unpaywallEmail: credentials?.unpaywallEmail,
		openAlexMailto: credentials?.openAlexMailto,
	};
}

function configuredProviders(projectRoot: string): {
	providers: LiteratureProvider[];
	warnings: DoiEnrichmentWarning[];
} {
	const configured = loadPaperAgentConfigSync(projectRoot).search.doiEnrichmentProviders;
	const definitions = new Map(literatureProviderDefinitions.map((definition) => [definition.id, definition]));
	const providers: LiteratureProvider[] = [];
	const warnings: DoiEnrichmentWarning[] = [];
	for (const id of configured) {
		const definition = definitions.get(id as LiteratureProvider);
		if (!definition || !definition.capabilities.includes("doi-enrichment") || !definition.lookupByDoi) {
			warnings.push({ provider: id, message: "Provider does not support DOI enrichment" });
			continue;
		}
		providers.push(definition.id);
	}
	return { providers: [...new Set(providers)], warnings };
}

async function enrichRecord(
	record: PaperRecord,
	providers: LiteratureProvider[],
	options: ProviderDoiLookupOptions,
	lookup: DoiProviderLookup,
	refreshExisting = false,
	refreshIdentityFields = false,
): Promise<{ record: PaperRecord; attempts: DoiEnrichmentAttempt[]; warnings: DoiEnrichmentWarning[] }> {
	const doi = normalizeDoi(record.identifiers.doi);
	if (!doi) return { record, attempts: [], warnings: [] };
	let enriched = refreshExisting ? record : withCanonicalPaperLinks(record);
	const candidates: PaperRecord[] = [];
	const attempts: DoiEnrichmentAttempt[] = [];
	const warnings: DoiEnrichmentWarning[] = [];
	for (const provider of providers) {
		if (!refreshExisting && !paperNeedsDoiProvider(enriched, provider)) continue;
		try {
			const candidate = await lookup(provider, doi, options);
			if (!candidate) {
				const message = "No exact DOI record was found";
				attempts.push({ recordId: record.id, doi, provider, status: "not-found", message });
				warnings.push({ recordId: record.id, doi, provider, message });
				continue;
			}
			if (normalizeDoi(candidate.identifiers.doi) !== doi) {
				const message = "Provider returned a record with a different or missing DOI";
				attempts.push({ recordId: record.id, doi, provider, status: "failed", message });
				warnings.push({ recordId: record.id, doi, provider, message, code: "identity-conflict" });
				continue;
			}
			const existingArxivId = normalizeArxivId(record.identifiers.arxivId);
			const candidateArxivId = normalizeArxivId(candidate.identifiers.arxivId);
			if (refreshExisting && existingArxivId && candidateArxivId && existingArxivId !== candidateArxivId) {
				const message = "Provider returned a record with a conflicting arXiv ID";
				attempts.push({ recordId: record.id, doi, provider, status: "failed", message });
				warnings.push({ recordId: record.id, doi, provider, message, code: "identity-conflict" });
				continue;
			}
			if (refreshExisting) candidates.push(candidate);
			else enriched = mergeMissingPaperMetadata(enriched, candidate);
			attempts.push({ recordId: record.id, doi, provider, status: "matched" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			attempts.push({ recordId: record.id, doi, provider, status: "failed", message });
			warnings.push({ recordId: record.id, doi, provider, message });
		}
	}
	if (refreshExisting) {
		enriched = mergeRefreshedPaperMetadata(enriched, candidates, { refreshIdentityFields });
	}
	return { record: enriched, attempts, warnings };
}

export async function enrichRecordsByDoi(
	records: PaperRecord[],
	projectRoot: string,
	options: DoiEnrichmentOptions = {},
): Promise<DoiEnrichmentResult> {
	const configured = configuredProviders(projectRoot);
	const output = [...records];
	const attempts: DoiEnrichmentAttempt[] = [];
	const warnings = [...configured.warnings];
	const queue = records
		.map((record, index) => ({ record, index }))
		.filter(({ record }) => normalizeDoi(record.identifiers.doi));
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, queue.length || 1));
	let skippedComplete = 0;
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (nextIndex < queue.length) {
				const item = queue[nextIndex++];
				if (
					!options.refreshExisting &&
					!configured.providers.some((provider) => paperNeedsDoiProvider(item.record, provider))
				) {
					output[item.index] = withCanonicalPaperLinks(item.record);
					skippedComplete++;
					continue;
				}
				const result = await enrichRecord(
					item.record,
					configured.providers,
					lookupOptions(projectRoot, options.signal),
					options.lookup ?? enrichProviderByDoi,
					options.refreshExisting,
					options.refreshIdentityFields,
				);
				output[item.index] = result.record;
				attempts.push(...result.attempts);
				warnings.push(...result.warnings);
			}
		}),
	);
	return {
		records: output,
		attempts,
		warnings,
		skippedWithoutDoi: records.length - queue.length,
		skippedComplete,
	};
}
