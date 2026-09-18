import { extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizePreparedAgentOperation } from "../../../app/presentation/interactive-operation-consent.ts";
import { loadPaperAgentConfig } from "../../../config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../../literature/application/literature-store.ts";
import { OperationConsentManager } from "../../../shared/application/operation-consent.ts";
import { MineruService } from "../application/mineru-service.ts";

async function createMineruService(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	namespace: string,
	corpusRoot?: string,
) {
	const config = await loadPaperAgentConfig(ctx.cwd);
	const dataRoot = resolve(ctx.cwd, config.storage.dataRoot ?? ".paper-agent");
	const effectiveCorpusRoot = corpusRoot ?? config.storage.corpusRoot;
	const manager = new OperationConsentManager({
		auditPath: resolve(dataRoot, "audit", "operations.jsonl"),
		signingKeyPath: resolve(dataRoot, "runtime", "operation-signing.key"),
	});
	return {
		manager,
		service: new MineruService({
			projectRoot: ctx.cwd,
			defaultNamespace: namespace,
			executor: pi,
			consent: manager,
			store: (targetNamespace) =>
				new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", targetNamespace, effectiveCorpusRoot),
					"personal",
					targetNamespace,
				),
		}),
	};
}

export function registerMineruTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "generate_mineru_material",
		label: "Generate MinerU material",
		description:
			"Generate or rebuild a structured MinerU reading package for the preferred PDF of one personal-library paper. The package contains full Markdown, page-aware content blocks, figures, tables, and a manifest.",
		promptSnippet: "Generate page-aware MinerU reading material for a saved paper",
		promptGuidelines: [
			"Use get_personal_library_paper first and pass its exact paper ID and namespace.",
			"Reuse existing current material unless the user explicitly requests a rebuild.",
			"Generation may take several minutes. Do not claim success until the package has been saved.",
		],
		parameters: Type.Object({
			paper_id: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			force: Type.Optional(Type.Boolean()),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const integration = await createMineruService(pi, ctx, namespace, params.corpus_root);
			const prepared = await integration.service.prepare({
				paperId: params.paper_id,
				namespace,
				force: params.force,
			});
			if (prepared.reused) {
				return {
					content: [{ type: "text", text: "Current MinerU material already exists and was reused." }],
					details: prepared.material,
				};
			}
			if (!prepared.operation) throw new Error("MinerU preparation did not return an operation");
			const grant = await authorizePreparedAgentOperation(ctx, integration.manager, prepared.operation, {
				title: prepared.operation.summary,
				unavailableMessage: "MinerU generation requires interactive confirmation",
			});
			const authorized = await integration.service.authorize(prepared.operation.operationId, grant);
			const result = await integration.service.execute(authorized, {
				jobId: toolCallId,
				signal: signal ?? new AbortController().signal,
				report: () => {},
			});
			return {
				content: [
					{ type: "text", text: `MinerU material saved.\nPath: ${result.path}\nPages: ${result.pageCount}` },
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "read_mineru_material",
		label: "Read MinerU material",
		description:
			"Use a current MinerU package as the primary paper-reading layer: navigate sections, traverse exact Markdown, read typed physical-page content, search every specialized field, or inspect extracted figures and tables as images.",
		promptSnippet: "Read complete, page-aware paper content and visual assets from MinerU",
		promptGuidelines: [
			"Start with overview, then use section IDs, page ranges, search queries, or the Markdown cursor without guessing paths.",
			"For full-paper research, finish every MinerU page or traverse full.md until next_cursor is none.",
			"Inspect relevant MinerU figure and table images. Verify decisive claims, numbers, equations, quotations, conflicts, and ambiguous crops against the original PDF.",
		],
		parameters: Type.Object({
			paper_id: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			mode: Type.Union([
				Type.Literal("overview"),
				Type.Literal("sections"),
				Type.Literal("markdown"),
				Type.Literal("pages"),
				Type.Literal("search"),
				Type.Literal("assets"),
			]),
			section_ids: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 12,
					description: "Required only for sections mode",
				}),
			),
			pages: Type.Optional(
				Type.Array(Type.Integer({ minimum: 1 }), {
					minItems: 1,
					maxItems: 20,
					description: "Required only for pages mode; values are physical PDF pages",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 8,
					description: "Required only for search mode",
				}),
			),
			asset_ids: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 8,
					description: "Required only for assets mode",
				}),
			),
			context_blocks: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 1 })),
			max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
			cursor: Type.Optional(Type.String()),
			max_characters: Type.Optional(Type.Integer({ minimum: 1000, maximum: 80000 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const { service } = await createMineruService(pi, ctx, namespace, params.corpus_root);
			const result = await service.read(params.paper_id, namespace, {
				mode: params.mode,
				sectionIds: params.section_ids,
				pages: params.pages,
				queries: params.queries,
				assetIds: params.asset_ids,
				contextBlocks: params.context_blocks,
				maxMatches: params.max_matches,
				cursor: params.cursor,
				maxCharacters: params.max_characters,
			});
			const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
				{ type: "text", text: result.text },
			];
			for (const item of result.assetResults) {
				if (!item.path) continue;
				const asset = await service.readAsset(params.paper_id, namespace, item.path);
				const mimeType = (
					{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
						string,
						string
					>
				)[extname(asset.path).toLowerCase()];
				if (mimeType) content.push({ type: "image", mimeType, data: asset.body.toString("base64") });
			}
			return { content, details: result };
		},
	});
}
