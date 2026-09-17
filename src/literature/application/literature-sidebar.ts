import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaperRecord } from "../domain/literature-types.ts";
import { renderSidebarTable, type SidebarField, validateSidebarFields } from "./literature-sidebar-fields.ts";
import type { LiteratureStore } from "./literature-store.ts";

const SIDEBAR_RESULT_URL = /^\/api\/agent\/results\/([A-Za-z0-9._-]+\.md)$/;
export const SIDEBAR_META_COMMENT = /<!--\s*paper-agent-sidebar-meta\s+([\s\S]*?)\s*-->\s*$/;
export const MAX_SIDEBAR_BYTES = 5_000_000;

export interface SidebarResultMetadata {
	revision?: number;
	fields?: SidebarField[];
	rows?: Array<Record<string, unknown>>;
}

export interface SidebarSelectionRecord {
	record: PaperRecord;
	searchRunId: string;
	focus?: string;
}

export interface SidebarSelectionResolution {
	records: SidebarSelectionRecord[];
	missingPaperIds: string[];
	searchRunIds: string[];
}

export function compactSidebarRows(
	rows: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
	return rows?.map(({ abstract: _abstract, ...row }) => row);
}

export async function writeLiteratureSidebarResult(input: {
	cwd: string;
	sessionId?: string;
	fields: SidebarField[];
	rows: Array<Record<string, unknown>>;
}): Promise<{ mdPath: string; mdUrl: string; rowCount: number; revision: number }> {
	const fields = validateSidebarFields(input.fields);
	const content = renderSidebarTable(fields, input.rows);
	const metadata = {
		revision: 1,
		fields,
		rows: compactSidebarRows(input.rows) ?? [],
	};
	const payload = `${content}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(metadata)} -->\n`;
	if (Buffer.byteLength(payload, "utf8") > MAX_SIDEBAR_BYTES) {
		throw new Error("literature sidebar is too large (max 5MB); narrow the filter");
	}
	const resultsDir = join(input.cwd, ".paper-agent", "web-agent-memory", "results");
	await mkdir(resultsDir, { recursive: true });
	const safeSessionId = (input.sessionId ?? "unspecified").replace(/[^A-Za-z0-9-]/g, "_");
	const fileName = `${safeSessionId}-${Date.now().toString(36)}.md`;
	const mdPath = join(resultsDir, fileName);
	await writeFile(mdPath, payload, { encoding: "utf8" });
	return {
		mdPath,
		mdUrl: `/api/agent/results/${encodeURIComponent(fileName)}`,
		rowCount: metadata.rows.length,
		revision: 1,
	};
}

export function resolveSidebarResultPath(cwd: string, resultUrl: string): string {
	const match = SIDEBAR_RESULT_URL.exec(resultUrl);
	if (!match) throw new Error("Invalid literature sidebar result URL");
	return join(cwd, ".paper-agent", "web-agent-memory", "results", match[1]);
}

export function parseSidebarResultMetadata(content: string): SidebarResultMetadata {
	const metadataMatch = SIDEBAR_META_COMMENT.exec(content.trim());
	if (!metadataMatch) throw new Error("Literature sidebar result does not contain structured metadata");
	const metadata = JSON.parse(metadataMatch[1]) as SidebarResultMetadata;
	if (!metadata || typeof metadata !== "object") {
		throw new Error("Literature sidebar result metadata is invalid");
	}
	return metadata;
}

export async function readSidebarResultRows(cwd: string, resultUrl: string): Promise<Array<Record<string, unknown>>> {
	const content = await readFile(resolveSidebarResultPath(cwd, resultUrl), "utf8");
	const metadata = parseSidebarResultMetadata(content);
	if (!Array.isArray(metadata.rows)) throw new Error("Literature sidebar result does not contain paper rows");
	return metadata.rows.filter(
		(row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
	);
}

export async function resolveSidebarSelection(
	store: LiteratureStore,
	cwd: string,
	resultUrl: string,
	paperIds?: string[],
): Promise<SidebarSelectionResolution> {
	const rows = await readSidebarResultRows(cwd, resultUrl);
	const wanted = paperIds?.length ? new Set(paperIds) : undefined;
	const selectedRows = rows.filter(
		(row) =>
			row.curated !== "llm" &&
			typeof row.paper_id === "string" &&
			typeof row.search_run_id === "string" &&
			(!wanted || wanted.has(row.paper_id)),
	);
	const runCache = new Map<string, Awaited<ReturnType<LiteratureStore["getSearchRun"]>>>();
	const resolved = new Map<string, SidebarSelectionRecord>();
	for (const row of selectedRows) {
		const paperId = row.paper_id as string;
		const searchRunId = row.search_run_id as string;
		let run = runCache.get(searchRunId);
		if (!runCache.has(searchRunId)) {
			run = await store.getSearchRun(searchRunId);
			runCache.set(searchRunId, run);
		}
		const record = run?.results.find(
			(candidate) => candidate.id === paperId || candidate.mergedFrom.includes(paperId),
		);
		if (!record || resolved.has(paperId)) continue;
		resolved.set(paperId, {
			record,
			searchRunId,
			focus: typeof row.focus === "string" ? row.focus : undefined,
		});
	}
	const missingPaperIds = paperIds?.filter((paperId) => !resolved.has(paperId)) ?? [];
	return {
		records: [...resolved.values()],
		missingPaperIds,
		searchRunIds: [...new Set([...resolved.values()].map((item) => item.searchRunId))],
	};
}
