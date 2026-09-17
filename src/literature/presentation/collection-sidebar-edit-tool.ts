import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editLiteratureSidebar, type SidebarEditOperation } from "../application/literature-sidebar-editor.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";

export function registerCollectionSidebarEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit_literature_sidebar",
		label: "Edit literature sidebar",
		description:
			"Atomically edit an existing literature sidebar document in place. The URL and chat result card stay unchanged. Bibliographic replacements and additions must reference an exact paper_id from a persisted search_run_id.",
		promptSnippet: "Modify the current literature sidebar without creating a new list",
		promptGuidelines: [
			"Use this instead of update_literature_sidebar for small corrections, additions, removals, or regrouping in an existing list. Use filter_results on update_literature_sidebar to combine whole search runs.",
			"When a Paper ID is ambiguous across runs, supply target_search_run_id together with target_paper_id for remove, patch, or replace_from_search.",
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
