import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { sha256File } from "../../artifacts/application/artifact-discovery.ts";
import {
	type ImportRejection,
	listImportFiles,
	literatureImportPlan,
	parseBibtex,
	parseJsonExport,
} from "../application/literature-import.ts";
import type { PdfMetadataNeedsReview, PdfMetadataWarning } from "../application/literature-import-metadata.ts";
import { preparePdfImport } from "../application/literature-import-metadata.ts";

export { literatureImportPlan, parseBibtex, parseJsonExport } from "../application/literature-import.ts";

import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { findPossibleDuplicates } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";

export function registerLiteratureImportTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "import_literature_corpus",
		label: "Import literature corpus",
		description:
			"Import local PDFs, BibTeX, or paper-agent JSON into a personal corpus. PDF titles and authors are extracted locally; configured providers only enrich optional metadata. The confirmed write can create or reuse a collection atomically.",
		promptSnippet: "Ingest an existing local literature collection into a personal corpus",
		promptGuidelines: [
			"Pass collection when the user asks to organize imported papers; do not call save_literature_selection for local import ids.",
			"Provider warnings do not mean the import failed. Report needsMetadata separately and never invent PDF titles or authors.",
		],
		parameters: Type.Object({
			input_path: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			collection: Type.Optional(
				Type.String({ description: "Target collection name; reuse it or create it atomically" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const inputPath = resolve(ctx.cwd, params.input_path);
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root),
				"personal",
				namespace,
			);
			const prepared: Array<{ record: PaperRecord; sourcePath?: string }> = [];
			const rejected: ImportRejection[] = [];
			const needsMetadata: PdfMetadataNeedsReview[] = [];
			const providerWarnings: PdfMetadataWarning[] = [];
			let files: string[];
			try {
				files = await listImportFiles(inputPath);
			} catch (error) {
				throw new Error(`Could not read import path: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (files.length === 0) throw new Error("Import path contained no .pdf, .bib, or .json files");
			const fileHashes = await Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(path) })));
			for (const path of files) {
				try {
					const extension = extname(path).toLowerCase();
					if (extension === ".pdf") {
						const result = await preparePdfImport(path, pi, ctx.cwd, signal);
						providerWarnings.push(...result.warnings.filter((warning) => warning.stage === "provider"));
						if (result.needsMetadata) needsMetadata.push(result.needsMetadata);
						if (result.record) prepared.push({ record: result.record, sourcePath: path });
						continue;
					}
					const result =
						extension === ".bib"
							? parseBibtex(await readFile(path, "utf8"), path)
							: parseJsonExport(JSON.parse(await readFile(path, "utf8")), path);
					prepared.push(...result.accepted.map((record) => ({ record })));
					rejected.push(...result.rejected);
				} catch (error) {
					rejected.push({
						source: path,
						reason: "parse_error",
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			}
			const accepted = prepared.map((item) => item.record);
			const possibleDuplicates = findPossibleDuplicates([...(await store.listPapers()), ...accepted]).filter(
				(candidate) => accepted.some((record) => record.id === candidate.leftId || record.id === candidate.rightId),
			);
			const rejectionId = `import-${randomUUID()}`;
			const rejectionPath = join(store.root, "imports", `${rejectionId}-rejections.json`);
			const plan = literatureImportPlan(store, inputPath, accepted, rejected, rejectionPath, {
				collection: params.collection,
				needsMetadata,
				providerWarnings,
				fileHashes,
			});
			if (accepted.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No records were imported. Needs metadata: ${needsMetadata.length}; rejected: ${rejected.length}`,
						},
					],
					details: {
						records: [],
						needsMetadata,
						providerWarnings,
						possibleDuplicates,
						rejected,
						parsed: 0,
						imported: 0,
					},
				};
			}
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "Import literature into the personal corpus?",
				unavailableMessage:
					"Literature import requires interactive confirmation before records or rejection logs are written.",
				details: () => [
					`Parsed records: ${accepted.length}`,
					`Needs metadata: ${needsMetadata.length}`,
					`Initial rejections: ${rejected.length}`,
					`Collection: ${params.collection?.trim() || "uncategorized"}`,
					...accepted
						.slice(0, 20)
						.map(
							(record) =>
								`- ${record.title} | ${record.authors.join(", ")} | ${record.year ?? "year unknown"} | ${record.venue ?? "venue unknown"}`,
						),
					...(accepted.length > 20 ? [`- ...and ${accepted.length - 20} more records`] : []),
					...providerWarnings
						.slice(0, 10)
						.map((warning) => `- Provider warning (${warning.provider ?? "unknown"}): ${warning.message}`),
				],
			});
			await authorization.manager.consume(authorization.grant, plan);
			const currentHashes = await Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(path) })));
			if (JSON.stringify(currentHashes) !== JSON.stringify(fileHashes)) {
				throw new Error("Import files changed after confirmation; prepare the import again");
			}
			const importReport = {
				schemaVersion: 1,
				id: rejectionId,
				generatedAt: new Date().toISOString(),
				inputPath,
				parsed: accepted.length,
				imported: accepted.length,
				needsMetadata,
				providerWarnings,
				possibleDuplicates,
				rejected,
			};
			const result = await store.importLocalPapersAtomically(
				await Promise.all(
					prepared.map(async (item) => ({
						record: item.record,
						sourcePath: item.sourcePath,
						body: item.sourcePath ? new Uint8Array(await readFile(item.sourcePath)) : undefined,
					})),
				),
				{ collectionName: params.collection, reportId: `${rejectionId}-rejections`, report: importReport },
			);
			const counts = { created: 0, updated: 0, unchanged: 0 };
			for (const outcome of result.outcomes) counts[outcome.status]++;
			const imported = result.records.length;
			return {
				content: [
					{
						type: "text",
						text: [
							`Parsed/imported records: ${accepted.length}/${imported}`,
							`Created/updated/unchanged: ${counts.created}/${counts.updated}/${counts.unchanged}`,
							`Needs metadata: ${needsMetadata.length}`,
							`Rejected: ${rejected.length}`,
							`Provider warnings: ${providerWarnings.length}`,
							`Collection: ${result.collection?.name ?? "uncategorized"}`,
							`Corpus: ${store.root}`,
							`Rejection log: ${rejectionPath}`,
						].join("\n"),
					},
				],
				details: {
					counts,
					records: result.records,
					parsed: accepted.length,
					imported,
					needsMetadata,
					providerWarnings,
					possibleDuplicates,
					rejected,
					collection: result.collection,
					corpusPath: store.root,
					rejectionPath,
				},
			};
		},
	});
}
