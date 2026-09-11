import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { sha256Text } from "../domain/literature-identifiers.ts";
import type { PaperRecord, ProvenanceProvider, SearchRun } from "../domain/literature-types.ts";
import { primaryIdentifier } from "./literature-query-planning.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface FilterGroupOptions {
	includeTerms?: string[];
	excludeTerms?: string[];
	excludeScope?: "title" | "title+abstract";
	yearFrom?: number;
	yearTo?: number;
	venueRank?: "A" | "B" | "C";
	limit?: number;
}

export interface FilteredRecord {
	record: PaperRecord;
	matchedTerms: string[];
}

export function filterGroup(run: SearchRun, options: FilterGroupOptions): { matched: FilteredRecord[]; total: number } {
	const include = (options.includeTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
	const exclude = (options.excludeTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
	const excludeTitleOnly = options.excludeScope === "title";
	const matched: FilteredRecord[] = [];
	for (const record of run.results) {
		const title = record.title.toLowerCase();
		const abstract = (record.abstract ?? "").toLowerCase();
		const haystack = `${title}\n${abstract}`;
		if (include.length > 0 && !include.some((term) => haystack.includes(term))) continue;
		const excludeHaystack = excludeTitleOnly ? title : haystack;
		if (exclude.some((term) => excludeHaystack.includes(term))) continue;
		if (options.yearFrom && (record.year ?? 0) < options.yearFrom) continue;
		if (options.yearTo && (record.year ?? 9999) > options.yearTo) continue;
		if (options.venueRank && record.venueRank !== options.venueRank) continue;
		matched.push({
			record,
			matchedTerms: include.filter((term) => haystack.includes(term)),
		});
	}
	matched.sort((left, right) => (right.record.citationCount ?? 0) - (left.record.citationCount ?? 0));
	return { matched, total: matched.length };
}

/** include_terms 任一命中即保留(OR); exclude_terms 任一命中即排除。 */
export function filterSearchRunResults(
	run: SearchRun,
	options: FilterGroupOptions,
): { matched: PaperRecord[]; total: number; matchedTerms: Map<string, string[]> } {
	const { matched, total } = filterGroup(run, options);
	return {
		matched: matched.map((entry) => entry.record),
		total,
		matchedTerms: new Map(matched.map((entry) => [entry.record.id, entry.matchedTerms])),
	};
}

export function filterTableLines(entries: FilteredRecord[], options: FilterGroupOptions): string[] {
	const rows = entries.slice(0, options.limit ?? 60);
	const header = "标题(命中词) | 作者 | 年份 | venue | DOI/arXiv | 来源";
	const separator = "--- | --- | --- | --- | --- | ---";
	const body = rows.map((entry) => {
		const record = entry.record;
		const providers = new Set<ProvenanceProvider>(record.provenance.map((item) => item.provider));
		const titleMark =
			entry.matchedTerms.length > 0 ? `${record.title} [${entry.matchedTerms.join(", ")}]` : record.title;
		return [
			titleMark.replaceAll("|", "\\|"),
			record.authors.slice(0, 4).join(", ") || "unavailable",
			record.year === undefined ? "unknown" : String(record.year),
			record.venue || record.publicationType || "unknown",
			primaryIdentifier(record),
			[...providers].join(", ") || "unknown",
		]
			.map((cell) => cell.replace(/\s+/g, " ").trim())
			.join(" | ");
	});
	return [
		header,
		separator,
		...body,
		entries.length > rows.length ? `(${entries.length - rows.length} more filtered rows not shown)` : "",
	].filter(Boolean);
}

export function corpusTeamReviewPlan(
	store: LiteratureStore,
	records: PaperRecord[],
	decision: "team-approved" | "team-rejected",
	reviewer: string,
	reason?: string,
): OperationPlan {
	const recordIds = records.map((record) => record.id).sort();
	return {
		kind: "team-review",
		summary: `${decision === "team-approved" ? "Approve" : "Reject"} ${recordIds.length} local team proposal(s)`,
		actor: reviewer,
		targets: recordIds.map((id) => ({ label: "team-paper", value: id, risk: "high" })),
		details: {
			corpusPath: store.root,
			namespace: store.namespace,
			recordIds,
			recordsFingerprint: sha256Text(
				JSON.stringify([...records].sort((left, right) => left.id.localeCompare(right.id))),
			),
			decision,
			reason,
		},
	};
}

export function corpusPromotionPlan(
	source: LiteratureStore,
	target: LiteratureStore,
	records: PaperRecord[],
	contributor: string,
): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "team-proposal",
		summary: `Propose ${normalized.length} personal literature record(s) to the local team corpus`,
		actor: contributor,
		targets: normalized.map((record) => ({ label: record.title.slice(0, 120), value: record.id, risk: "high" })),
		details: {
			sourcePath: source.root,
			targetPath: target.root,
			sourceNamespace: source.namespace,
			targetNamespace: target.namespace,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			privacy: "Personal notes and screening decisions are removed by the team proposal write path.",
		},
	};
}
