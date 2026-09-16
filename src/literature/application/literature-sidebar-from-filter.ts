import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import { fingerprintSearchRun, readFilterResult } from "./literature-filter-result.ts";
import { primaryIdentifier } from "./literature-query-planning.ts";
import { writeLiteratureSidebarResult } from "./literature-sidebar.ts";
import { LiteratureStore } from "./literature-store.ts";

export interface FilterSidebarAnnotation {
	paperId: string;
	focus?: string;
	relevance?: string;
	topic?: string;
}

function clean(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function linkedTitle(title: string, url: string | undefined): string {
	const label = cell(title).replace(/[[\]]/g, "\\$&");
	return url ? `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20")})` : label;
}

export async function writeSidebarFromFilter(input: {
	cwd: string;
	sessionId?: string;
	filterResultId: string;
	searchRunId: string;
	annotations: FilterSidebarAnnotation[];
}): Promise<{
	mdPath: string;
	mdUrl: string;
	rowCount: number;
	revision: number;
	unannotatedCount: number;
	matched: number;
	unresolved: number;
}> {
	const snapshot = await readFilterResult(input.cwd, input.sessionId, input.filterResultId);
	if (snapshot.searchRunId !== input.searchRunId) {
		throw new Error("filter_result_id and search_run_id do not match");
	}
	if (snapshot.entries.length === 0) throw new Error("Filter result has no retained papers");
	const store = new LiteratureStore(snapshot.corpusRoot, "personal", snapshot.namespace);
	const run = await store.getSearchRun(snapshot.searchRunId);
	if (!run || run.namespace !== snapshot.namespace) {
		throw new Error("Filter result source search run is unavailable; run filter_search_run_results again");
	}
	const byId = new Map(run.results.map((record) => [record.id, record]));
	const selected = new Set<string>();
	for (const entry of snapshot.entries) {
		if (selected.has(entry.paperId)) throw new Error(`Duplicate Paper ID in filter result: ${entry.paperId}`);
		selected.add(entry.paperId);
		const record = byId.get(entry.paperId);
		if (!record) {
			throw new Error(
				`Paper ID ${entry.paperId} no longer exists in the search run; run filter_search_run_results again`,
			);
		}
		if (record.title !== entry.title) {
			throw new Error(`Filter result is stale for Paper ID ${entry.paperId}; run filter_search_run_results again`);
		}
	}
	if (fingerprintSearchRun(run) !== snapshot.runFingerprint) {
		throw new Error("Filter result is stale because the search run changed; run filter_search_run_results again");
	}
	const annotations = new Map<string, FilterSidebarAnnotation>();
	for (const annotation of input.annotations) {
		if (!selected.has(annotation.paperId)) throw new Error(`Unknown annotation Paper ID: ${annotation.paperId}`);
		if (annotations.has(annotation.paperId)) throw new Error(`Duplicate annotation Paper ID: ${annotation.paperId}`);
		annotations.set(annotation.paperId, annotation);
	}
	const rows: Array<Record<string, unknown>> = [];
	const table = ["| 标题 | 年份/venue | 标识 | focus |", "| --- | --- | --- | --- |"];
	let unannotatedCount = 0;
	for (const entry of snapshot.entries) {
		const record = byId.get(entry.paperId)!;
		const annotation = annotations.get(entry.paperId);
		const focus = clean(annotation?.focus);
		const relevance = clean(annotation?.relevance);
		const topic = clean(annotation?.topic);
		if (!focus || !relevance || !topic) unannotatedCount += 1;
		const displayFocus = focus ?? (entry.status === "unresolved" ? "待复核" : "待标注");
		const url = paperPrimaryUrl(record);
		const row: Record<string, unknown> = {
			title: record.title,
			paper_id: record.id,
			search_run_id: run.id,
			namespace: snapshot.namespace,
			screening_status: entry.status,
			curated: "search",
			focus: displayFocus,
			...(relevance ? { relevance } : {}),
			...(topic ? { topic } : {}),
			...(focus || relevance || topic ? { annotation_basis: "title" } : {}),
			authors: record.authors.join(", "),
		};
		if (url) row.url = url;
		if (record.year !== undefined) row.year = String(record.year);
		if (record.venue) row.venue = record.venue;
		if (record.identifiers.doi) row.doi = record.identifiers.doi;
		if (record.identifiers.arxivId) row.arxiv_id = record.identifiers.arxivId;
		if (record.citationCount !== undefined) row.citationCount = record.citationCount;
		const ccf = record.venueRank ?? lookupCcfLevel(record.venue);
		if (ccf) row.ccf = ccf;
		rows.push(row);
		table.push(
			`| ${linkedTitle(record.title, url)} | ${cell([record.year, record.venue || record.publicationType].filter(Boolean).join(" "))} | ${cell(primaryIdentifier(record))} | ${cell(`${displayFocus}${entry.status === "unresolved" && focus ? "（待复核）" : ""}`)} |`,
		);
	}
	const result = await writeLiteratureSidebarResult({
		cwd: input.cwd,
		sessionId: input.sessionId,
		content: table.join("\n"),
		rows,
		headers: ["标题", "年份/venue", "标识", "focus"],
	});
	return {
		...result,
		unannotatedCount,
		matched: snapshot.entries.filter((entry) => entry.status === "matched").length,
		unresolved: snapshot.entries.filter((entry) => entry.status === "unresolved").length,
	};
}
