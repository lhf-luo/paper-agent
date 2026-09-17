import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { enrichRecordsByDoi } from "../application/literature-doi-enrichment.ts";
import {
	planLiteratureSearch,
	saveSearchRunSelection,
	searchRunSelectionPlan,
} from "../application/literature-search-planning.ts";
import { editLiteratureSidebar, type SidebarEditOperation } from "../application/literature-sidebar-editor.ts";
import { SIDEBAR_ANNOTATION_FIELD_NAMES, SIDEBAR_FIELD_NAMES } from "../application/literature-sidebar-fields.ts";
import { writeSidebarFromFilter } from "../application/literature-sidebar-from-filter.ts";
import {
	assignCollection,
	prepareSidebarSelection,
	sidebarFocusGroups,
} from "../application/literature-sidebar-save.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { corpusUpsertPlan } from "../application/literature-write.ts";

const sidebarFieldSchema = Type.Union(SIDEBAR_FIELD_NAMES.map((field) => Type.Literal(field)));
const sidebarAnnotationFieldSchema = Type.Union(SIDEBAR_ANNOTATION_FIELD_NAMES.map((field) => Type.Literal(field)));

export function registerCollectionSearchTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "plan_literature_search",
		label: "Plan literature search",
		description:
			"Create a structured literature-search plan before provider queries. Splits the topic into research object, problem, scenario, time range, and domain/problem/method terms; expands deterministic query variants; and records unsupported providers such as Google Scholar.",
		promptSnippet: "Plan a structured literature search before collecting papers",
		promptGuidelines: [
			"Use this before collect_literature when the research object, problem, scenario, or time range is under-specified.",
			"Treat the plan as search scaffolding, not evidence for technical claims.",
			"Do not claim Google Scholar was searched; this project has no Google Scholar provider.",
		],
		parameters: Type.Object({
			research_object: Type.Optional(Type.String()),
			research_problem: Type.Optional(Type.String()),
			scenario: Type.Optional(Type.String()),
			time_range: Type.Optional(Type.String()),
			domain_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			problem_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			method_terms: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			primary_query: Type.Optional(Type.String()),
			query_expansions: Type.Optional(Type.Array(Type.String(), { maxItems: 11 })),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
		}),
		async execute(_toolCallId, params) {
			if (params.year_from && params.year_to && params.year_from > params.year_to) {
				throw new Error("year_from cannot be later than year_to");
			}
			const plan = planLiteratureSearch({
				researchObject: params.research_object,
				researchProblem: params.research_problem,
				scenario: params.scenario,
				timeRange: params.time_range,
				domainTerms: params.domain_terms,
				problemTerms: params.problem_terms,
				methodTerms: params.method_terms,
				primaryQuery: params.primary_query,
				explicitQueryVariants: params.query_expansions,
				filters: { yearFrom: params.year_from, yearTo: params.year_to },
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Research question: ${plan.researchQuestion}`,
							`Domain terms: ${plan.keywordGroups.domain.join(", ") || "none"}`,
							`Problem terms: ${plan.keywordGroups.problem.join(", ") || "none"}`,
							`Method terms: ${plan.keywordGroups.method.join(", ") || "none"}`,
							"Query variants (use at most 6; prefer 2-4 focused ones for speed):",
							...plan.queryVariants.slice(0, 6).map((query) => `- ${query}`),
							"Unsupported providers:",
							...(plan.unsupportedProviders ?? []).map(
								(item) =>
									"- " +
									item.provider +
									": " +
									item.reason +
									"; alternatives=" +
									item.suggestedAlternatives.join(", "),
							),
						].join("\n"),
					},
				],
				details: plan,
			};
		},
	});

	pi.registerTool({
		name: "save_literature_selection",
		label: "Save literature selection",
		description:
			"Save selected records from one persisted search run or from a generated literature sidebar into a personal corpus. Sidebar results may combine multiple search runs; pass sidebar_result_url so the tool resolves the hidden paper IDs itself instead of searching again.",
		promptSnippet: "Save selected literature search results into a personal corpus",
		promptGuidelines: [
			"Use after a persistent collect_literature run when the user chooses which candidates to keep.",
			"After update_literature_sidebar, pass its mdUrl as sidebar_result_url. This is required for a combined list containing papers from multiple search runs; never repeat the search just to recover IDs.",
			"When sidebar_result_url is used, omit search_run_id. Omit paper_ids to save every search-backed row; model-supplement rows are ignored.",
			"Once-mode search runs are persisted in SQLite for later selection; never rerun a search merely to turn its results into saveable IDs.",
			"Records with a DOI are enriched automatically by configured DOI providers before confirmation; provider failures are warnings and never block saving.",
			"Saving records preserves metadata and discovery paths, but does not prove technical claims.",
		],
		parameters: Type.Object({
			search_run_id: Type.Optional(Type.String()),
			sidebar_result_url: Type.Optional(
				Type.String({
					description: "mdUrl returned by update_literature_sidebar; supports rows from multiple search runs",
				}),
			),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			source_namespace: Type.Optional(Type.String({ description: "Source corpus namespace; default: default" })),
			target_namespace: Type.Optional(
				Type.String({ description: "Target personal corpus namespace; default: source" }),
			),
			source_corpus_root: Type.Optional(Type.String()),
			target_corpus_root: Type.Optional(Type.String()),
			contributor: Type.String({ description: "Human or agent identity for the save confirmation audit" }),
			collection: Type.Optional(
				Type.String({ description: "目标分类(集合)名称; 不存在则自动创建; 为空/未传则保持未分类" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.contributor.trim()) throw new Error("contributor is required");
			if (Boolean(params.search_run_id) === Boolean(params.sidebar_result_url)) {
				throw new Error("Provide exactly one of search_run_id or sidebar_result_url");
			}
			const sourceNamespace = params.source_namespace ?? "default";
			const targetNamespace = params.target_namespace ?? sourceNamespace;
			const source = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", sourceNamespace, params.source_corpus_root),
				"personal",
				sourceNamespace,
			);
			const target = new LiteratureStore(
				resolveCorpusRoot(
					ctx.cwd,
					"personal",
					targetNamespace,
					params.target_corpus_root ?? params.source_corpus_root,
				),
				"personal",
				targetNamespace,
			);
			if (params.sidebar_result_url) {
				const preparedSidebar = await prepareSidebarSelection(
					source,
					ctx.cwd,
					params.sidebar_result_url,
					params.paper_ids,
					{ signal },
				);
				const { resolution, records: preparedRecords, enrichment } = preparedSidebar;
				const plan = {
					...corpusUpsertPlan(target, preparedRecords),
					actor: params.contributor.trim(),
					details: {
						...corpusUpsertPlan(target, preparedRecords).details,
						sidebarResultUrl: params.sidebar_result_url,
						searchRunIds: resolution.searchRunIds,
						collection: params.collection?.trim() || undefined,
					},
				};
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Save literature sidebar selection?",
					unavailableMessage:
						"Saving a literature sidebar selection requires interactive confirmation before records are written.",
					details: () => [
						`Sidebar result: ${params.sidebar_result_url}`,
						`Search runs: ${resolution.searchRunIds.length}`,
						`Selected records: ${preparedRecords.length}`,
						`Missing ids: ${resolution.missingPaperIds.join(", ") || "none"}`,
					],
				});
				await authorization.manager.consume(authorization.grant, plan);
				let collectionId: string | undefined;
				const collectionName = params.collection?.trim();
				if (collectionName) {
					await target.initialize();
					const existing = (await target.listCollections()).find(
						(collection) => collection.name === collectionName,
					);
					collectionId = existing?.id ?? (await target.createCollection(collectionName)).id;
				}
				const records = assignCollection(preparedRecords, collectionId);
				const outcomes = await target.upsertPapers(records);
				const statusById = new Map(outcomes.map((outcome) => [outcome.record.id, outcome.status ?? "failed"]));
				const focusGroups = sidebarFocusGroups(resolution);
				const counts = {
					created: outcomes.filter((outcome) => outcome.status === "created").length,
					updated: outcomes.filter((outcome) => outcome.status === "updated").length,
					unchanged: outcomes.filter((outcome) => outcome.status === "unchanged").length,
					failed: outcomes.filter((outcome) => outcome.error).length,
				};
				return {
					content: [
						{
							type: "text",
							text: [
								`Saved ${outcomes.length} paper(s) from ${resolution.searchRunIds.length} search run(s).`,
								`Created/updated/unchanged/failed: ${counts.created}/${counts.updated}/${counts.unchanged}/${counts.failed}`,
								`Missing ids: ${resolution.missingPaperIds.join(", ") || "none"}`,
								...Object.entries(focusGroups).map(([focus, ids]) => `${focus}: ${ids.join(", ")}`),
							].join("\n"),
						},
					],
					details: {
						sidebarResultUrl: params.sidebar_result_url,
						searchRunIds: resolution.searchRunIds,
						missingPaperIds: resolution.missingPaperIds,
						focusGroups,
						outcomes: resolution.records.map((item) => ({
							paperId: item.record.id,
							focus: item.focus,
							status: statusById.get(item.record.id) ?? "failed",
						})),
						doiEnrichment: {
							attempts: enrichment.attempts,
							warnings: enrichment.warnings,
							skippedWithoutDoi: enrichment.skippedWithoutDoi,
							skippedComplete: enrichment.skippedComplete,
						},
					},
				};
			}
			const searchRunId = params.search_run_id;
			if (!searchRunId) throw new Error("search_run_id is required");
			const run = await source.getSearchRun(searchRunId);
			if (!run) throw new Error(`Search run not found in source corpus: ${searchRunId}`);
			const wanted = params.paper_ids?.length ? new Set(params.paper_ids) : undefined;
			const sourceSelected = wanted ? run.results.filter((record) => wanted.has(record.id)) : run.results;
			const enrichment = await enrichRecordsByDoi(sourceSelected, ctx.cwd, { signal });
			const selected = enrichment.records;
			const present = new Set(selected.map((record) => record.id));
			const missingPaperIds = params.paper_ids?.filter((id) => !present.has(id)) ?? [];
			const plan = searchRunSelectionPlan(source, target, run, selected, params.contributor.trim());
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "Save selected literature results?",
				unavailableMessage:
					"Saving selected search results requires interactive confirmation before records are written.",
				details: () => [
					`Search run: ${run.id}`,
					`Selected records: ${selected.length}`,
					`Target corpus: ${target.root}`,
					`Missing ids: ${missingPaperIds.join(", ") || "none"}`,
				],
			});
			// 解析目标分类: 若传了 collection, 在 target 中取(同名幂等)或创建, 拿到 collection id。
			let collectionId: string | undefined;
			const collectionName = params.collection?.trim();
			if (collectionName) {
				const targetStore = target;
				await targetStore.initialize();
				const existing = (await targetStore.listCollections()).find(
					(collection) => collection.name === collectionName,
				);
				collectionId = existing?.id ?? (await targetStore.createCollection(collectionName)).id;
			}
			const result = await saveSearchRunSelection(
				source,
				target,
				run.id,
				params.paper_ids,
				authorization,
				params.contributor.trim(),
				collectionId,
				selected,
			);
			const counts = {
				created: result.outcomes.filter((outcome) => outcome.status === "created").length,
				updated: result.outcomes.filter((outcome) => outcome.status === "updated").length,
				unchanged: result.outcomes.filter((outcome) => outcome.status === "unchanged").length,
				failed: result.outcomes.filter((outcome) => outcome.error).length,
			};
			return {
				content: [
					{
						type: "text",
						text: [
							`Saved selection from search run ${run.id}`,
							`Target corpus: ${target.root}`,
							`Selected: ${result.selected.length}; missing: ${result.missingPaperIds.length}`,
							`Created/updated/unchanged/failed: ${counts.created}/${counts.updated}/${counts.unchanged}/${counts.failed}`,
							`DOI enrichment: ${enrichment.attempts.filter((attempt) => attempt.status === "matched").length} matched; ${enrichment.warnings.length} warning(s)`,
							result.missingPaperIds.length
								? `Missing ids: ${result.missingPaperIds.join(", ")}`
								: "Missing ids: none",
						].join("\n"),
					},
				],
				details: {
					searchRunId: run.id,
					selected: result.selected.map((record) => record.id),
					missingPaperIds: result.missingPaperIds,
					outcomes: result.outcomes.map((outcome) => ({
						paperId: outcome.record.id,
						status: outcome.status ?? "failed",
						error: outcome.error,
					})),
					doiEnrichment: {
						attempts: enrichment.attempts,
						warnings: enrichment.warnings,
						skippedWithoutDoi: enrichment.skippedWithoutDoi,
						skippedComplete: enrichment.skippedComplete,
					},
				},
			};
		},
	});

	pi.registerTool({
		name: "update_literature_sidebar",
		label: "Update literature sidebar",
		description:
			"Create a field-driven literature sidebar from every paper in a saved filter result. fields controls visible Markdown columns, annotation_fields declares Agent-supplied focus/relevance/topic columns, and all other requested fields are loaded from exact Search Run records.",
		promptSnippet: "Send screened literature to the sidebar panel",
		promptGuidelines: [
			"After accepting filter_search_run_results, pass its filter_result_id and search_run_id with fields, annotation_fields, and annotations. The tool imports every matched and unresolved paper. Never choose a title-based subset.",
			"fields must start with title and controls visible columns in order. Use only the documented field names; bibliographic fields are loaded from the Search Run.",
			"Supported fields: title, paper_id, authors, year, venue, year_venue, publication_type, identifier, doi, arxiv_id, url, citation_count, ccf, screening_status, focus, relevance, topic.",
			"annotation_fields must list every visible Agent field and may contain only focus, relevance, and topic. annotations are provisional title-based judgments keyed by Paper ID.",
			"Pass an empty annotations array when no labels are available. Missing annotation values leave blank cells and never remove papers.",
			"If a filtered Paper ID no longer exists because the Search Run changed, the tool still creates the sidebar from every remaining paper and reports the missing IDs.",
			"Do NOT print any markdown table in the chat reply; reply with a short summary and let the sidebar show the list.",
		],
		parameters: Type.Object({
			search_run_id: Type.String({ description: "Root Search Run associated with filter_result_id" }),
			filter_result_id: Type.String({
				description: "Saved complete filter result returned by filter_search_run_results",
			}),
			fields: Type.Array(sidebarFieldSchema, {
				minItems: 1,
				maxItems: SIDEBAR_FIELD_NAMES.length,
				uniqueItems: true,
				description: "Visible Markdown fields in order; title must be first",
			}),
			annotation_fields: Type.Array(sidebarAnnotationFieldSchema, {
				maxItems: SIDEBAR_ANNOTATION_FIELD_NAMES.length,
				uniqueItems: true,
				description: "Visible Agent-supplied fields; only focus, relevance, and topic",
			}),
			annotations: Type.Array(
				Type.Object(
					{
						paper_id: Type.String(),
						focus: Type.Optional(Type.String()),
						relevance: Type.Optional(Type.String()),
						topic: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
				{ description: "Title-based Agent values keyed by Paper ID; missing values never remove papers" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await writeSidebarFromFilter({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				filterResultId: params.filter_result_id,
				searchRunId: params.search_run_id,
				fields: params.fields,
				annotationFields: params.annotation_fields,
				annotations: params.annotations.map((item) => ({
					paperId: item.paper_id,
					focus: item.focus,
					relevance: item.relevance,
					topic: item.topic,
				})),
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Literature sidebar created: ${result.mdUrl}`,
							`Rows: ${result.rowCount}; matched: ${result.matched}; unresolved: ${result.unresolved}; incompletely annotated: ${result.unannotatedCount}; missing: ${result.missingPaperIds.length}; revision: ${result.revision}.`,
							...(result.missingPaperIds.length
								? [`Missing paper IDs: ${result.missingPaperIds.join(", ")}`]
								: []),
						].join("\n"),
					},
				],
				details: result,
			};
		},
	});
	pi.registerTool({
		name: "edit_literature_sidebar",
		label: "Edit literature sidebar",
		description:
			"Atomically edit an existing literature sidebar document in place. The URL and chat result card stay unchanged. Bibliographic replacements and additions must reference an exact paper_id from a persisted search_run_id.",
		promptSnippet: "Modify the current literature sidebar without creating a new list",
		promptGuidelines: [
			"Use this when the user asks to change visible fields, correct metadata, add, remove, or regroup papers in an existing sidebar list.",
			"Use set_fields to add, remove, or reorder visible columns. It rerenders every row from stored metadata and does not delete hidden annotation values.",
			"set_fields uses the same fixed field names as update_literature_sidebar and must keep title first.",
			"After search_literature finds corrected metadata, use replace_from_search with the returned searchRunId and paperId. Finding a DOI does not update the list until this edit succeeds.",
			"Use the revision returned by update_literature_sidebar or the preceding edit. Legacy sidebars without a fields schema cannot be edited.",
			"Edits affect only the sidebar document. They never silently modify or delete papers already saved in the personal library.",
		],
		parameters: Type.Object({
			result_url: Type.String({ description: "Existing mdUrl returned by update_literature_sidebar" }),
			expected_revision: Type.Integer({ minimum: 1 }),
			namespace: Type.Optional(Type.String({ description: "Search-run namespace; default: default" })),
			corpus_root: Type.Optional(Type.String()),
			operations: Type.Array(
				Type.Union([
					Type.Object({
						action: Type.Literal("set_fields"),
						fields: Type.Array(sidebarFieldSchema, {
							minItems: 1,
							maxItems: SIDEBAR_FIELD_NAMES.length,
							uniqueItems: true,
						}),
					}),
					Type.Object({
						action: Type.Literal("replace_from_search"),
						target_paper_id: Type.Optional(Type.String()),
						target_search_run_id: Type.Optional(Type.String()),
						target_title: Type.Optional(Type.String()),
						search_run_id: Type.String(),
						paper_id: Type.String(),
					}),
					Type.Object({
						action: Type.Literal("add_from_search"),
						search_run_id: Type.String(),
						paper_id: Type.String(),
						focus: Type.Optional(Type.String()),
						relevance: Type.Optional(Type.String()),
						topic: Type.Optional(Type.String()),
					}),
					Type.Object({
						action: Type.Literal("add_model_supplement"),
						title: Type.String(),
						authors: Type.Optional(Type.String()),
						year: Type.Optional(Type.String()),
						venue: Type.Optional(Type.String()),
						url: Type.Optional(Type.String()),
						focus: Type.Optional(Type.String()),
						relevance: Type.Optional(Type.String()),
						topic: Type.Optional(Type.String()),
					}),
					Type.Object({
						action: Type.Literal("remove"),
						target_paper_id: Type.Optional(Type.String()),
						target_search_run_id: Type.Optional(Type.String()),
						target_title: Type.Optional(Type.String()),
					}),
					Type.Object({
						action: Type.Literal("patch"),
						target_paper_id: Type.Optional(Type.String()),
						target_search_run_id: Type.Optional(Type.String()),
						target_title: Type.Optional(Type.String()),
						focus: Type.Optional(Type.String()),
						relevance: Type.Optional(Type.String()),
						topic: Type.Optional(Type.String()),
					}),
				]),
				{ minItems: 1, maxItems: 100 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", params.namespace ?? "default", params.corpus_root),
				"personal",
				params.namespace ?? "default",
			);
			const operations: SidebarEditOperation[] = params.operations.map((operation) => {
				if (operation.action === "set_fields") {
					return { action: "set-fields", fields: operation.fields };
				}
				if (operation.action === "replace_from_search") {
					return {
						action: "replace-from-search",
						targetPaperId: operation.target_paper_id,
						targetSearchRunId: operation.target_search_run_id,
						targetTitle: operation.target_title,
						searchRunId: operation.search_run_id,
						paperId: operation.paper_id,
					};
				}
				if (operation.action === "add_from_search") {
					return {
						action: "add-from-search",
						searchRunId: operation.search_run_id,
						paperId: operation.paper_id,
						focus: operation.focus,
						relevance: operation.relevance,
						topic: operation.topic,
					};
				}
				if (operation.action === "add_model_supplement") {
					return { ...operation, action: "add-model-supplement" };
				}
				if (operation.action === "remove") {
					return {
						action: "remove",
						targetPaperId: operation.target_paper_id,
						targetSearchRunId: operation.target_search_run_id,
						targetTitle: operation.target_title,
					};
				}
				return {
					action: "patch",
					targetPaperId: operation.target_paper_id,
					targetSearchRunId: operation.target_search_run_id,
					targetTitle: operation.target_title,
					focus: operation.focus,
					relevance: operation.relevance,
					topic: operation.topic,
				};
			});
			const result = await editLiteratureSidebar(
				store,
				ctx.cwd,
				params.result_url,
				params.expected_revision,
				operations,
				ctx.sessionManager?.getSessionId?.(),
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Literature sidebar updated in place: ${result.resultUrl}`,
							`Revision: ${result.revision}; rows: ${result.rowCount}; changed operations: ${result.changed}`,
							`Added paper IDs: ${result.addedPaperIds.join(", ") || "none"}`,
							`Removed paper IDs: ${result.removedPaperIds.join(", ") || "none"}`,
							`Updated paper IDs: ${result.updatedPaperIds.join(", ") || "none"}`,
							...(result.warnings.length ? [`Warnings: ${result.warnings.join("; ")}`] : []),
						].join("\n"),
					},
				],
				details: {
					mdUrl: result.resultUrl,
					rowCount: result.rowCount,
					revision: result.revision,
					changed: result.changed,
					addedPaperIds: result.addedPaperIds,
					removedPaperIds: result.removedPaperIds,
					updatedPaperIds: result.updatedPaperIds,
					warnings: result.warnings,
				},
			};
		},
	});
}
