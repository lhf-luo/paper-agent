import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { enrichRecordsByDoi } from "../application/literature-doi-enrichment.ts";
import {
	editLiteratureSidebar,
	type SidebarEditOperation,
} from "../application/literature-sidebar-editor.ts";
import {
	planLiteratureSearch,
	saveSearchRunSelection,
	searchRunSelectionPlan,
} from "../application/literature-search-planning.ts";
import {
	enrichSidebarRows,
	mergeSidebarRows,
} from "../application/literature-sidebar.ts";
import {
	assignCollection,
	prepareSidebarSelection,
	sidebarFocusGroups,
} from "../application/literature-sidebar-save.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { corpusUpsertPlan } from "../application/literature-write.ts";
import { inferSidebarRelevance } from "../application/sidebar-relevance.ts";

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
				Type.String({ description: "mdUrl returned by update_literature_sidebar; supports rows from multiple search runs" }),
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
				const statusById = new Map(
					outcomes.map((outcome) => [outcome.record.id, outcome.status ?? "failed"]),
				);
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

	/**
	 * 当模型未传 rows 时, 从 markdown 表格单元格里抓取每行的 title/doi/year/venue/focus/url,
	 * 供后续与搜索 run 记录匹配并补齐摘要。
	 */

	pi.registerTool({
		name: "update_literature_sidebar",
		label: "Update literature sidebar",
		description:
			"Save the curated literature list (one combined markdown table with a customizable header) into a markdown document and expose it for the web UI sidebar. Optional rows carry hidden JSON metadata (paper_id, doi, abstract, search_run_id, relevance, topic) so the right-side panel can render each row as a selectable paper card with a DOI link, expandable abstract, LLM-inferred relevance/topic, and the venue's CCF rank. The chat reply must contain ONLY a short summary — the table itself lives in the sidebar.",
		promptSnippet: "Send screened literature to the sidebar panel",
		promptGuidelines: [
			"Call this when the user wants to see the screened literature. Pass exactly ONE combined markdown table with a focus column (标题|年份/venue|标识|focus), titles as [title](url) links when a paper URL is known.",
			"Put every screened paper into that single table; do NOT split into per-focus sub-tables or use ## focus headings. The focus value (e.g. 二进制漏洞检测) is a column value on each row, so the whole list stays in one document.",
			"Optional: pass headers to override the displayed column titles (e.g. 标题, 年份/venue, 标识, focus). The first column is treated as the paper title.",
			"Optional: pass search_run_id of the source search run so the sidebar can auto-fill abstract/DOI/year/venue (and the venue's CCF rank) from the stored run when a row omits them; this is the reliable way to get abstracts.",
			"For every row, use the LLM to infer two fields from the title+abstract: relevance (切题度, a short Chinese summary sentence of ~20-40 characters describing what the paper covers and how it relates to the research question; do NOT use 高/中/低 level words) and topic (主题, short technical keywords like '机器学习;反编译代码'). These help the user decide which papers to read and put into the library.",
			"Optional: pass rows as an array of { paper_id, doi, abstract, search_run_id, relevance, topic, curated, ... } to attach hidden metadata to each row for saving to the personal library, DOI links, abstract expansion, and relevance/topic display. Include abstract in every row you have it; if omitted but search_run_id is given, the tool auto-fills it. CCF rank is auto-added from the venue, so you don't need to supply it.",
			'Mark the source of each paper: papers taken from the search runs carry paper_id/doi and can be saved to the library; papers you add from your own domain knowledge (classic/well-known works that did NOT appear in any search result) MUST be marked curated: "llm" and typically have no paper_id/doi — they cannot be saved to the library and should be visually flagged as LLM-curated in the sidebar. Use curated: "search" (or omit) for papers from the search results.',
			"The content parameter should contain only the table, not the whole conversation.",
			"Do NOT print any markdown table in the chat reply; reply with a short summary (counts, focus distribution, highlights, next steps) and let the sidebar show the list.",
		],
		parameters: Type.Object({
			content: Type.String({
				description:
					"Curated literature list markdown: one combined table | 标题 | 年份/venue | 标识 | focus | with every paper as a row (no per-focus sub-tables or ## headings)",
			}),
			search_run_id: Type.Optional(
				Type.String({
					description:
						"Optional search run id so the sidebar can auto-fill abstract/DOI/year/venue from the stored run when rows omit them",
				}),
			),
			headers: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 12,
					description: "Custom column headers displayed in the sidebar table",
				}),
			),
			rows: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.Optional(Type.String()),
						paper_id: Type.Optional(Type.String()),
						doi: Type.Optional(Type.String()),
						url: Type.Optional(Type.String()),
						abstract: Type.Optional(Type.String()),
						search_run_id: Type.Optional(Type.String()),
						year: Type.Optional(Type.String()),
						venue: Type.Optional(Type.String()),
						focus: Type.Optional(Type.String()),
						relevance: Type.Optional(
							Type.String({
								description:
									"LLM 推断的切题度: 一段中文总结句(约20-40字), 说明论文内容及与研究问题的相关性; 不要用 高/中/低 等级词",
							}),
						),
						topic: Type.Optional(
							Type.String({ description: "LLM 推断的主题/技术关键词(如 机器学习;反编译代码)" }),
						),
						curated: Type.Optional(
							Type.Union([Type.Literal("search"), Type.Literal("llm")], {
								description:
									"来源标记: search=来自搜索结果(有 paper_id/DOI, 可入库); llm=模型凭知识补充(不在搜索结果中, 无法入库/无 DOI)",
							}),
						),
					}),
					{ maxItems: 500, description: "Optional structured row metadata aligned with table rows" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const content = params.content?.trim();
			if (!content) throw new Error("content is required");
			if (content.length > 200_000) throw new Error("content too large (max 200KB)");
			const resultsDir = join(ctx.cwd, ".paper-agent", "web-agent-memory", "results");
			await mkdir(resultsDir, { recursive: true });
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unspecified";
			const safeSessionId = sessionId.replace(/[^A-Za-z0-9-]/g, "_");
			const fileName = `${safeSessionId}-${Date.now().toString(36)}.md`;
			const filePath = join(resultsDir, fileName);
			// 合并可见表格字段与隐藏元数据，保证标题/DOI可参与搜索记录校验。
			const fallbackRunId =
				typeof params.search_run_id === "string"
					? params.search_run_id
					: (params.rows ?? []).find((row) => typeof row.search_run_id === "string")?.search_run_id;
			const sidebarRows = mergeSidebarRows(content, params.rows);
			const enrichedRows = await enrichSidebarRows(ctx.cwd, fallbackRunId, sidebarRows);
			// 若模型未提供 relevance/topic, 自动用配置的模型推断补全(有摘要的行)。
			if (enrichedRows?.length) {
				await inferSidebarRelevance(ctx.cwd, enrichedRows as Array<Record<string, unknown>>);
			}
			const metadata = {
				revision: 1,
				headers: params.headers?.length ? params.headers : undefined,
				rows: enrichedRows ?? sidebarRows ?? [],
			};
			// 在 markdown 顶部嵌入一行 JSON 元信息, 供前端侧边栏渲染结构化卡片。
			const payload = `${content}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(metadata)} -->\n`;
			await writeFile(filePath, payload, { encoding: "utf8" });
			const mdUrl = `/api/agent/results/${encodeURIComponent(fileName)}`;
			return {
				content: [
					{
						type: "text",
						text: `论文清单已生成，点击对话中的链接在右侧打开: ${mdUrl}`,
					},
				],
				details: {
					mdPath: filePath,
					mdUrl,
					rowCount: enrichedRows?.length ?? sidebarRows?.length ?? 0,
					revision: 1,
				},
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
			"Use this instead of update_literature_sidebar when the user asks to correct, enrich, add, remove, or regroup papers in an existing sidebar list.",
			"After search_literature finds corrected metadata, use replace_from_search with the returned searchRunId and paperId. Finding a DOI does not update the list until this edit succeeds.",
			"Use the revision returned by update_literature_sidebar or the preceding edit. Existing older lists start at revision 1.",
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
						action: Type.Literal("replace_from_search"),
						target_paper_id: Type.Optional(Type.String()),
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
						target_title: Type.Optional(Type.String()),
					}),
					Type.Object({
						action: Type.Literal("patch"),
						target_paper_id: Type.Optional(Type.String()),
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
				if (operation.action === "replace_from_search") {
					return {
						action: "replace-from-search",
						targetPaperId: operation.target_paper_id,
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
						targetTitle: operation.target_title,
					};
				}
				return {
					action: "patch",
					targetPaperId: operation.target_paper_id,
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
							...(result.warnings.length ? [`Warnings: ${result.warnings.join("; ")}`] : []),
						].join("\n"),
					},
				],
				details: {
					mdUrl: result.resultUrl,
					rowCount: result.rowCount,
					revision: result.revision,
					changed: result.changed,
					warnings: result.warnings,
				},
			};
		},
	});
}
