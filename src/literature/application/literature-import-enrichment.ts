import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import { normalizeArxivId, normalizeDoi, normalizeTitle } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord, SearchFilters } from "../domain/literature-types.ts";
import {
	aclAnthologyFiltersForRecord,
	enrichProviderByDoi,
	type LiteratureProviderDefinition,
	literatureProviderDefinitions,
	searchProviderPage,
} from "../infrastructure/literature-providers.ts";
import { type DoiProviderLookup, enrichRecordsByDoi, mergeMissingPaperMetadata } from "./literature-doi-enrichment.ts";
import type { PdfMetadataWarning } from "./literature-import-contracts.ts";

export type ProviderSearcher = typeof searchProviderPage;

export interface RequiredPdfMetadataRecovery {
	record?: PaperRecord;
	warnings: PdfMetadataWarning[];
	matchedProvider?: LiteratureProvider;
}

function normalizedAuthor(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

function authorsOverlap(left: string[], right: string[]): boolean {
	const normalizedRight = new Set(right.map(normalizedAuthor).filter(Boolean));
	return left.some((author) => normalizedRight.has(normalizedAuthor(author)));
}

function exactIdentifierMatch(left: PaperRecord, right: PaperRecord): boolean {
	if (left.identifiers.doi && normalizeDoi(left.identifiers.doi) === normalizeDoi(right.identifiers.doi)) return true;
	if (
		left.identifiers.arxivId &&
		normalizeArxivId(left.identifiers.arxivId) === normalizeArxivId(right.identifiers.arxivId)
	) {
		return true;
	}
	return ["openAlexId", "semanticScholarId", "dblpKey", "coreId", "openCitationsId"].some((key) => {
		const identifier = key as keyof PaperRecord["identifiers"];
		return Boolean(left.identifiers[identifier] && left.identifiers[identifier] === right.identifiers[identifier]);
	});
}

function providerMatch(local: PaperRecord, candidate: PaperRecord): boolean {
	if (exactIdentifierMatch(local, candidate)) return true;
	return (
		normalizeTitle(local.title) === normalizeTitle(candidate.title) &&
		authorsOverlap(local.authors, candidate.authors)
	);
}

export async function recoverRequiredPdfMetadataByDoi(
	doi: string,
	projectRoot: string,
	signal?: AbortSignal,
	lookup: DoiProviderLookup = enrichProviderByDoi,
): Promise<RequiredPdfMetadataRecovery> {
	const normalizedDoi = normalizeDoi(doi);
	if (!normalizedDoi) return { warnings: [] };
	const config = loadPaperAgentConfigSync(projectRoot);
	const definitions = new Map(literatureProviderDefinitions.map((definition) => [definition.id, definition]));
	const warnings: PdfMetadataWarning[] = [];
	for (const configuredProvider of config.search.doiEnrichmentProviders) {
		const provider = configuredProvider as LiteratureProvider;
		const definition = definitions.get(provider);
		if (!definition?.capabilities.includes("doi-enrichment") || !definition.lookupByDoi) continue;
		try {
			const candidate = await lookup(provider, normalizedDoi, {
				signal,
				semanticScholarApiKey: config.credentials?.semanticScholarApiKey,
				unpaywallEmail: config.credentials?.unpaywallEmail,
				openAlexMailto: config.credentials?.openAlexMailto,
			});
			if (!candidate) {
				warnings.push({ stage: "provider", provider, message: "No exact DOI record was found" });
				continue;
			}
			if (normalizeDoi(candidate.identifiers.doi) !== normalizedDoi) {
				throw new Error("Provider returned a record with a different or missing DOI");
			}
			if (candidate.title.trim() && candidate.authors.length > 0) {
				return { record: candidate, warnings, matchedProvider: provider };
			}
			warnings.push({ stage: "provider", provider, message: "Exact DOI record is missing a title or authors" });
		} catch (error) {
			warnings.push({
				stage: "provider",
				provider,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { warnings };
}

export async function enrichImportedPdfRecord(
	record: PaperRecord,
	projectRoot: string,
	signal?: AbortSignal,
	searcher: ProviderSearcher = searchProviderPage,
	doiLookup?: DoiProviderLookup,
): Promise<{ record: PaperRecord; warnings: PdfMetadataWarning[]; matchedProviders: LiteratureProvider[] }> {
	const config = loadPaperAgentConfigSync(projectRoot);
	const enabled = new Set(config.search.providers);
	const selected: Array<{ definition: LiteratureProviderDefinition; filters?: SearchFilters }> = [];
	for (const definition of literatureProviderDefinitions) {
		if (!enabled.has(definition.id) || !definition.capabilities.includes("keyword-search")) continue;
		if (definition.id !== "acl_anthology") selected.push({ definition });
		else {
			const filters = aclAnthologyFiltersForRecord(record);
			if (filters) selected.push({ definition, filters });
		}
	}
	const query = `${record.title} ${record.authors[0]}`.trim();
	const settled = await Promise.allSettled(
		selected.map(async ({ definition, filters }) => ({
			definition,
			page: await searcher(definition.id, {
				query,
				limit: 5,
				filters,
				signal,
			}),
		})),
	);
	const warnings: PdfMetadataWarning[] = [];
	const matchedProviders: LiteratureProvider[] = [];
	let enriched = record;
	for (let index = 0; index < settled.length; index++) {
		const result = settled[index];
		const provider = selected[index].definition.id;
		if (result.status === "rejected") {
			warnings.push({
				stage: "provider",
				provider,
				message: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
			continue;
		}
		const match = result.value.page.records.find((candidate) => providerMatch(record, candidate));
		if (!match) continue;
		enriched = mergeMissingPaperMetadata(enriched, match);
		matchedProviders.push(provider);
	}
	const doiResult = await enrichRecordsByDoi([enriched], projectRoot, { signal, lookup: doiLookup });
	for (const warning of doiResult.warnings) {
		const provider = literatureProviderDefinitions.find((definition) => definition.id === warning.provider)?.id;
		warnings.push({
			stage: "provider",
			provider,
			message: provider ? warning.message : `${warning.provider}: ${warning.message}`,
		});
	}
	for (const attempt of doiResult.attempts) {
		if (attempt.status === "matched" && !matchedProviders.includes(attempt.provider)) {
			matchedProviders.push(attempt.provider);
		}
	}
	return { record: doiResult.records[0], warnings, matchedProviders };
}
