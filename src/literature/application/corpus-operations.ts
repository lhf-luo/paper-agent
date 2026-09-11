import { join } from "node:path";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { sha256Text } from "../domain/literature-identifiers.ts";
import type { PaperRecord, ScreeningStatus } from "../domain/literature-types.ts";
import type { LiteratureStore } from "./literature-store.ts";

export type CorpusExportFormat = "markdown" | "csv" | "bibtex" | "json";

export function corpusExportFilename(
	format: CorpusExportFormat,
	requested?: string,
	defaultBase = `literature-${Date.now()}`,
): string {
	const extension = format === "markdown" ? "md" : format === "bibtex" ? "bib" : format;
	const filename = requested?.trim() || `${defaultBase}.${extension}`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(filename)) {
		throw new Error("Export filename must use 1-64 letters, numbers, dots, underscores, or hyphens");
	}
	return filename;
}

export function corpusExportPlan(
	store: LiteratureStore,
	format: CorpusExportFormat,
	filename: string,
	records: PaperRecord[],
): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: store.scope === "team" ? "team-write" : "personal-corpus-write",
		summary: `Export ${normalized.length} literature records as ${format}`,
		targets: [{ label: "export-file", value: join(store.root, "exports", filename), risk: "low" }],
		details: {
			format,
			filename,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			corpusPath: store.root,
			scope: store.scope,
			namespace: store.namespace,
		},
	};
}

export interface CorpusAnnotationInput {
	author: string;
	tags?: string[];
	note?: string;
	screeningStatus?: ScreeningStatus;
	screeningReason?: string;
}

export function corpusAnnotationPlan(
	store: LiteratureStore,
	records: PaperRecord[],
	input: CorpusAnnotationInput,
): OperationPlan {
	const recordIds = records.map((record) => record.id).sort();
	return {
		kind: "personal-corpus-write",
		summary: `Annotate ${recordIds.length} personal literature record(s)`,
		actor: input.author,
		targets: recordIds.map((id) => ({ label: "personal-paper", value: id, risk: "medium" })),
		details: {
			corpusPath: store.root,
			namespace: store.namespace,
			recordIds,
			recordsFingerprint: sha256Text(
				JSON.stringify([...records].sort((left, right) => left.id.localeCompare(right.id))),
			),
			annotation: input,
		},
	};
}
