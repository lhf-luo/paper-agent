import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizePreparedAgentOperation } from "../../../app/presentation/interactive-operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../../literature/application/literature-store.ts";
import { OperationConsentManager, type PreparedOperation } from "../../../shared/application/operation-consent.ts";
import { ZoteroIntegrationService } from "../application/zotero-integration.ts";

function service(ctx: Pick<ExtensionContext, "cwd">, namespace: string, corpusRoot?: string) {
	const manager = new OperationConsentManager({
		auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
		signingKeyPath: resolve(ctx.cwd, ".paper-agent", "runtime", "operation-signing.key"),
	});
	return {
		manager,
		value: new ZoteroIntegrationService({
			projectRoot: ctx.cwd,
			consent: manager,
			defaultNamespace: namespace,
			store: (targetNamespace) =>
				new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", targetNamespace, corpusRoot),
					"personal",
					targetNamespace,
				),
		}),
	};
}

async function confirm(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
	manager: OperationConsentManager,
	operation: PreparedOperation,
) {
	return authorizePreparedAgentOperation(ctx, manager, operation, {
		title: operation.summary,
		unavailableMessage: "Zotero transfer requires interactive confirmation",
	});
}

export function registerZoteroTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_zotero_library",
		label: "Search Zotero library",
		description:
			"Read the local Zotero collection tree and bibliographic items. Zotero must be running with its Local API enabled.",
		promptSnippet: "Search the user's local Zotero library and inspect full collection paths",
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _update, ctx) {
			const integration = service(ctx, "default").value;
			const status = await integration.status();
			const [collections, items] = status.localApiEnabled
				? await Promise.all([integration.collections(), integration.items(params.query)])
				: [[], []];
			return {
				content: [
					{
						type: "text",
						text: `Zotero: ${status.message}\nCollections: ${collections.length}\nItems: ${items.length}`,
					},
				],
				details: { status, collections, items },
			};
		},
	});

	pi.registerTool({
		name: "import_zotero_papers",
		label: "Import Zotero papers",
		description:
			"Import selected Zotero papers or collection branches into a personal Paper Agent namespace while preserving complete ancestor paths.",
		promptSnippet: "Import selected Zotero papers and their collection paths into the personal library",
		promptGuidelines: [
			"List or search Zotero first, then pass exact item or collection keys. Missing PDFs are warnings and do not block metadata import.",
			"Never edit zotero.sqlite or personal.sqlite directly.",
		],
		parameters: Type.Object({
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			collection_keys: Type.Optional(Type.Array(Type.String())),
			item_keys: Type.Optional(Type.Array(Type.String())),
			include_subcollections: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const namespace = params.namespace ?? "default";
			const integration = service(ctx, namespace, params.corpus_root);
			const prepared = await integration.value.prepareImport({
				namespace,
				collectionKeys: params.collection_keys,
				itemKeys: params.item_keys,
				includeSubcollections: params.include_subcollections,
			});
			const grant = await confirm(ctx, integration.manager, prepared.operation);
			const result = await integration.value.executeImport(prepared.operation.operationId, grant);
			return {
				content: [
					{
						type: "text",
						text: `Imported ${result.imported} Zotero paper(s) into ${namespace}; ${result.failed.length} failed.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "export_papers_to_zotero",
		label: "Export papers to Zotero",
		description:
			"Copy selected personal-library papers, complete collection paths, tags, and one preferred PDF into local Zotero.",
		promptSnippet: "Export selected personal papers to Zotero without deleting existing Zotero data",
		promptGuidelines: [
			"The first write may open Zotero's authorization dialog. Ask the user to choose Always Allow for persistent access.",
			"This copies data and never propagates deletions or exports private notes, screening state, research records, or artifacts.",
		],
		parameters: Type.Object({
			paper_ids: Type.Array(Type.String()),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const namespace = params.namespace ?? "default";
			const integration = service(ctx, namespace, params.corpus_root);
			const status = await integration.value.status();
			if (!status.writeAuthorized) await integration.value.authorize();
			const prepared = await integration.value.prepareExport({ namespace, paperIds: params.paper_ids });
			const grant = await confirm(ctx, integration.manager, prepared.operation);
			const result = await integration.value.executeExport(prepared.operation.operationId, grant);
			return {
				content: [
					{
						type: "text",
						text: `Zotero export: ${result.created} created, ${result.updated} updated, ${result.failed.length} failed.`,
					},
				],
				details: result,
			};
		},
	});
}
