import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import {
	mergePaperMetadataConflicts,
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
}

export interface DoiEnrichmentResult {
	records: PaperRecord[];
	attempts: DoiEnrichmentAttempt[];
	warnings: DoiEnrichmentWarning[];
	skippedWithoutDoi: number;
	skippedComplete: number;
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
): Promise<{ record: PaperRecord; attempts: DoiEnrichmentAttempt[]; warnings: DoiEnrichmentWarning[] }> {
	const doi = normalizeDoi(record.identifiers.doi);
	if (!doi) return { record, attempts: [], warnings: [] };
	let enriched = withCanonicalPaperLinks(record);
	const attempts: DoiEnrichmentAttempt[] = [];
	const warnings: DoiEnrichmentWarning[] = [];
	for (const provider of providers) {
		if (!paperNeedsDoiProvider(enriched, provider)) continue;
		try {
			const candidate = await lookup(provider, doi, options);
			if (!candidate) {
				const message = "No exact DOI record was found";
				attempts.push({ recordId: record.id, doi, provider, status: "not-found", message });
				warnings.push({ recordId: record.id, doi, provider, message });
				continue;
			}
			if (normalizeDoi(candidate.identifiers.doi) !== doi) {
				throw new Error("Provider returned a record with a different or missing DOI");
			}
			enriched = mergeMissingPaperMetadata(enriched, candidate);
			attempts.push({ recordId: record.id, doi, provider, status: "matched" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			attempts.push({ recordId: record.id, doi, provider, status: "failed", message });
			warnings.push({ recordId: record.id, doi, provider, message });
		}
	}
	return { record: enriched, attempts, warnings };
}

export async function enrichRecordsByDoi(
	records: PaperRecord[],
	projectRoot: string,
	options: { signal?: AbortSignal; concurrency?: number; lookup?: DoiProviderLookup } = {},
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
				if (!configured.providers.some((provider) => paperNeedsDoiProvider(item.record, provider))) {
					output[item.index] = withCanonicalPaperLinks(item.record);
					skippedComplete++;
					continue;
				}
				const result = await enrichRecord(
					item.record,
					configured.providers,
					lookupOptions(projectRoot, options.signal),
					options.lookup ?? enrichProviderByDoi,
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
