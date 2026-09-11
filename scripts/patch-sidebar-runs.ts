/**
 * 给论文清单 md 增量补齐 search_run_id / CCF, 保留已有的 relevance/topic/abstract 等字段。
 * 用法: node scripts/patch-sidebar-runs.ts <md文件路径...>
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";

const cwd = process.cwd();
const store = new LiteratureStore(resolveCorpusRoot(cwd, "personal", "default"), "personal", "default");

const normalize = (value: string | undefined) =>
	value ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") : "";

// 汇总所有 run 的记录 + 记录所属 run id
const runs = await store.listSearchRuns();
const byId = new Map<string, PaperRecord>();
const byDoi = new Map<string, PaperRecord>();
const byTitle = new Map<string, PaperRecord>();
const runIdById = new Map<string, string>();
const runIdByDoi = new Map<string, string>();
const runIdByTitle = new Map<string, string>();
const prefer = (current: PaperRecord | undefined, next: PaperRecord) => {
	if (!current) return next;
	if (!current.abstract && next.abstract) return next;
	return current;
};
for (const run of runs) {
	for (const record of run.results) {
		const old = byId.get(record.id);
		byId.set(record.id, prefer(old, record));
		if (!runIdById.has(record.id)) runIdById.set(record.id, run.id);
		const doi = record.identifiers?.doi;
		if (doi) {
			byDoi.set(normalize(doi), prefer(byDoi.get(normalize(doi)), record));
			if (!runIdByDoi.has(normalize(doi))) runIdByDoi.set(normalize(doi), run.id);
		}
		const title = normalize(record.title);
		if (title) {
			byTitle.set(title, prefer(byTitle.get(title), record));
			if (!runIdByTitle.has(title)) runIdByTitle.set(title, run.id);
		}
	}
}

function resolveRunId(row: Record<string, unknown>): string | undefined {
	if (typeof row.search_run_id === "string") return row.search_run_id;
	if (typeof row.paper_id === "string" && runIdById.has(row.paper_id)) return runIdById.get(row.paper_id);
	if (typeof row.doi === "string" && runIdByDoi.has(normalize(row.doi))) return runIdByDoi.get(normalize(row.doi));
	if (typeof row.title === "string" && runIdByTitle.has(normalize(row.title))) return runIdByTitle.get(normalize(row.title));
	return undefined;
}

function resolveRecord(row: Record<string, unknown>): PaperRecord | undefined {
	if (typeof row.paper_id === "string" && byId.has(row.paper_id)) return byId.get(row.paper_id);
	if (typeof row.doi === "string" && byDoi.has(normalize(row.doi))) return byDoi.get(normalize(row.doi));
	if (typeof row.title === "string" && byTitle.has(normalize(row.title))) return byTitle.get(normalize(row.title));
	return undefined;
}

for (const target of process.argv.slice(2)) {
	const raw = await readFile(target, "utf8");
	const content = raw.replace(/<!--\s*paper-agent-sidebar-meta[\s\S]*?-->\s*$/, "").trimEnd();
	const metaMatch = raw.match(/paper-agent-sidebar-meta ([\s\S]*?) -->/);
	if (!metaMatch) {
		console.log(`跳过 ${target}: 无 meta`);
		continue;
	}
	const meta = JSON.parse(metaMatch[1]) as { headers?: string[]; rows?: Array<Record<string, unknown>> };
	const rows = meta.rows ?? [];
	let addedRun = 0;
	let addedCcf = 0;
	let addedPaperId = 0;
	for (const row of rows) {
		const record = resolveRecord(row);
		if (record) {
			if (typeof row.paper_id !== "string") {
				row.paper_id = record.id;
				addedPaperId++;
			}
			if (record.venueRank && typeof row.ccf !== "string") {
				row.ccf = record.venueRank;
				addedCcf++;
			}
			// 来自搜索记录的行标注为 search。
			if (typeof row.curated !== "string") row.curated = "search";
		} else {
			// 找不到搜索记录: 模型凭知识补充, 标注 llm, 无法入库。
			row.curated = "llm";
		}
		const runId = resolveRunId(row);
		if (runId && typeof row.search_run_id !== "string") {
			row.search_run_id = runId;
			addedRun++;
		}
	}
	const newMeta = { headers: meta.headers ?? ["标题", "年份/venue", "标识", "focus"], rows };
	const payload = `${content}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(newMeta)} -->\n`;
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, payload, "utf8");
	console.log(`${target.split("/").pop()} -> 补 paper_id ${addedPaperId}, 补 search_run_id ${addedRun}/${rows.length}, 补 ccf ${addedCcf}`);
}
