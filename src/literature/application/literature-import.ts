import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { sha256Text } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import type { PdfMetadataNeedsReview, PdfMetadataWarning } from "./literature-import-metadata.ts";
import type { ImportRejection } from "./literature-import-parsing.ts";
import type { LiteratureStore } from "./literature-store.ts";

export { type ImportRejection, parseBibtex, parseJsonExport } from "./literature-import-parsing.ts";

export function literatureImportPlan(
	store: LiteratureStore,
	inputPath: string,
	accepted: PaperRecord[],
	rejected: ImportRejection[],
	rejectionPath: string,
	options: {
		collection?: string;
		needsMetadata?: PdfMetadataNeedsReview[];
		providerWarnings?: PdfMetadataWarning[];
		fileHashes?: Array<{ path: string; sha256: string }>;
	} = {},
): OperationPlan {
	const normalized = [...accepted].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "personal-corpus-write",
		summary: `Import ${normalized.length} parsed literature record(s) into ${store.namespace}`,
		targets: [
			{ label: "personal-corpus", value: store.root, risk: "medium" },
			{ label: "rejection-log", value: rejectionPath, risk: "low" },
		],
		details: {
			inputPath,
			corpusPath: store.root,
			namespace: store.namespace,
			collection: options.collection?.trim() || undefined,
			recordIds: normalized.map((record) => record.id),
			records: normalized.map((record) => ({
				id: record.id,
				title: record.title,
				authors: record.authors,
				year: record.year,
				venue: record.venue,
				identifiers: record.identifiers,
			})),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			rejectedCount: rejected.length,
			needsMetadata: options.needsMetadata ?? [],
			providerWarnings: options.providerWarnings ?? [],
			fileHashes: options.fileHashes ?? [],
			rejectionsFingerprint: sha256Text(JSON.stringify(rejected)),
		},
	};
}

export async function listImportFiles(inputPath: string): Promise<string[]> {
	const inputStat = await stat(inputPath);
	if (inputStat.isFile()) return [inputPath];
	if (!inputStat.isDirectory()) return [];
	const files: string[] = [];
	const pending = [inputPath];
	while (pending.length && files.length < 5_000) {
		const directory = pending.shift();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && [".pdf", ".bib", ".json"].includes(extname(entry.name).toLowerCase()))
				files.push(path);
		}
	}
	return files.sort();
}
