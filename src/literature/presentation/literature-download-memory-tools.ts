import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { downloadLiteraturePdfs, prepareLiteraturePdfDownload } from "../application/literature-download.ts";
import { derivedCacheKey, LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { derivedRecordWritePlan, persistDerivedRecord } from "../application/literature-write.ts";
import type { DerivedRecord } from "../domain/literature-types.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";

export function registerLiteratureDownloadMemoryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "download_literature_pdfs",
		label: "Download literature PDFs",
		description:
			"Download selected papers from saved PDF links first, then query DOI providers only when no saved link exists or all saved links fail. Successful fallback links are retained for later downloads. Redirects are revalidated, size is bounded, and files are never executed.",
		promptSnippet: "Safely batch-download paper PDFs into the corpus",
		promptGuidelines: [
			"Download only records selected for the corpus; the tool automatically tries confirmed arXiv and DOI-derived open-access fallbacks after the primary PDF link fails.",
			"Disclose failed candidates and discovery warnings. Do not use bash, curl, or hand-built URLs to bypass this downloader.",
		],
		parameters: Type.Object({
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
			max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			max_megabytes_per_file: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Default: 3" })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const request = {
				paperIds: params.paper_ids,
				maxFiles: params.max_files ?? 20,
				maxBytesPerFile: (params.max_megabytes_per_file ?? 50) * 1024 * 1024,
				concurrency: params.concurrency ?? 3,
				projectRoot: ctx.cwd,
				signal,
			};
			const preparedDownload = await prepareLiteraturePdfDownload(store, request);
			const authorization = await requestInteractiveOperationAuthorization(ctx, preparedDownload.plan, {
				title: "Download selected PDFs?",
				unavailableMessage: "PDF downloads require interactive confirmation. Use the Paper Agent UI or interactive Pi.",
				details: (prepared) => [
					`Corpus: ${store.root}`,
					`Papers: ${preparedDownload.papers.length}`,
					`Known PDF candidates: ${String(prepared.details.candidateCount ?? 0)}`,
					`Conditional DOI fallbacks: ${String(prepared.details.deferredDoiFallbackCount ?? 0)}`,
					`Candidate sources: ${String(prepared.details.candidateSources ?? "none")}`,
					`Discovery warnings: ${preparedDownload.discoveryWarnings.length}`,
					`Maximum bytes per file: ${request.maxBytesPerFile}`,
				],
			});
			const { downloaded, failures, missingPaperIds, attempts, discoveryWarnings } = await downloadLiteraturePdfs(
				store,
				request,
				preparedDownload,
				authorization,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Downloaded PDFs: ${downloaded.length}`,
							`Failures/skips: ${failures.length}`,
							`Corpus: ${store.root}`,
							...downloaded.map(
								(item) =>
									"- " +
									item.paperId +
									" sha256=" +
									item.sha256 +
									" bytes=" +
									item.bytes +
									" path=" +
									item.blobPath,
							),
							...failures.map((item) => `- ${item.paperId} failed: ${item.reason}`),
							...attempts
								.filter((attempt) => attempt.status === "failed")
								.map((attempt) => `- ${attempt.paperId} ${attempt.source} failed: ${attempt.reason}`),
							...discoveryWarnings.map(
								(warning) => `- ${warning.paperId} ${warning.provider} warning: ${warning.reason}`,
							),
						].join("\n"),
					},
				],
				details: { downloaded, failures, missingPaperIds, attempts, discoveryWarnings, corpusPath: store.root },
			};
		},
	});

	pi.registerTool({
		name: "manage_literature_memory",
		label: "Manage literature memory",
		description:
			"Look up or record a versioned derived task result such as a skim card or comparison matrix. Exact task-key hits are reused; changed inputs, tool/model/prompt versions, or configuration remain visible as alternatives instead of overwriting history.",
		promptSnippet: "Reuse versioned literature analysis before generating it again",
		promptGuidelines: [
			"Always run lookup before repeating a costly analysis; reuse an exact hit unless the user explicitly requests recomputation.",
			"Store generated analysis separately from user notes and primary-source metadata.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("lookup"), Type.Literal("record")]),
			paper_id: Type.String(),
			operation: Type.String({ description: "For example skim-card, comparison-matrix, or evidence-map" }),
			input_hashes: Type.Array(Type.String({ pattern: "^[a-fA-F0-9]{64}$" }), { minItems: 1, maxItems: 100 }),
			pipeline_version: Type.String(),
			model_version: Type.Optional(Type.String()),
			prompt_version: Type.Optional(Type.String()),
			normalized_config: Type.Optional(Type.Unknown()),
			result: Type.Optional(Type.Unknown()),
			created_by: Type.Optional(Type.String()),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			if (params.action === "record" && scope === "team") {
				throw new Error("Derived analysis cannot be recorded directly in team scope; record it personally first");
			}
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const normalizedConfig = params.normalized_config ?? {};
			const key = derivedCacheKey({
				inputHashes: params.input_hashes,
				operation: params.operation,
				pipelineVersion: params.pipeline_version,
				modelVersion: params.model_version,
				promptVersion: params.prompt_version,
				normalizedConfig,
			});
			const exact = await store.getDerived(key);
			const alternatives = (
				await store.listDerived({ paperId: params.paper_id, operation: params.operation })
			).filter((record) => record.key !== key);
			if (params.action === "lookup" || exact) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Task key: ${key}`,
								`Exact cache hit: ${Boolean(exact)}`,
								`Historical alternatives: ${alternatives.length}`,
								exact
									? `Result:\n${JSON.stringify(exact.result, null, 2)}`
									: "No exact result; generation may proceed.",
							].join("\n"),
						},
					],
					details: { key, cacheHit: Boolean(exact), exact, alternatives, corpusPath: store.root },
				};
			}
			if (params.result === undefined) throw new Error("result is required when action=record");
			if (!params.created_by?.trim()) throw new Error("created_by is required when action=record");
			const record: DerivedRecord = {
				key,
				paperId: params.paper_id,
				operation: params.operation,
				inputHashes: [...params.input_hashes].sort(),
				pipelineVersion: params.pipeline_version,
				modelVersion: params.model_version,
				promptVersion: params.prompt_version,
				normalizedConfig,
				createdAt: new Date().toISOString(),
				createdBy: params.created_by.trim(),
				result: params.result,
			};
			await persistDerivedRecord(
				store,
				record,
				await requestInteractiveOperationAuthorization(ctx, derivedRecordWritePlan(store, record), {
					title: "Record derived research memory?",
					unavailableMessage:
						"Recording derived research memory requires interactive confirmation. Lookup remains read-only.",
					details: () => [`Task key: ${key}`, `Created by: ${record.createdBy}`],
				}),
			);
			return {
				content: [{ type: "text", text: `Recorded derived task ${key} in ${store.root}` }],
				details: { key, cacheHit: false, alternatives, record, corpusPath: store.root },
			};
		},
	});
}
