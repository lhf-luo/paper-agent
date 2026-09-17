import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchRun } from "../domain/literature-types.ts";

interface StoredFilterRule {
	includeTerms?: string[];
	includeTermGroups?: string[][];
	excludeTerms?: string[];
	excludeScope?: "title" | "title+abstract";
	yearFrom?: number;
	yearTo?: number;
	venueRank?: "A" | "B" | "C";
}

interface StoredFilterGroup {
	label?: string;
	withAbstract: StoredFilterRule;
	withoutAbstract: Omit<StoredFilterRule, "excludeScope">;
}

export interface FilterResultEntry {
	paperId: string;
	title: string;
	status: "matched" | "unresolved";
}

export interface StoredFilterResult {
	version: 2;
	searchRunId: string;
	parentFilterResultId?: string;
	runFingerprint: string;
	namespace: string;
	corpusRoot: string;
	rules: StoredFilterGroup[];
	sourceCount: number;
	rootTotal: number;
	entries: FilterResultEntry[];
}

const FILTER_RESULT_ID = /^[A-Za-z0-9_-]+$/;

export function fingerprintSearchRun(run: SearchRun): string {
	const records = run.results.map((record) => [
		record.id,
		record.title,
		record.abstract,
		record.year,
		record.venue,
		record.venueRank,
		record.identifiers,
		record.links,
	]);
	return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function filterResultPath(cwd: string, filterResultId: string): string {
	if (!FILTER_RESULT_ID.test(filterResultId)) throw new Error("Invalid filter_result_id");
	return join(cwd, ".paper-agent", "web-agent-memory", "filter-results", `${filterResultId}.json`);
}

function safeSessionId(sessionId: string | undefined): string {
	return (sessionId ?? "unspecified").replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function saveFilterResult(
	cwd: string,
	sessionId: string | undefined,
	result: StoredFilterResult,
): Promise<string> {
	const filterResultId = `${safeSessionId(sessionId)}-${randomUUID()}`;
	const path = filterResultPath(cwd, filterResultId);
	await mkdir(join(cwd, ".paper-agent", "web-agent-memory", "filter-results"), { recursive: true });
	await writeFile(path, JSON.stringify(result), { encoding: "utf8", flag: "wx", mode: 0o600 });
	return filterResultId;
}

export async function readFilterResult(
	cwd: string,
	sessionId: string | undefined,
	filterResultId: string,
): Promise<StoredFilterResult> {
	if (sessionId && !filterResultId.startsWith(`${safeSessionId(sessionId)}-`)) {
		throw new Error("The filter result does not belong to the current session");
	}
	const path = filterResultPath(cwd, filterResultId);
	let result: StoredFilterResult;
	try {
		result = JSON.parse(await readFile(path, "utf8")) as StoredFilterResult;
	} catch {
		throw new Error("Filter result is missing or invalid; run filter_search_run_results again");
	}
	if (
		result?.version !== 2 ||
		typeof result.searchRunId !== "string" ||
		typeof result.runFingerprint !== "string" ||
		typeof result.namespace !== "string" ||
		typeof result.corpusRoot !== "string" ||
		!Array.isArray(result.rules) ||
		!Number.isInteger(result.sourceCount) ||
		!Number.isInteger(result.rootTotal) ||
		!Array.isArray(result.entries) ||
		result.entries.some(
			(entry) =>
				!entry ||
				typeof entry.paperId !== "string" ||
				typeof entry.title !== "string" ||
				!(["matched", "unresolved"] as const).includes(entry.status),
		)
	) {
		throw new Error("Filter result is invalid; run filter_search_run_results again");
	}
	return result;
}
