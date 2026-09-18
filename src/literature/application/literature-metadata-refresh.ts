import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import { normalizeArxivId, normalizeDoi, sameTitleAndFirstAuthor } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord, SearchFilters } from "../domain/literature-types.ts";
import {
	aclAnthologyFiltersForRecord,
	type LiteratureProviderDefinition,
	literatureProviderDefinitions,
	searchProviderPage,
} from "../infrastructure/literature-providers.ts";
import {
	type DoiProviderLookup,
	enrichRecordsByDoi,
	mergeMissingPaperMetadata,
	mergeRefreshedPaperMetadata,
} from "./literature-doi-enrichment.ts";

export type MetadataProviderSearcher = typeof searchProviderPage;

export interface MetadataRefreshWarning {
	provider: string;
	message: string;
	code?: "identity-conflict";
}

export interface MetadataRefreshResult {
	record: PaperRecord;
	matchedProviders: LiteratureProvider[];
	warnings: MetadataRefreshWarning[];
	hadMatch: boolean;
	identityConflict: boolean;
}

export interface MetadataRefreshDiff {
	filledFields: string[];
	replacedFields: string[];
	changed: boolean;
}

const DIFF_FIELDS: Array<{ name: string; read: (record: PaperRecord) => unknown }> = [
	{ name: "title", read: (record) => record.title },
	{ name: "authors", read: (record) => record.authors },
	{ name: "abstract", read: (record) => record.abstract },
	{ name: "year", read: (record) => record.year },
	{ name: "venue", read: (record) => record.venue },
	{ name: "venueRank", read: (record) => record.venueRank },
	{ name: "publicationType", read: (record) => record.publicationType },
	{ name: "citationCount", read: (record) => record.citationCount },
	{ name: "referencedWorks", read: (record) => record.referencedWorks },
	{ name: "citedByApiUrl", read: (record) => record.citedByApiUrl },
	{ name: "doi", read: (record) => record.identifiers.doi },
	{ name: "arxivId", read: (record) => record.identifiers.arxivId },
	{ name: "openAlexId", read: (record) => record.identifiers.openAlexId },
	{ name: "semanticScholarId", read: (record) => record.identifiers.semanticScholarId },
	{ name: "dblpKey", read: (record) => record.identifiers.dblpKey },
	{ name: "coreId", read: (record) => record.identifiers.coreId },
	{ name: "openCitationsId", read: (record) => record.identifiers.openCitationsId },
	{ name: "links", read: (record) => record.links },
	{ name: "provenance", read: (record) => record.provenance },
	{ name: "metadataConflicts", read: (record) => record.metadataConflicts },
];

function emptyMetadataValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "string" && !value.trim()) ||
		(Array.isArray(value) && value.length === 0) ||
		(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)
	);
}

export function metadataRefreshDiff(before: PaperRecord, after: PaperRecord): MetadataRefreshDiff {
	const filledFields: string[] = [];
	const replacedFields: string[] = [];
	for (const field of DIFF_FIELDS) {
		const previous = field.read(before);
		const next = field.read(after);
		if (JSON.stringify(previous) === JSON.stringify(next)) continue;
		if (emptyMetadataValue(previous) && !emptyMetadataValue(next)) filledFields.push(field.name);
		else replacedFields.push(field.name);
	}
	return { filledFields, replacedFields, changed: Boolean(filledFields.length || replacedFields.length) };
}

function primaryIdentifiersConflict(left: PaperRecord, right: PaperRecord): boolean {
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	if (leftDoi && rightDoi && leftDoi !== rightDoi) return true;
	const leftArxiv = normalizeArxivId(left.identifiers.arxivId);
	const rightArxiv = normalizeArxivId(right.identifiers.arxivId);
	return Boolean(leftArxiv && rightArxiv && leftArxiv !== rightArxiv);
}

function sameStableIdentifier(left: PaperRecord, right: PaperRecord): boolean {
	if (primaryIdentifiersConflict(left, right)) return false;
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	if (leftDoi && leftDoi === rightDoi) return true;
	const leftArxiv = normalizeArxivId(left.identifiers.arxivId);
	const rightArxiv = normalizeArxivId(right.identifiers.arxivId);
	if (leftArxiv && leftArxiv === rightArxiv) return true;
	return ["openAlexId", "semanticScholarId", "dblpKey", "coreId", "openCitationsId"].some((key) => {
		const field = key as keyof PaperRecord["identifiers"];
		return Boolean(
			left.identifiers[field] &&
				right.identifiers[field] &&
				left.identifiers[field]?.toLowerCase() === right.identifiers[field]?.toLowerCase(),
		);
	});
}

function keywordProviders(projectRoot: string, record: PaperRecord): Array<{
	definition: LiteratureProviderDefinition;
	filters?: SearchFilters;
}> {
	const enabled = new Set(loadPaperAgentConfigSync(projectRoot).search.providers);
	const byId = new Map(literatureProviderDefinitions.map((definition) => [definition.id, definition]));
	const selected: Array<{ definition: LiteratureProviderDefinition; filters?: SearchFilters }> = [];
	for (const id of enabled) {
		const definition = byId.get(id as LiteratureProvider);
		if (!definition?.capabilities.includes("keyword-search")) continue;
		if (definition.id !== "acl_anthology") selected.push({ definition });
		else {
			const filters = aclAnthologyFiltersForRecord(record);
			if (filters) selected.push({ definition, filters });
		}
	}
	return selected;
}

export async function refreshPersonalPaperMetadata(
	record: PaperRecord,
	projectRoot: string,
	options: {
		signal?: AbortSignal;
		searcher?: MetadataProviderSearcher;
		doiLookup?: DoiProviderLookup;
	} = {},
): Promise<MetadataRefreshResult> {
	if (normalizeDoi(record.identifiers.doi)) {
		const enriched = await enrichRecordsByDoi([record], projectRoot, {
			signal: options.signal,
			lookup: options.doiLookup,
			refreshExisting: true,
			refreshIdentityFields: true,
		});
		return {
			record: enriched.records[0],
			matchedProviders: enriched.attempts
				.filter((attempt) => attempt.status === "matched")
				.map((attempt) => attempt.provider),
			warnings: enriched.warnings.map((warning) => ({
				provider: warning.provider,
				message: warning.message,
				code: warning.code,
			})),
			hadMatch: enriched.attempts.some((attempt) => attempt.status === "matched"),
			identityConflict: enriched.warnings.some((warning) => warning.code === "identity-conflict"),
		};
	}

	const selected = keywordProviders(projectRoot, record);
	const query = `${record.title} ${record.authors[0] ?? ""}`.trim();
	const settled = await Promise.allSettled(
		selected.map(async ({ definition, filters }) => ({
			definition,
			page: await (options.searcher ?? searchProviderPage)(definition.id, {
				query,
				limit: 5,
				filters,
				signal: options.signal,
			}),
		})),
	);
	const warnings: MetadataRefreshWarning[] = [];
	const matchedProviders: LiteratureProvider[] = [];
	const candidates: PaperRecord[] = [];
	let identityAnchor = record;
	let refreshIdentityFields = false;
	for (let index = 0; index < settled.length; index++) {
		const provider = selected[index].definition.id;
		const result = settled[index];
		if (result.status === "rejected") {
			warnings.push({
				provider,
				message: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
			continue;
		}
		const exactCandidates = result.value.page.records.filter((value) => sameTitleAndFirstAuthor(identityAnchor, value));
		const conflictingCandidates = exactCandidates.filter((value) => primaryIdentifiersConflict(identityAnchor, value));
		if (conflictingCandidates.length) {
			warnings.push({
				provider,
				message: "Exact title and first-author candidate has a conflicting DOI or arXiv ID",
				code: "identity-conflict",
			});
		}
		const candidate = exactCandidates.find((value) => !primaryIdentifiersConflict(identityAnchor, value));
		if (!candidate) continue;
		refreshIdentityFields ||= sameStableIdentifier(record, candidate);
		candidates.push(candidate);
		matchedProviders.push(provider);
		identityAnchor = mergeMissingPaperMetadata(identityAnchor, candidate);
	}
	if (!candidates.length) {
		return {
			record,
			matchedProviders,
			warnings,
			hadMatch: false,
			identityConflict: warnings.some((warning) => warning.code === "identity-conflict"),
		};
	}

	const keywordRecord = mergeRefreshedPaperMetadata(record, candidates, { refreshIdentityFields });
	if (!normalizeDoi(keywordRecord.identifiers.doi)) {
		return {
			record: keywordRecord,
			matchedProviders,
			warnings,
			hadMatch: true,
			identityConflict: warnings.some((warning) => warning.code === "identity-conflict"),
		};
	}
	const doiResult = await enrichRecordsByDoi([keywordRecord], projectRoot, {
		signal: options.signal,
		lookup: options.doiLookup,
		refreshExisting: true,
		refreshIdentityFields,
	});
	for (const attempt of doiResult.attempts) {
		if (attempt.status === "matched" && !matchedProviders.includes(attempt.provider)) {
			matchedProviders.push(attempt.provider);
		}
	}
	warnings.push(
		...doiResult.warnings.map((warning) => ({
			provider: warning.provider,
			message: warning.message,
			code: warning.code,
		})),
	);
	return {
		record: doiResult.records[0],
		matchedProviders,
		warnings,
		hadMatch: true,
		identityConflict: warnings.some((warning) => warning.code === "identity-conflict"),
	};
}
