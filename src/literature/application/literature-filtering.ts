import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { sha256Text } from "../domain/literature-identifiers.ts";
import type { PaperRecord, SearchRun } from "../domain/literature-types.ts";
import type { FilterResultEntry } from "./literature-filter-result.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface FilterGroupOptions {
	includeTerms?: string[];
	includeTermGroups?: string[][];
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
	status: "matched" | "unresolved";
}

export function filterGroup(
	run: SearchRun,
	options: FilterGroupOptions,
): {
	matched: FilteredRecord[];
	unresolved: FilteredRecord[];
	total: number;
	excluded: number;
} {
	const include = (options.includeTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
	const includeGroups = (options.includeTermGroups ?? [])
		.map((group) => group.map((term) => term.trim().toLowerCase()).filter(Boolean))
		.filter((group) => group.length > 0);
	if (include.length && includeGroups.length) {
		throw new Error("include_terms and include_term_groups cannot be used together");
	}
	const exclude = (options.excludeTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
	const excludeTitleOnly = options.excludeScope === "title";
	const matched: FilteredRecord[] = [];
	const unresolved: FilteredRecord[] = [];
	for (const record of run.results) {
		const title = record.title.toLowerCase();
		const abstract = (record.abstract ?? "").toLowerCase();
		const haystack = `${title}\n${abstract}`;
		const excludeHaystack = excludeTitleOnly ? title : haystack;
		if (exclude.some((term) => excludeHaystack.includes(term))) continue;
		if (options.yearFrom && (record.year ?? 0) < options.yearFrom) continue;
		if (options.yearTo && (record.year ?? 9999) > options.yearTo) continue;
		if (options.venueRank && record.venueRank !== options.venueRank) continue;
		if (include.length > 0 && !include.some((term) => haystack.includes(term))) continue;
		const allGroupsMatch = includeGroups.every((group) => group.some((term) => haystack.includes(term)));
		const matchedTerms = (includeGroups.length ? includeGroups.flat() : include).filter((term) =>
			haystack.includes(term),
		);
		if (includeGroups.length && !allGroupsMatch) {
			if (!record.abstract) unresolved.push({ record, matchedTerms, status: "unresolved" });
			continue;
		}
		matched.push({
			record,
			matchedTerms,
			status: "matched",
		});
	}
	const byCitations = (left: FilteredRecord, right: FilteredRecord) =>
		(right.record.citationCount ?? 0) - (left.record.citationCount ?? 0);
	matched.sort(byCitations);
	unresolved.sort(byCitations);
	return {
		matched,
		unresolved,
		total: matched.length,
		excluded: run.results.length - matched.length - unresolved.length,
	};
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

export function filterTableLines(entries: FilterResultEntry[]): string[] {
	return entries.map(
		(entry) => `paper_id=${entry.paperId} | title=${entry.title.replaceAll("|", "\\|").replace(/\s+/g, " ").trim()}`,
	);
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
