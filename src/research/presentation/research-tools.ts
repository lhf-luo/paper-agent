import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import { runAuthorizedMutation } from "../../literature/application/literature-write.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { ResearchNotebook } from "../application/research-notebook.ts";

function notebook(cwd: string, namespace: string): ResearchNotebook {
	return new ResearchNotebook(
		new LiteratureStore(resolveCorpusRoot(cwd, "personal", namespace), "personal", namespace),
	);
}

export function registerResearchTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_research_notes",
		label: "Search research notes",
		description:
			"List or read Markdown research notes in one personal namespace. Filter by note id, title query, or an associated personal-library paper id.",
		promptSnippet: "Find existing Markdown research notes before creating another note",
		promptGuidelines: [
			"Search by paper_id before creating a new paper-specific note.",
			"A note may cite zero, one, or many personal-library papers; do not infer unrecorded associations.",
			"Use the returned folderId and folderPath when the user asks to organize notes in an existing folder.",
		],
		parameters: Type.Object({
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "default" })),
			note_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			query: Type.Optional(Type.String({ maxLength: 300 })),
			paper_id: Type.Optional(Type.String({ maxLength: 512 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const workspace = notebook(ctx.cwd, namespace);
			if (params.note_id) {
				const note = await workspace.get(params.note_id);
				if (!note) throw new Error(`Research note not found: ${params.note_id}`);
				return {
					content: [{ type: "text", text: `# ${note.title}\n\n${note.markdown}` }],
					details: { namespace, note },
				};
			}
			const notes = await workspace.list(params.query, params.paper_id);
			const folders = await workspace.folders();
			return {
				content: [
					{
						type: "text",
						text: notes.length
							? notes
									.map(
										(note) =>
											`- ${note.title} (${note.id}, rev ${note.revision}, ${note.papers.length} papers${note.folderPath ? `, ${note.folderPath}` : ""})`,
									)
									.join("\n")
							: "No research notes matched.",
					},
				],
				details: { namespace, notes, folders },
			};
		},
	});

	pi.registerTool({
		name: "manage_research_note",
		label: "Manage research note",
		description:
			"Create, update, delete, link, or unlink a Markdown research note. All paper ids must already exist in the same personal namespace. Mutations follow the configured research confirmation policy.",
		promptSnippet: "Persist or organize a Markdown research note with explicit confirmation",
		promptGuidelines: [
			"Use template_id=skim for a skim-card note, deep-reading for a close-reading note, or comparison-matrix for a comparison note.",
			"Use search_research_notes before updating so the intended note id and current content are known.",
			"Keep page, section, quote, and evidence locations in Markdown when making claims from papers.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("delete"),
				Type.Literal("link"),
				Type.Literal("unlink"),
			]),
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "default" })),
			note_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
			markdown: Type.Optional(Type.String({ maxLength: 2 * 1024 * 1024 })),
			template_id: Type.Optional(Type.String({ maxLength: 128 })),
			paper_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }))),
			folder_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const workspace = notebook(ctx.cwd, namespace);
			const existing = params.note_id ? await workspace.get(params.note_id) : undefined;
			if (params.action !== "create" && !existing) {
				throw new Error(`Research note not found: ${params.note_id ?? "missing note_id"}`);
			}
			if (params.action === "create" && !params.title) throw new Error("title is required when creating a note");
			const plan: OperationPlan = {
				kind: params.action === "delete" ? "research-memory-delete" : "research-memory-write",
				summary: `${params.action} Markdown research note`,
				actor: "paper-agent",
				targets: [
					{
						label: "Research note",
						value: `${namespace}/${params.note_id ?? params.title}`,
						risk: params.action === "delete" ? "high" : "low",
					},
				],
				details: { namespace, ...params, existingRevision: existing?.revision },
			};
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: params.action === "delete" ? "删除这篇调研笔记？" : "保存调研笔记更改？",
				unavailableMessage: "调研笔记写入需要交互确认，请使用 Web 界面。",
				details: () => [
					`操作: ${params.action}`,
					`笔记: ${existing?.title ?? params.title}`,
					`关联论文: ${params.paper_ids?.length ?? existing?.papers.length ?? 0}`,
				],
			});
			const result = await runAuthorizedMutation(authorization, plan, async () => {
				if (params.action === "create") {
					return workspace.create({
						title: params.title!,
						markdown: params.markdown,
						templateId: params.template_id,
						paperIds: params.paper_ids,
						folderId: params.folder_id,
					});
				}
				if (params.action === "delete") return workspace.delete(existing!.id);
				if (params.action === "update") {
					return workspace.update(existing!.id, {
						title: params.title ?? existing!.title,
						markdown: params.markdown ?? existing!.markdown,
						expectedRevision: existing!.revision,
						expectedContentHash: existing!.contentHash,
						...(params.paper_ids ? { paperIds: params.paper_ids } : {}),
						...(params.folder_id ? { folderId: params.folder_id } : {}),
					});
				}
				const requested = params.paper_ids ?? [];
				const current = existing!.papers.map((paper) => paper.id);
				const paperIds =
					params.action === "link"
						? [...new Set([...current, ...requested])]
						: current.filter((paperId) => !requested.includes(paperId));
				return workspace.setPapers(existing!.id, paperIds, existing!.revision);
			});
			return {
				content: [
					{ type: "text", text: `Research note ${params.action} completed: ${result?.id ?? existing?.id}` },
				],
				details: { namespace, action: params.action, note: result },
			};
		},
	});
}
