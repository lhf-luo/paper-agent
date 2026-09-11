import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizePreparedAgentOperation } from "../../../app/presentation/interactive-operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../../literature/application/literature-store.ts";
import { OperationConsentManager } from "../../../shared/application/operation-consent.ts";
import { PdfTranslationService } from "../application/pdf-translation-service.ts";

function translationService(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	namespace: string,
	corpusRoot?: string,
) {
	const dataRoot = resolve(ctx.cwd, ".paper-agent");
	const manager = new OperationConsentManager({
		auditPath: resolve(dataRoot, "audit", "operations.jsonl"),
		signingKeyPath: resolve(dataRoot, "runtime", "operation-signing.key"),
	});
	return {
		manager,
		service: new PdfTranslationService({
			projectRoot: ctx.cwd,
			defaultNamespace: namespace,
			executor: pi,
			consent: manager,
			store: (targetNamespace) =>
				new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", targetNamespace, corpusRoot),
					"personal",
					targetNamespace,
				),
		}),
	};
}

export function registerPdfTranslationTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "translate_personal_pdf",
		label: "Translate personal PDF",
		description:
			"Translate one saved personal-library PDF with the locally installed PDF2zh Next engine and the active Paper Agent model. The translated PDF is saved as a non-preferred version of the same paper; the source PDF is not changed.",
		promptSnippet: "Create a translated PDF version for a saved personal-library paper",
		promptGuidelines: [
			"Use get_personal_library_paper first and pass an exact paper ID and registered source PDF SHA-256.",
			"Do not translate an existing translation version. Report the saved path and translation version label.",
		],
		parameters: Type.Object({
			paper_id: Type.String(),
			source_sha256: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			source_language: Type.Optional(Type.String({ default: "en" })),
			target_language: Type.Optional(Type.String({ default: "zh-CN" })),
			output_mode: Type.Optional(Type.Union([Type.Literal("mono"), Type.Literal("dual")])),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const integration = translationService(pi, ctx, namespace, params.corpus_root);
			const prepared = await integration.service.prepare({
				paperId: params.paper_id,
				namespace,
				sourceSha256: params.source_sha256,
				sourceLanguage: params.source_language,
				targetLanguage: params.target_language,
				outputMode: params.output_mode,
			});
			const grant = await authorizePreparedAgentOperation(ctx, integration.manager, prepared, {
				title: prepared.summary,
				unavailableMessage: "PDF translation requires interactive confirmation",
			});
			const authorized = await integration.service.authorize(prepared.operationId, grant);
			const result = await integration.service.execute(authorized, {
				jobId: toolCallId,
				signal: signal ?? new AbortController().signal,
				report: () => {},
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Translated PDF saved for ${result.paperId}.`,
							`Version: ${result.version.versionLabel}`,
							`SHA-256: ${result.version.sha256}`,
							`Path: ${result.version.blobPath}`,
						].join("\n"),
					},
				],
				details: result,
			};
		},
	});
}
