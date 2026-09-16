import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import { expansionPathRelationship } from "./literature-search-planning.ts";
import { LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";

const SIDEBAR_RESULT_URL = /^\/api\/agent\/results\/([A-Za-z0-9._-]+\.md)$/;
export const SIDEBAR_META_COMMENT = /<!--\s*paper-agent-sidebar-meta\s+([\s\S]*?)\s*-->\s*$/;
export const MAX_SIDEBAR_BYTES = 5_000_000;

export interface SidebarResultMetadata {
	revision?: number;
	headers?: string[];
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
	content: string;
	rows: Array<Record<string, unknown>>;
	headers?: string[];
}): Promise<{ mdPath: string; mdUrl: string; rowCount: number; revision: number }> {
	const content = input.content.trim();
	if (!content) throw new Error("content is required");
	const metadata = {
		revision: 1,
		...(input.headers?.length ? { headers: input.headers } : {}),
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

export function scrapeRowsFromMarkdown(content: string): Array<Record<string, unknown>> | undefined {
	const lines = content.split(/\r?\n/);
	const rows: Array<Record<string, unknown>> = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line.startsWith("|") || !line.endsWith("|")) continue;
		const cells = line
			.slice(1, -1)
			.split("|")
			.map((cell) => cell.trim());
		if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
		if (/^(标题|title)$/i.test(cells[0] ?? "")) continue;
		const titleCell = cells[0] ?? "";
		const titleMatch = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(titleCell);
		const title = titleMatch ? titleMatch[1] : titleCell;
		const url = titleMatch?.[2];
		const idCell = cells[2] ?? "";
		const doiMatch =
			/^doi\s*[::]?\s*(.+)/i.exec(idCell) ||
			/^doi\s*[::]?\s*(.+)/i.exec(cells.find((cell) => /^doi/i.test(cell)) ?? "");
		const doi = doiMatch?.[1]?.trim() || undefined;
		const yearVenue = cells[1] ?? "";
		const yearMatch = /^(\d{4})/.exec(yearVenue);
		const year = yearMatch?.[1] ?? undefined;
		const venue = yearMatch ? yearVenue.slice(yearMatch[0].length).trim() || undefined : undefined;
		const focus = cells[cells.length - 1];
		const row: Record<string, unknown> = { title };
		if (url) row.url = url;
		if (doi) row.doi = doi;
		if (year) row.year = year;
		if (venue) row.venue = venue;
		if (focus) row.focus = focus;
		rows.push(row);
	}
	return rows.length ? rows : undefined;
}

export function mergeSidebarRows(
	content: string,
	rows: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
	const scraped = scrapeRowsFromMarkdown(content);
	if (!rows?.length) return scraped;
	if (!scraped?.length) return rows;
	if (scraped.length !== rows.length) {
		throw new Error(
			`rows must align with the markdown table (${rows.length} metadata rows for ${scraped.length} table rows)`,
		);
	}
	return scraped.map((row, index) => ({ ...row, ...rows[index] }));
}

/**
 * 从个人语料的搜索 run 记录里按 paper_id/标题/DOI 匹配, 自动补齐侧边栏 rows 缺失的
 * abstract/doi/year/venue/authors/citationCount, 确保点击标题能展开摘要。
 */
export async function enrichSidebarRows(
	cwd: string,
	searchRunId: string | undefined,
	rows: Array<Record<string, unknown>> | undefined,
): Promise<Array<Record<string, unknown>> | undefined> {
	if (!rows?.length) return rows;
	const store = new LiteratureStore(resolveCorpusRoot(cwd, "personal", "default"), "personal", "default");
	const normalize = (value: string | undefined) => (value ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") : "");
	// 宽松标题: 先去掉括号注释(如 "(UAFuzz)" 后缀)再 normalize, 供标题匹配使用。
	const normalizeLoose = (value: string | undefined) => {
		if (!value) return "";
		const stripped = value.replace(/\([^)]*\)/g, " ");
		return normalize(stripped);
	};

	// 汇总一张记录表: 优先用指定 run; 否则合并所有 run 的记录,
	// 并且以“带摘要优先”去重, 以便同一论文在不同 run 中有一条能取到摘要。
	// 同时记录每篇记录所属的 search run, 用于保存到个人库时反查 search_run_id。
	let candidates: PaperRecord[] = [];
	const recordRunId = new Map<string, string>();
	const noteRun = (records: PaperRecord[], runId: string) => {
		for (const record of records) {
			if (!recordRunId.has(record.id)) recordRunId.set(record.id, runId);
			const doi = record.identifiers?.doi;
			if (doi) {
				const key = `doi:${normalize(doi)}`;
				if (!recordRunId.has(key)) recordRunId.set(key, runId);
			}
		}
	};
	if (searchRunId) {
		const run = await store.getSearchRun(searchRunId);
		if (run) {
			candidates = run.results;
			noteRun(run.results, run.id);
		}
	}
	if (!candidates.length) {
		try {
			const runs = await store.listSearchRuns();
			for (const run of runs) {
				candidates.push(...run.results);
				noteRun(run.results, run.id);
			}
		} catch {
			// 无法遍历 run 时忽略。
		}
	}
	if (!candidates.length) {
		try {
			candidates = await store.listPapers();
		} catch {
			// 语料不可读时忽略, 返回原 rows。
		}
	}
	if (!candidates.length) return rows;

	// 按 key 去重, 保留带摘要的那条。
	const byId = new Map<string, PaperRecord>();
	const byDoi = new Map<string, PaperRecord>();
	const byTitle = new Map<string, PaperRecord>();
	const byTitleLoose = new Map<string, PaperRecord>();
	const prefer = (current: PaperRecord | undefined, next: PaperRecord) => {
		if (!current) return next;
		if (!current.abstract && next.abstract) return next;
		return current;
	};
	for (const record of candidates) {
		byId.set(record.id, prefer(byId.get(record.id), record));
		const doi = record.identifiers?.doi;
		if (doi) byDoi.set(normalize(doi), prefer(byDoi.get(normalize(doi)), record));
		const title = normalize(record.title);
		if (title) byTitle.set(title, prefer(byTitle.get(title), record));
		const loose = normalizeLoose(record.title);
		if (loose && !byTitleLoose.has(loose)) byTitleLoose.set(loose, prefer(byTitleLoose.get(loose), record));
	}

	return rows.map((row) => {
		let record: PaperRecord | undefined;
		if (typeof row.paper_id === "string") record = byId.get(row.paper_id);
		if (!record && typeof row.doi === "string") record = byDoi.get(normalize(row.doi));
		if (!record && typeof row.title === "string") {
			record = byTitle.get(normalize(row.title));
			if (!record) {
				// 模型可能在标题里加了括号注释(如 "(UAFuzz)"), 用去括号后的标题再试一次。
				const loose = normalizeLoose(row.title);
				record = loose && byTitleLoose.get(loose) ? byTitleLoose.get(loose) : undefined;
			}
		}
		if (!record) {
			// 找不到对应搜索记录: 说明是模型凭知识补充的论文, 标注来源, 无法入库。
			const { paper_id: _paperId, search_run_id: _searchRunId, ...unverified } = row;
			const marked: Record<string, unknown> = { ...unverified, curated: "llm" };
			return marked;
		}
		const enriched: Record<string, unknown> = { ...row, paper_id: record.id, curated: "search" };
		if (!row.abstract && record.abstract) enriched.abstract = record.abstract;
		if (record.identifiers?.doi) enriched.doi = record.identifiers.doi;
		if (!row.year && record.year !== undefined) enriched.year = String(record.year);
		if (!row.venue && record.venue) enriched.venue = record.venue;
		if (!row.url) enriched.url = paperPrimaryUrl(record);
		if (!row.authors && record.authors?.length) enriched.authors = record.authors.join(", ");
		if (row.citationCount === undefined && record.citationCount !== undefined)
			enriched.citationCount = record.citationCount;
		// 行缺标题时从记录补齐(有些行标题为空字符串)。
		if (!enriched.title && record.title) enriched.title = record.title;
		// 提取关系标签(reference/citation), 供前端显示"引用/被引"标识。
		if (typeof enriched.relationship !== "string") {
			const relPath = (record.discoveryPaths ?? []).find((path) => expansionPathRelationship(path));
			const relationship = relPath ? expansionPathRelationship(relPath) : undefined;
			if (relationship) enriched.relationship = relationship;
		}
		// 从 venue 本地查 CCF 等级(A/B/C), 供侧边栏展示。
		if (typeof row.ccf !== "string") {
			const ccf = record.venueRank ?? lookupCcfLevel(record.venue);
			if (ccf) enriched.ccf = ccf;
		}
		// 补 search_run_id: 供保存到个人库时定位 run(避免 searchJobId or searchRunId is required)。
		const runId = recordRunId.get(record.id);
		const doiKey = record.identifiers?.doi ? `doi:${normalize(record.identifiers.doi)}` : undefined;
		const resolved = runId ?? (doiKey ? recordRunId.get(doiKey) : undefined);
		if (resolved) enriched.search_run_id = resolved;
		return enriched;
	});
}
