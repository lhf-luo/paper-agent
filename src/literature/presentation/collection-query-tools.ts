import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { collectionPersistencePlan, collectLiterature } from "../application/literature-collection.ts";
import { type FilterGroupOptions, filterGroup, filterTableLines } from "../application/literature-filtering.ts";
import { buildCandidatePaperTable } from "../application/literature-query-planning.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import {
	collectionParameters,
	formatCollection,
	formatPaper,
	optionsFromParams,
} from "./collection-tool-formatting.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";

export function registerCollectionQueryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "filter_search_run_results",
		label: "Filter search run results",
		description:
			"Filter an existing persisted search run's results by title/abstract terms, year range, or CCF venue rank without re-searching. include_terms keep a paper when ANY term appears in its title or abstract (OR semantics); exclude_terms drop a paper when ANY term appears. Supports multiple independent groups in one call, and returns each row's matched terms so you can judge relevance. Rows are re-ranked by citation count and can reach papers beyond the original display limit.",
		promptSnippet: "Filter collected literature results in place",
		promptGuidelines: [
			"Use after collect_literature when the candidate table is noisy or truncated; prefer this over re-searching.",
			"include_terms is OR (any term in title/abstract keeps the paper); exclude_terms is OR too (any term removes it). When a term is too generic (e.g. heap), set exclude_scope=title so exclusion only checks the title and cannot false-positive on abstracts.",
			"Use groups to run several topical filters (e.g. kernel vs binary) in one call; each group is reported separately.",
			"Filtering does not change the stored search run; it only narrows what is returned.",
		],
		parameters: Type.Object({
			search_run_id: Type.String(),
			include_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
			exclude_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
			exclude_scope: Type.Optional(
				Type.Union([Type.Literal("title"), Type.Literal("title+abstract")], {
					description: "Where exclude_terms are checked; default: title+abstract",
				}),
			),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			venue_rank: Type.Optional(Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C")])),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Default: 60" })),
			groups: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.Optional(Type.String()),
						include_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
						exclude_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
						exclude_scope: Type.Optional(Type.Union([Type.Literal("title"), Type.Literal("title+abstract")])),
						year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
						year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
						venue_rank: Type.Optional(Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C")])),
						limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
					}),
					{ maxItems: 8, description: "Independent topical filters run in one call" },
				),
			),
			namespace: Type.Optional(Type.String({ description: "Corpus namespace; default: default" })),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", params.namespace ?? "default", params.corpus_root),
				"personal",
				params.namespace ?? "default",
			);
			const run = await store.getSearchRun(params.search_run_id);
			if (!run) throw new Error(`Search run not found in source corpus: ${params.search_run_id}`);
			const lines: string[] = [`Search run ${run.id}: ${run.results.length} results total.`];
			const details: Array<Record<string, unknown>> = [];
			const groups: Array<{ label?: string } & FilterGroupOptions> = (params.groups ?? []).map((group) => ({
				label: group.label,
				includeTerms: group.include_terms,
				excludeTerms: group.exclude_terms,
				excludeScope: group.exclude_scope,
				yearFrom: group.year_from,
				yearTo: group.year_to,
				venueRank: group.venue_rank,
				limit: group.limit,
			}));
			if (groups.length === 0) {
				groups.push({
					includeTerms: params.include_terms,
					excludeTerms: params.exclude_terms,
					excludeScope: params.exclude_scope,
					yearFrom: params.year_from,
					yearTo: params.year_to,
					venueRank: params.venue_rank,
					limit: params.limit,
				});
			}
			for (const group of groups) {
				const { matched, total } = filterGroup(run, group);
				const label = group.label ? ` (${group.label})` : "";
				lines.push(`\nFilter group${label}: ${total} matched / ${run.results.length} total.`);
				lines.push(...filterTableLines(matched, group));
				details.push({
					label: group.label,
					matched: total,
					paperIds: matched.slice(0, group.limit ?? 60).map((entry) => entry.record.id),
				});
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { totalResults: run.results.length, groups: details },
			};
		},
	});

	pi.registerTool({
		name: "collect_literature",
		label: "Collect literature",
		description:
			"Search the selected corpus first, then run a bounded collection across the keyword-search providers arXiv, OpenAlex, Crossref, Semantic Scholar, DBLP, CORE, and Exa with filters, pagination, deduplication, partial-failure reporting, optional persistent caching, and provenance. DOI-only providers enrich records later and are not keyword-search choices.",
		promptSnippet: "Collect and deduplicate literature into a personal or team corpus",
		promptGuidelines: [
			"Review the deterministic acronym/hyphenation expansions, add explicit author/title or adjacent-term variants when useful, and preserve every executed query in the run manifest.",
			"Provider credentials are read from split config automatically; CORE works when coreApiKey is set there (no environment variable needed). Prefer 2-4 focused query variants over many expansions to keep collection fast.",
			"Use once mode for exploratory searches and persistent mode when the results should be reused.",
			"Search metadata is discovery evidence only; verify substantive claims in primary sources.",
		],
		parameters: collectionParameters(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = optionsFromParams(params, ctx.cwd, signal);
			if (options.mode === "persistent") {
				const plan = collectionPersistencePlan(options);
				options.authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Save literature collection?",
					unavailableMessage:
						"Persistent collection requires interactive confirmation. Use once mode or the Paper Agent UI.",
					details: () => [
						`Corpus: ${plan.targets[0]?.value}`,
						`Queries: ${options.queries.join(" | ")}`,
						`Providers: ${options.providers.join(", ")}`,
					],
				});
			}
			const result = await collectLiterature(options);
			return {
				content: [{ type: "text", text: formatCollection(result, params.candidate_limit ?? 60) }],
				details: {
					searchRunId: result.run.id,
					queries: result.run.queries,
					resultCount: result.run.results.length,
					sourceCounts: result.run.sourceCounts,
					failures: result.run.failures,
					cached: result.cached,
					corpusPath: result.corpusPath,
					scope: result.run.scope,
					mode: result.run.mode,
					corpusHitCount: result.run.corpusHitCount ?? 0,
					possibleDuplicates: result.run.possibleDuplicates ?? [],
					searchPlan: result.run.searchPlan,
					candidateTable: result.run.candidateTable ?? buildCandidatePaperTable(result.run.results),
				},
			};
		},
	});

	pi.registerTool({
		name: "search_literature_corpus",
		label: "Search literature corpus",
		description:
			"Search an existing personal or team corpus without external network requests or writes. Supports title/abstract/author/venue/note text, identifiers, tags, years, and screening status.",
		promptSnippet: "Reuse papers and notes already present in a personal or team corpus",
		promptGuidelines: [
			"Search the corpus before starting a repeated collection or analysis task.",
			"Corpus matches are reusable records, not proof that a technical claim is correct.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			open_access: Type.Optional(Type.Boolean()),
			tags: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
			identifiers: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
			screening_statuses: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("unreviewed"),
						Type.Literal("include"),
						Type.Literal("exclude"),
						Type.Literal("maybe"),
					]),
					{ maxItems: 4 },
				),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.year_from && params.year_to && params.year_from > params.year_to) {
				throw new Error("year_from cannot be later than year_to");
			}
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const hits = await store.searchPapers({
				query: params.query,
				yearFrom: params.year_from,
				yearTo: params.year_to,
				authors: params.authors,
				venues: params.venues,
				types: params.publication_types,
				openAccess: params.open_access,
				tags: params.tags,
				identifiers: params.identifiers,
				screeningStatuses: params.screening_statuses,
				limit: params.limit,
				readOnly: true,
			});
			const text = [
				`Corpus: ${store.root}`,
				`Scope: ${scope}/${namespace}`,
				`Matches: ${hits.length}`,
				"",
				...hits.map((hit, index) =>
					[
						formatPaper(hit.record, index),
						`   corpus_score: ${hit.score}; matched_fields: ${hit.matchedFields.join(", ") || "filters"}`,
					].join("\n"),
				),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { corpusPath: store.root, scope, namespace, hitCount: hits.length, hits },
			};
		},
	});
}
