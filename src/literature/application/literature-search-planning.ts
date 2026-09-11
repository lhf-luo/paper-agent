import type { OperationAuthorization, OperationPlan } from "../../shared/application/operation-consent.ts";
import { sha256Text } from "../domain/literature-identifiers.ts";
import type {
	CitationExpansionTableRow,
	LiteratureSearchPlan,
	PaperDiscoveryPath,
	PaperRecord,
	SearchFilters,
	SearchRun,
} from "../domain/literature-types.ts";
import { buildCandidatePaperTable, expandLiteratureQueries, uniqueQueries } from "./literature-query-planning.ts";
import type { LiteratureStore } from "./literature-store.ts";

function uniqueTerms(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value?.trim().replace(/\s+/g, " ");
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function inferTimeRange(filters: SearchFilters): string | undefined {
	if (filters.yearFrom && filters.yearTo) return `${filters.yearFrom}-${filters.yearTo}`;
	if (filters.yearFrom) return `${filters.yearFrom}-present`;
	if (filters.yearTo) return `up to ${filters.yearTo}`;
	return undefined;
}

export function planLiteratureSearch(input: {
	researchObject?: string;
	researchProblem?: string;
	scenario?: string;
	timeRange?: string;
	domainTerms?: string[];
	problemTerms?: string[];
	methodTerms?: string[];
	primaryQuery?: string;
	explicitQueryVariants?: string[];
	filters?: SearchFilters;
}): LiteratureSearchPlan {
	const researchObject = input.researchObject?.trim();
	const researchProblem = input.researchProblem?.trim();
	const scenario = input.scenario?.trim();
	const timeRange = input.timeRange?.trim() || inferTimeRange(input.filters ?? {});
	const primaryQuery = input.primaryQuery?.trim();
	const domain = uniqueTerms([researchObject, ...(input.domainTerms ?? [])]);
	const problem = uniqueTerms([researchProblem, ...(input.problemTerms ?? [])]);
	const method = uniqueTerms(input.methodTerms ?? []);
	const researchQuestion =
		[researchObject, researchProblem, scenario, timeRange].filter(Boolean).join(" | ") ||
		primaryQuery ||
		"unspecified literature search";
	const generatedPrimary =
		primaryQuery || uniqueTerms([...domain, ...problem, ...method]).join(" ") || researchQuestion;
	const queryVariants = generatedPrimary
		? expandLiteratureQueries(generatedPrimary, input.explicitQueryVariants ?? [])
		: uniqueQueries(input.explicitQueryVariants ?? []);
	return {
		researchQuestion,
		researchObject,
		researchProblem,
		scenario,
		timeRange,
		keywordGroups: { domain, problem, method },
		queryVariants,
		unsupportedProviders: [
			{
				provider: "google-scholar",
				reason:
					"Google Scholar is not exposed by a stable first-party API in this project; do not claim it was searched.",
				suggestedAlternatives: ["openalex", "semanticscholar", "crossref", "dblp"],
			},
		],
		notes: [
			"Search metadata is discovery evidence only; open primary papers or official artifacts for claims.",
			"Venue prestige can prioritize reading but must not replace topical relevance.",
		],
	};
}

export function expansionPathRelationship(path: PaperDiscoveryPath): "reference" | "citation" | undefined {
	if (path.kind === "reference-expansion") return "reference";
	if (path.kind === "citation-expansion") return "citation";
	return undefined;
}

function expansionPathDepth(path: PaperDiscoveryPath): string {
	return /^depth=\d+$/.test(path.note ?? "") ? (path.note ?? "").slice("depth=".length) : "unknown";
}

export function buildCitationExpansionTable(records: PaperRecord[]): CitationExpansionTableRow[] {
	const rows: CitationExpansionTableRow[] = [];
	for (const record of records) {
		const base = buildCandidatePaperTable([record])[0];
		for (const path of record.discoveryPaths ?? []) {
			const relationship = expansionPathRelationship(path);
			if (!relationship || !path.seedPaperId) continue;
			rows.push({
				...base,
				seedPaperId: path.seedPaperId,
				relationship,
				depth: expansionPathDepth(path),
			});
		}
	}
	return rows;
}

export function searchRunSelectionPlan(
	source: LiteratureStore,
	target: LiteratureStore,
	run: SearchRun,
	records: PaperRecord[],
	contributor: string,
): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "personal-corpus-write",
		summary: `Save ${normalized.length} selected search result(s) into personal corpus ${target.namespace}`,
		actor: contributor,
		targets: [
			{ label: "source-search-run", value: run.id, risk: "low" },
			{ label: "target-corpus", value: target.root, risk: "medium" },
			...normalized.map((record) => ({
				label: record.title.slice(0, 120),
				value: record.id,
				risk: "medium" as const,
			})),
		],
		details: {
			sourcePath: source.root,
			targetPath: target.root,
			sourceScope: source.scope,
			sourceNamespace: source.namespace,
			targetNamespace: target.namespace,
			searchRunId: run.id,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
		},
	};
}

export async function saveSearchRunSelection(
	source: LiteratureStore,
	target: LiteratureStore,
	searchRunId: string,
	paperIds: string[] | undefined,
	authorization: OperationAuthorization,
	contributor: string,
	collectionId?: string,
	preparedRecords?: PaperRecord[],
): Promise<{
	searchRun: SearchRun;
	selected: PaperRecord[];
	missingPaperIds: string[];
	outcomes: Array<{ record: PaperRecord; status?: "created" | "updated" | "unchanged"; error?: string }>;
}> {
	const run = await source.getSearchRun(searchRunId);
	if (!run) throw new Error(`Search run not found in source corpus: ${searchRunId}`);
	const wanted = paperIds?.length ? new Set(paperIds) : undefined;
	const sourceSelected = wanted ? run.results.filter((record) => wanted.has(record.id)) : run.results;
	const selected = preparedRecords ?? sourceSelected;
	const sourceIds = new Set(sourceSelected.map((record) => record.id));
	if (selected.some((record) => !sourceIds.has(record.id)) || selected.length !== sourceSelected.length) {
		throw new Error("Prepared records do not match the selected search-run records");
	}
	const present = new Set(selected.map((record) => record.id));
	const missingPaperIds = paperIds?.filter((id) => !present.has(id)) ?? [];
	const plan = searchRunSelectionPlan(source, target, run, selected, contributor);
	await authorization.manager.consume(authorization.grant, plan);
	// 若指定了分类, 将选中的记录设置到该分类(不覆盖已有分类, 而是追加)。
	const toSave = collectionId
		? selected.map((record) => ({
				...record,
				collectionIds: Array.from(new Set([...(record.collectionIds ?? []), collectionId])),
			}))
		: selected;
	const outcomes = await target.upsertPapers(toSave);
	return { searchRun: run, selected, missingPaperIds, outcomes };
}

export async function collectCitationPages(
	loadPage: (limit: number, cursor?: string) => Promise<{ records: PaperRecord[]; nextCursor?: string }>,
	maxRecords: number,
	maxPages: number,
): Promise<PaperRecord[]> {
	const records: PaperRecord[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages && records.length < maxRecords; page++) {
		const result = await loadPage(Math.min(100, maxRecords - records.length), cursor);
		records.push(...result.records.slice(0, maxRecords - records.length));
		if (!result.nextCursor || result.nextCursor === cursor) break;
		cursor = result.nextCursor;
	}
	return records;
}
