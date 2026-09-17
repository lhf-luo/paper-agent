import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { collectionPersistencePlan, collectLiterature } from "../application/literature-collection.ts";
import {
	type FilterResultEntry,
	fingerprintSearchRun,
	readFilterResult,
	saveFilterResult,
} from "../application/literature-filter-result.ts";
import { type FilterGroupOptions, filterGroup, filterTableLines } from "../application/literature-filtering.ts";
import { buildCandidatePaperTable, primaryIdentifier } from "../application/literature-query-planning.ts";
import { readSidebarResultRows } from "../application/literature-sidebar.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { mergePaperRecords } from "../domain/literature-identifiers.ts";
import {
	collectionParameters,
	formatCollection,
	formatPaper,
	optionsFromParams,
} from "./collection-tool-formatting.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";
import {
	type PaperProjectionField,
	paperProjectionFieldSchema,
	projectPaperRecord,
} from "./literature-query-projection.ts";

const includeTermGroupsSchema = Type.Array(Type.Array(Type.String(), { minItems: 1, maxItems: 20 }), {
	maxItems: 12,
	description: "Required concept groups: terms inside one group are OR; every group must match (AND)",
});

const filterRuleSchema = Type.Object({
	include_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
	include_term_groups: Type.Optional(includeTermGroupsSchema),
	exclude_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 60 })),
	exclude_scope: Type.Optional(Type.Union([Type.Literal("title"), Type.Literal("title+abstract")])),
	year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
	year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
	venue_rank: Type.Optional(Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C")])),
});

const filterGroupSchema = Type.Object({
	label: Type.Optional(Type.String()),
	with_abstract: filterRuleSchema,
	without_abstract: Type.Omit(filterRuleSchema, ["exclude_scope"]),
});

export function registerCollectionQueryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_literature_sidebar",
		label: "Inspect literature sidebar",
		description:
			"Read one small page of a generated literature sidebar. Returns lightweight row metadata and paper IDs without loading abstracts or the whole document into model context.",
		promptSnippet: "Inspect a page of the current literature sidebar",
		promptGuidelines: [
			"Use this when you need to resume or edit a sidebar list; do not read the whole markdown file.",
			"Use get_search_run_papers only for the specific paper IDs whose abstracts you need.",
		],
		parameters: Type.Object({
			result_url: Type.String({ description: "mdUrl returned by update_literature_sidebar" }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Default: 0" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default: 20" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rows = await readSidebarResultRows(ctx.cwd, params.result_url);
			const offset = params.offset ?? 0;
			const page = rows.slice(offset, offset + (params.limit ?? 20));
			const lines = page.map((row, index) =>
				[
					`${offset + index + 1}.`,
					`paper_id=${typeof row.paper_id === "string" ? row.paper_id : "unavailable"}`,
					`search_run_id=${typeof row.search_run_id === "string" ? row.search_run_id : "unavailable"}`,
					`title=${typeof row.title === "string" ? row.title : "untitled"}`,
					`focus=${typeof row.focus === "string" ? row.focus : "unassigned"}`,
				].join(" | "),
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Sidebar rows: ${rows.length} total; showing ${page.length} from offset ${offset}.`,
							...lines,
							offset + page.length < rows.length ? `Next offset: ${offset + page.length}` : "End of sidebar.",
						].join("\n"),
					},
				],
				details: { total: rows.length, offset, nextOffset: offset + page.length, rows: page },
			};
		},
	});

	pi.registerTool({
		name: "review_literature_duplicates",
		label: "Review literature duplicates",
		description:
			"List or record explicit same-work/different-work decisions for possible duplicates in one search run. Same-work decisions merge the run records under the chosen left paper ID; persisted library IDs are not rewritten.",
		promptSnippet: "Resolve ambiguous literature identities before saving the final selection",
		promptGuidelines: [
			"Only mark same-work when title, authors, venue, identifiers, or primary sources support that conclusion.",
			"Use the paper IDs returned by the search run. Re-run screening after a same-work merge to refresh the sidebar baseline.",
		],
		parameters: Type.Object({
			search_run_id: Type.String(),
			decisions: Type.Optional(
				Type.Array(
					Type.Object({
						left_id: Type.String(),
						right_id: Type.String(),
						decision: Type.Union([Type.Literal("same-work"), Type.Literal("different-work")]),
						reason: Type.Optional(Type.String()),
					}),
					{ maxItems: 100 },
				),
			),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root),
				"personal",
				namespace,
			);
			const run = await store.getSearchRun(params.search_run_id);
			if (!run) throw new Error(`Search run not found: ${params.search_run_id}`);
			for (const input of params.decisions ?? []) {
				if (input.left_id === input.right_id)
					throw new Error("Duplicate decision requires two different paper IDs");
				const leftIndex = run.results.findIndex((record) => record.id === input.left_id);
				const rightIndex = run.results.findIndex((record) => record.id === input.right_id);
				if (leftIndex < 0 || rightIndex < 0) {
					throw new Error(
						`Duplicate decision papers were not found in the run: ${input.left_id}, ${input.right_id}`,
					);
				}
				if (input.decision === "same-work") {
					const merged = mergePaperRecords(run.results[leftIndex], run.results[rightIndex]);
					run.results[leftIndex] = merged;
					run.results.splice(rightIndex, 1);
					run.deduplicatedCount++;
					const remappedDuplicates = (run.possibleDuplicates ?? [])
						.map((candidate) => ({
							...candidate,
							leftId: candidate.leftId === input.right_id ? input.left_id : candidate.leftId,
							rightId: candidate.rightId === input.right_id ? input.left_id : candidate.rightId,
						}))
						.filter((candidate) => candidate.leftId !== candidate.rightId);
					run.possibleDuplicates = [
						...new Map(
							remappedDuplicates.map((candidate) => [
								[candidate.leftId, candidate.rightId].sort().join("\n"),
								candidate,
							]),
						).values(),
					];
				} else {
					run.possibleDuplicates = (run.possibleDuplicates ?? []).filter(
						(candidate) =>
							!(
								[candidate.leftId, candidate.rightId].includes(input.left_id) &&
								[candidate.leftId, candidate.rightId].includes(input.right_id)
							),
					);
				}
				run.identityDecisions = [
					...(run.identityDecisions ?? []),
					{
						leftId: input.left_id,
						rightId: input.right_id,
						decision: input.decision,
						reason: input.reason?.trim() || undefined,
						decidedAt: new Date().toISOString(),
					},
				];
			}
			if (params.decisions?.length) {
				run.candidateTable = buildCandidatePaperTable(run.results);
				await store.saveSearchRun(run);
			}
			return {
				content: [
					{
						type: "text",
						text: `Possible duplicates: ${run.possibleDuplicates?.length ?? 0}; recorded decisions: ${run.identityDecisions?.length ?? 0}; results: ${run.results.length}`,
					},
				],
				details: {
					searchRunId: run.id,
					possibleDuplicates: run.possibleDuplicates ?? [],
					identityDecisions: run.identityDecisions ?? [],
					resultCount: run.results.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "get_search_run_papers",
		label: "Get search run papers",
		description:
			"Read stored data for up to 20 exact paper IDs from one persisted search run. Omit fields for the complete existing response, or select only the fields needed. Makes no external requests and performs no writes.",
		promptSnippet: "Read selected search-result papers on demand",
		promptGuidelines: [
			"Use only for papers you need to inspect; keep paper_ids limited to the current decision batch.",
			"Use the exact paper IDs returned by filtering or inspect_literature_sidebar.",
			"Pass fields when only selected metadata or abstracts are needed; Paper ID is always returned.",
		],
		parameters: Type.Object({
			search_run_id: Type.String(),
			paper_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
			fields: Type.Optional(
				Type.Array(paperProjectionFieldSchema, {
					minItems: 1,
					uniqueItems: true,
					description:
						"Optional field projection. Omit for the complete existing response. Paper ID and query status are always returned.",
				}),
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
			const byId = new Map(
				run.results.flatMap((record) => [record.id, ...record.mergedFrom].map((id) => [id, record] as const)),
			);
			const records = params.paper_ids.flatMap((id) => {
				const record = byId.get(id);
				return record ? [record] : [];
			});
			const missingPaperIds = params.paper_ids.filter((id) => !byId.has(id));
			const lines = records.flatMap((record) => [
				`Title: ${record.title}`,
				`Paper ID: ${record.id}`,
				`Authors: ${record.authors.join(", ") || "unavailable"}`,
				`Year / venue: ${record.year ?? "unknown"} / ${record.venue ?? "unknown"}`,
				`Identifier: ${primaryIdentifier(record)}`,
				`Abstract: ${record.abstract ?? "unavailable"}`,
				"",
			]);
			const projectedRecords = params.fields
				? records.map((record) => projectPaperRecord(record, params.fields as PaperProjectionField[]))
				: records;
			return {
				content: [
					{
						type: "text",
						text: params.fields
							? [
									`Search run ${run.id}: ${records.length} paper(s) loaded on demand.`,
									JSON.stringify(projectedRecords, null, 2),
									missingPaperIds.length ? `Missing paper IDs: ${missingPaperIds.join(", ")}` : "",
								]
									.filter(Boolean)
									.join("\n")
							: [
									`Search run ${run.id}: ${records.length} paper(s) loaded on demand.`,
									...lines,
									missingPaperIds.length ? `Missing paper IDs: ${missingPaperIds.join(", ")}` : "",
								]
									.filter(Boolean)
									.join("\n"),
					},
				],
				details: { searchRunId: run.id, records: projectedRecords, missingPaperIds },
			};
		},
	});

	pi.registerTool({
		name: "filter_search_run_results",
		label: "Filter search run results",
		description:
			"Filter a persisted search run or narrow a previous filter result. Separate rules apply to papers with abstracts and papers without abstracts. Every retained Paper ID/title is returned and the Search Run is unchanged.",
		promptSnippet: "Filter collected literature results in place",
		promptGuidelines: [
			"Provide exactly one source: search_run_id for the first pass or source_filter_result_id to narrow an earlier result.",
			"with_abstract checks title and abstract. without_abstract checks title only and must contain a positive include rule; passing records remain unresolved.",
			"Use include_term_groups for OR within each concept group and AND across groups. Do not combine it with include_terms.",
			"To loosen rules, start again from search_run_id. A chained filter can only narrow retained papers.",
			"Pass the final filter_result_id with its root search_run_id to update_literature_sidebar. Never cherry-pick papers by title.",
		],
		parameters: Type.Object({
			search_run_id: Type.Optional(Type.String({ description: "Root Search Run for the first filter pass" })),
			source_filter_result_id: Type.Optional(
				Type.String({ description: "Previous filter result to narrow; mutually exclusive with search_run_id" }),
			),
			groups: Type.Array(filterGroupSchema, { minItems: 1, maxItems: 8 }),
			namespace: Type.Optional(Type.String({ description: "Corpus namespace; default: default" })),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (Boolean(params.search_run_id) === Boolean(params.source_filter_result_id)) {
				throw new Error("Provide exactly one of search_run_id or source_filter_result_id");
			}
			let namespace = params.namespace ?? "default";
			let corpusRoot = resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root);
			let rootSearchRunId = params.search_run_id;
			let parentFilterResultId: string | undefined;
			let sourceEntries: FilterResultEntry[] | undefined;
			if (params.source_filter_result_id) {
				const parent = await readFilterResult(
					ctx.cwd,
					ctx.sessionManager?.getSessionId?.(),
					params.source_filter_result_id,
				);
				if (params.namespace !== undefined && parent.namespace !== namespace) {
					throw new Error("source_filter_result_id belongs to a different namespace");
				}
				if (params.corpus_root !== undefined && parent.corpusRoot !== corpusRoot) {
					throw new Error("source_filter_result_id belongs to a different corpus root");
				}
				rootSearchRunId = parent.searchRunId;
				parentFilterResultId = params.source_filter_result_id;
				sourceEntries = parent.entries;
				corpusRoot = parent.corpusRoot;
				namespace = parent.namespace;
			}
			const store = new LiteratureStore(corpusRoot, "personal", namespace);
			const run = await store.getSearchRun(rootSearchRunId!);
			if (!run) throw new Error(`Search run not found in source corpus: ${rootSearchRunId}`);
			if (run.namespace !== namespace) throw new Error("Search run belongs to a different namespace");
			if (parentFilterResultId) {
				const parent = await readFilterResult(ctx.cwd, ctx.sessionManager?.getSessionId?.(), parentFilterResultId);
				if (fingerprintSearchRun(run) !== parent.runFingerprint) {
					throw new Error("Filter result is stale because the Search Run changed; filter from the root again");
				}
			}
			const byId = new Map(run.results.map((record) => [record.id, record]));
			const sourceRecords = sourceEntries
				? sourceEntries.map((entry) => {
						const record = byId.get(entry.paperId);
						if (!record || record.title !== entry.title) {
							throw new Error("Filter result is stale because a retained paper changed or disappeared");
						}
						return record;
					})
				: run.results;
			const lines: string[] = [
				`search_run_id=${run.id}: filtering ${sourceRecords.length} source papers from ${run.results.length} root results.`,
				...(parentFilterResultId ? [`source_filter_result_id=${parentFilterResultId}`] : []),
			];
			const details: Array<Record<string, unknown>> = [];
			const retained = new Map<string, FilterResultEntry>();
			const groups: FilterGroupOptions[] = params.groups.map((group) => ({
				label: group.label,
				withAbstract: {
					includeTerms: group.with_abstract.include_terms,
					includeTermGroups: group.with_abstract.include_term_groups,
					excludeTerms: group.with_abstract.exclude_terms,
					excludeScope: group.with_abstract.exclude_scope,
					yearFrom: group.with_abstract.year_from,
					yearTo: group.with_abstract.year_to,
					venueRank: group.with_abstract.venue_rank,
				},
				withoutAbstract: {
					includeTerms: group.without_abstract.include_terms,
					includeTermGroups: group.without_abstract.include_term_groups,
					excludeTerms: group.without_abstract.exclude_terms,
					yearFrom: group.without_abstract.year_from,
					yearTo: group.without_abstract.year_to,
					venueRank: group.without_abstract.venue_rank,
				},
			}));
			for (const group of groups) {
				const { matched, unresolved, total, excluded } = filterGroup(sourceRecords, group);
				const label = group.label ? ` (${group.label})` : "";
				lines.push(
					`Filter group${label}: ${total} matched, ${unresolved.length} unresolved, ${excluded} excluded / ${sourceRecords.length} source.`,
				);
				for (const entry of matched) {
					retained.set(entry.record.id, {
						paperId: entry.record.id,
						title: entry.record.title,
						status: "matched",
					});
				}
				for (const entry of unresolved) {
					if (!retained.has(entry.record.id)) {
						retained.set(entry.record.id, {
							paperId: entry.record.id,
							title: entry.record.title,
							status: "unresolved",
						});
					}
				}
				details.push({
					label: group.label,
					matched: total,
					unresolved: unresolved.length,
					excluded,
					paperIds: [...matched, ...unresolved].map((entry) => entry.record.id),
				});
			}
			const entries = [...retained.values()];
			const matchedEntries = entries.filter((entry) => entry.status === "matched");
			const unresolvedEntries = entries.filter((entry) => entry.status === "unresolved");
			const filterResultId = await saveFilterResult(ctx.cwd, ctx.sessionManager?.getSessionId?.(), {
				version: 2,
				searchRunId: run.id,
				parentFilterResultId,
				runFingerprint: fingerprintSearchRun(run),
				namespace,
				corpusRoot,
				rules: groups,
				sourceCount: sourceRecords.length,
				rootTotal: run.results.length,
				entries,
			});
			lines.push(`filter_result_id=${filterResultId}`);
			lines.push(
				`Unique retained: ${entries.length} (${matchedEntries.length} matched, ${unresolvedEntries.length} unresolved, ${sourceRecords.length - entries.length} excluded this pass).`,
				"Matched (all):",
				...filterTableLines(matchedEntries),
				"Unresolved (passed title-only rules but has no abstract; all):",
				...filterTableLines(unresolvedEntries),
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					searchRunId: run.id,
					search_run_id: run.id,
					filterResultId,
					filter_result_id: filterResultId,
					sourceFilterResultId: parentFilterResultId,
					source_filter_result_id: parentFilterResultId,
					totalResults: run.results.length,
					rootTotal: run.results.length,
					sourceCount: sourceRecords.length,
					matched: matchedEntries.length,
					unresolved: unresolvedEntries.length,
					excludedThisPass: sourceRecords.length - entries.length,
					retained: entries,
					groups: details,
				},
			};
		},
	});

	pi.registerTool({
		name: "collect_literature",
		label: "Collect literature",
		description:
			"Search the selected corpus first, then run a bounded collection across keyword-search providers with filters, pagination, deduplication, partial-failure reporting, optional persistent caching, and provenance. Missing abstracts with a DOI are then completed through configured Crossref, OpenAlex, and Semantic Scholar lookups before the Search Run is saved.",
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
					coverage: result.run.coverage,
					abstractEnrichment: result.run.abstractEnrichment,
					executions: result.run.executions,
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
