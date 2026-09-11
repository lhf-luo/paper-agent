import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";

export function registerLiteratureCollectionsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "manage_literature_collections",
		label: "Manage literature collections",
		description:
			"List, create, rename, delete, assign, or unassign personal-library collections. Use this for already-saved or locally imported paper ids; save_literature_selection is only for persisted search-run results.",
		promptSnippet: "Organize existing personal-library papers into collections",
		promptGuidelines: [
			"List collections before assigning by name. Assign never creates a misspelled collection implicitly.",
			"Use import_literature_corpus collection for an import-and-organize request; use this tool for papers already in the library.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("create"),
				Type.Literal("rename"),
				Type.Literal("delete"),
				Type.Literal("assign"),
				Type.Literal("unassign"),
			]),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			collection_id: Type.Optional(Type.String()),
			collection_name: Type.Optional(Type.String()),
			new_name: Type.Optional(Type.String()),
			parent_id: Type.Optional(Type.String()),
			paper_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 500 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root),
				"personal",
				namespace,
			);
			const collections = await store.listCollections();
			if (params.action === "list") {
				return {
					content: [{ type: "text", text: JSON.stringify(collections, null, 2) }],
					details: { namespace, collections, corpusPath: store.root },
				};
			}
			const requestedCollectionName = params.collection_name?.trim();
			const collection = params.collection_id
				? collections.find((value) => value.id === params.collection_id)
				: requestedCollectionName
					? collections.find((value) => value.name === requestedCollectionName)
					: undefined;
			if (params.action !== "create" && !collection) {
				throw new Error("A matching collection_id or collection_name is required");
			}
			if ((params.action === "assign" || params.action === "unassign") && !params.paper_ids?.length) {
				throw new Error(`paper_ids is required when action=${params.action}`);
			}
			if (params.action === "create" && !params.collection_name?.trim()) {
				throw new Error("collection_name is required when action=create");
			}
			if (params.action === "rename" && !params.new_name?.trim()) {
				throw new Error("new_name is required when action=rename");
			}
			const summary =
				params.action === "create"
					? `Create literature collection ${params.collection_name?.trim()}`
					: `${params.action} literature collection ${collection?.name}`;
			const plan: OperationPlan = {
				kind:
					params.action === "delete" || params.action === "unassign"
						? "personal-collection-remove"
						: "personal-corpus-write",
				summary,
				targets: [
					{ label: "personal-corpus", value: store.root, risk: params.action === "delete" ? "high" : "medium" },
				],
				details: {
					action: params.action,
					namespace,
					collectionId: collection?.id,
					collectionName: params.collection_name?.trim() ?? collection?.name,
					newName: params.new_name?.trim(),
					parentId: params.parent_id,
					paperIds: [...(params.paper_ids ?? [])].sort(),
				},
			};
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "Update literature collections?",
				unavailableMessage:
					"Collection changes require interactive confirmation before the personal corpus is written.",
			});
			await authorization.manager.consume(authorization.grant, plan);
			let result: unknown;
			if (params.action === "create") {
				result = await store.createCollection(params.collection_name!, params.parent_id);
			} else if (params.action === "rename") {
				result = await store.renameCollection(collection!.id, params.new_name!);
			} else if (params.action === "delete") {
				await store.deleteCollection(collection!.id);
				result = { deleted: collection!.id };
			} else {
				result = await store.updatePaperCollectionMembership(params.paper_ids!, collection!.id, params.action);
			}
			return {
				content: [{ type: "text", text: `${summary}\n${JSON.stringify(result, null, 2)}` }],
				details: { action: params.action, result, corpusPath: store.root },
			};
		},
	});
}
