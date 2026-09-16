import { Type } from "typebox";
import type { CollectionResult, CollectLiteratureOptions } from "../application/literature-collection.ts";
import { expandLiteratureQueries, uniqueQueries } from "../application/literature-query-planning.ts";
import { planLiteratureSearch } from "../application/literature-search-planning.ts";
import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type {
	CitationExpansionTableRow,
	CorpusScope,
	LiteratureProvider,
	PaperRecord,
	PersistenceMode,
} from "../domain/literature-types.ts";
import { modeSchema, providerSchema, scopeSchema } from "./collection-tool-schemas.ts";

export function formatPaper(record: PaperRecord, index: number): string {
	const sourceNames = [...new Set(record.provenance.map((item) => item.provider))].join(", ");
	return [
		`${String(index + 1)}. ${record.title}`,
		`   id: ${record.id}`,
		`   authors: ${record.authors.slice(0, 10).join(", ") || "unavailable"}`,
		`   year/venue: ${record.year ?? "unknown"} / ${record.venue ?? "unknown"}`,
		`   DOI/arXiv: ${record.identifiers.doi ?? "none"} / ${record.identifiers.arxivId ?? "none"}`,
		`   URL: ${paperPrimaryUrl(record) ?? "unavailable"}`,
		`   sources: ${sourceNames}`,
	].join("\n");
}

function tableCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function formatCandidateTitles(records: PaperRecord[], displayLimit: number): string[] {
	if (!records.length) return ["Candidate titles: no records"];
	return [
		"Candidate titles:",
		...records
			.slice(0, displayLimit)
			.map((record, index) => `${index + 1}. paper_id=${record.id} | title=${tableCell(record.title)}`),
	];
}

export function formatCitationExpansionTable(rows: CitationExpansionTableRow[], displayLimit: number): string[] {
	if (!rows.length) return ["Citation expansion table: no records"];
	const header = "标题 | 作者 | 年份 | venue | DOI/arXiv | 来源 | 发现路径 | 与种子关系 | 初筛结果 | PDF | 代码";
	const separator = "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---";
	return [
		"Citation expansion table:",
		header,
		separator,
		...rows
			.slice(0, displayLimit)
			.map((row) =>
				[
					row.title,
					row.authors,
					row.year,
					row.venue,
					row.doiOrArxiv,
					row.sources,
					row.discoveryPath,
					`${row.relationship}:${row.seedPaperId}:depth=${row.depth}`,
					row.screeningResult,
					row.pdf,
					row.code,
				]
					.map(tableCell)
					.join(" | "),
			),
	];
}

export function formatCollection(result: CollectionResult, displayLimit = 60): string {
	const run = result.run;
	const lines = [
		`Search run: ${run.id}`,
		`Queries: ${run.queries.join(" | ")}`,
		`Providers: ${run.providers.join(", ")}`,
		`Results: ${run.results.length} unique; merged duplicates: ${run.deduplicatedCount}`,
		`Corpus hits reused: ${run.corpusHitCount ?? 0}`,
		`Possible duplicates requiring review: ${run.possibleDuplicates?.length ?? 0}`,
		...(run.coverage
			? [
					`Search coverage: ${run.coverage.status}; planned=${run.coverage.plannedQueryCount}; executed=${run.coverage.executedQueryCount}; failed=${run.coverage.failedExecutionCount}; skipped=${run.coverage.skippedExecutionCount}`,
				]
			: []),
		`Source counts: ${run.providers.map((provider) => `${provider}=${run.sourceCounts[provider] ?? 0}`).join(", ")}`,
		`Mode: ${run.scope}/${run.mode}/${run.namespace}`,
		`Cache: ${result.cached ? "hit (no repeated API search)" : "miss"}`,
		result.corpusPath ? `Corpus: ${result.corpusPath}` : "Corpus: not written (once mode)",
		"",
		"Discovery results are leads, not evidence for substantive claims. Open the primary paper or official artifact.",
		"",
		...formatCandidateTitles(run.results, displayLimit),
	];
	if (run.results.length > displayLimit) {
		lines.push(
			`[Showing the first ${displayLimit} of ${run.results.length} candidate titles from search run ${run.id}.]`,
		);
	}
	if (run.possibleDuplicates?.length) {
		lines.push("", "Possible duplicates (not merged):");
		for (const candidate of run.possibleDuplicates.slice(0, 30)) {
			lines.push(
				"- " +
					candidate.leftId +
					" <> " +
					candidate.rightId +
					" title_similarity=" +
					candidate.titleSimilarity.toFixed(3),
			);
		}
	}
	if (run.failures.length) {
		lines.push("", "Partial provider failures:");
		for (const failure of run.failures) {
			lines.push(
				"- " +
					failure.provider +
					" / " +
					failure.query +
					": " +
					failure.message +
					" (retryable=" +
					failure.retryable +
					")",
			);
		}
	}
	const skipped = run.executions?.filter((execution) => execution.status === "skipped") ?? [];
	if (skipped.length) {
		lines.push("", "Skipped search executions:");
		for (const execution of skipped.slice(0, 30)) {
			lines.push(`- ${execution.provider} / ${execution.query}: ${execution.message ?? "not run"}`);
		}
	}
	return lines.join("\n");
}

export function collectionParameters() {
	return Type.Object({
		query: Type.String({ description: "Primary focused literature query" }),
		query_expansions: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 11,
				description: "Optional synonym, acronym, author/title, or adjacent-topic query variants",
			}),
		),
		auto_expand: Type.Optional(
			Type.Boolean({ description: "Add deterministic acronym and hyphenation variants; default: true" }),
		),
		providers: Type.Optional(
			Type.Array(providerSchema, {
				minItems: 1,
				maxItems: 10,
				description:
					"Keyword-search providers. Default: arxiv, openalex, crossref, semanticscholar, dblp, core, exa. ACL Anthology requires one exact year and one ACL-family venue. USENIX searches official conference pages. DOI enrichment runs separately when selected records are saved.",
			}),
		),
		year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
		year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
		venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		open_access: Type.Optional(Type.Boolean()),
		publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
		pages_per_provider: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Default: 1" })),
		max_results_per_provider: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 500, description: "Across pages for each provider/query; default: 20" }),
		),
		candidate_limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 500,
				description: "Max candidate paper IDs and titles returned to the model; default: 60",
			}),
		),
		scope: Type.Optional(scopeSchema),
		mode: Type.Optional(modeSchema),
		namespace: Type.Optional(Type.String({ description: "Corpus namespace; default: default" })),
		corpus_root: Type.Optional(
			Type.String({ description: "Optional shared corpus base directory; default: .paper-agent/corpus" }),
		),
		refresh_cache: Type.Optional(
			Type.Boolean({
				description: "Ignore a matching persistent search cache and refresh providers; default: false",
			}),
		),
		reuse_corpus: Type.Optional(
			Type.Boolean({
				description: "Search the selected personal/team corpus before external providers; default: true",
			}),
		),
		corpus_only: Type.Optional(
			Type.Boolean({ description: "Search only the existing corpus and make no provider requests; default: false" }),
		),
		research_object: Type.Optional(Type.String({ description: "Research object, e.g. malware detection" })),
		research_problem: Type.Optional(Type.String({ description: "Research problem, e.g. robustness under evasion" })),
		scenario: Type.Optional(Type.String({ description: "Application scenario or domain" })),
		time_range: Type.Optional(Type.String({ description: "Natural-language time range for the literature search" })),
		domain_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		problem_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		method_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
	});
}

export function optionsFromParams(
	params: {
		query: string;
		query_expansions?: string[];
		auto_expand?: boolean;
		providers?: LiteratureProvider[];
		year_from?: number;
		year_to?: number;
		venues?: string[];
		authors?: string[];
		open_access?: boolean;
		publication_types?: string[];
		pages_per_provider?: number;
		max_results_per_provider?: number;
		scope?: CorpusScope;
		mode?: PersistenceMode;
		namespace?: string;
		corpus_root?: string;
		refresh_cache?: boolean;
		reuse_corpus?: boolean;
		corpus_only?: boolean;
		research_object?: string;
		research_problem?: string;
		scenario?: string;
		time_range?: string;
		domain_terms?: string[];
		problem_terms?: string[];
		method_terms?: string[];
	},
	cwd: string,
	signal?: AbortSignal,
): CollectLiteratureOptions {
	if (params.year_from && params.year_to && params.year_from > params.year_to) {
		throw new Error("year_from cannot be later than year_to");
	}
	return {
		queries:
			params.auto_expand === false
				? uniqueQueries([params.query, ...(params.query_expansions ?? [])])
				: expandLiteratureQueries(params.query, params.query_expansions),
		providers: params.providers ?? ["arxiv", "openalex", "crossref", "semanticscholar", "dblp", "core", "exa"],
		filters: {
			yearFrom: params.year_from,
			yearTo: params.year_to,
			venues: params.venues,
			authors: params.authors,
			openAccess: params.open_access,
			types: params.publication_types,
		},
		pagesPerProvider: params.pages_per_provider ?? 1,
		maxResultsPerProvider: params.max_results_per_provider ?? 20,
		scope: params.scope ?? "personal",
		mode: params.mode ?? "once",
		namespace: params.namespace ?? "default",
		cwd,
		corpusRoot: params.corpus_root,
		refreshCache: params.refresh_cache,
		reuseCorpus: params.reuse_corpus ?? true,
		corpusOnly: params.corpus_only ?? false,
		signal,
		searchPlan: planLiteratureSearch({
			researchObject: params.research_object,
			researchProblem: params.research_problem,
			scenario: params.scenario,
			timeRange: params.time_range,
			domainTerms: params.domain_terms,
			problemTerms: params.problem_terms,
			methodTerms: params.method_terms,
			primaryQuery: params.query,
			explicitQueryVariants: params.query_expansions,
			filters: {
				yearFrom: params.year_from,
				yearTo: params.year_to,
			},
		}),
	};
}

/**
 * 从 markdown 表格单元格里抓取每行的 title/doi/year/venue/focus/url。
 * 当模型未传 rows 元数据时, 用它对侧边栏进行索引。
 */
