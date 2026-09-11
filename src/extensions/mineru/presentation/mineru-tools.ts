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
			"Read a saved MinerU package by outline, physical PDF pages, or text search. It can also return one extracted image or table asset.",
		promptSnippet: "Read structured, page-aware paper content from an existing MinerU package",
		promptGuidelines: [
			"Use overview first, then request only relevant pages or search terms.",
			"Page numbers are physical PDF pages. Verify critical claims against the original PDF tools.",
			"Do not treat OCR or table extraction as authoritative when the original PDF disagrees.",
		],
		parameters: Type.Object({
			paper_id: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("pages"), Type.Literal("search")])),
			pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 20 })),
			query: Type.Optional(Type.String()),
			asset_path: Type.Optional(Type.String()),
			max_characters: Type.Optional(Type.Integer({ minimum: 1000, maximum: 80000 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const { service } = await createMineruService(pi, ctx, namespace, params.corpus_root);
			if (params.asset_path) {
				const asset = await service.readAsset(params.paper_id, namespace, params.asset_path);
				const mimeType = (
					{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
						string,
						string
					>
				)[extname(asset.path).toLowerCase()];
				if (!mimeType) throw new Error("Only PNG, JPEG, and WebP MinerU assets can be returned as images");
				return {
					content: [{ type: "image", mimeType, data: asset.body.toString("base64") }],
					details: { path: asset.path },
				};
			}
			const result = await service.read(params.paper_id, namespace, {
				mode: params.mode,
				pages: params.pages,
				query: params.query,
				maxCharacters: params.max_characters,
			});
			return { content: [{ type: "text", text: result.text }], details: result };
		},
	});
}
