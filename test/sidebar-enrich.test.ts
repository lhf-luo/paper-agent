import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactSidebarRows, resolveSidebarSelection } from "../src/literature/application/literature-sidebar.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";
import {
	enrichSidebarRows,
	mergeSidebarRows,
	scrapeRowsFromMarkdown,
} from "../src/literature/presentation/collection-tools.ts";

const tempDirs: string[] = [];

async function makeStore(): Promise<{ root: string; store: LiteratureStore }> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-"));
	tempDirs.push(root);
	const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
	return { root, store };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(id: string, title: string, abstract?: string, venueRank?: "A" | "B" | "C"): PaperRecord {
	return {
		id,
		title,
		...(abstract ? { abstract } : {}),
		...(venueRank ? { venueRank } : {}),
		authors: ["A. Author"],
		identifiers: {},
		links: [],
		provenance: [],
		mergedFrom: [],
	};
}

function run(id: string, results: PaperRecord[]): SearchRun {
	return {
		id,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:05.000Z",
		queries: ["test"],
		filters: {},
		providers: [],
		pagesPerProvider: 1,
		maxResultsPerProvider: 10,
		results,
		failures: [],
		sourceCounts: {},
		deduplicatedCount: results.length,
		scope: "personal",
		mode: "once",
		namespace: "default",
	};
}

describe("resolveSidebarSelection", () => {
	it("resolves one generated sidebar across multiple persisted search runs", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("paper-a", "Paper A")]));
		await store.saveSearchRun(run("run-b", [record("paper-b", "Paper B")]));
		const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(resultsDir, "combined.md"),
			[
				"| title | focus |",
				"| --- | --- |",
				"| Paper A | static |",
				"| Paper B | dynamic |",
				'<!-- paper-agent-sidebar-meta {"rows":[{"paper_id":"paper-a","search_run_id":"run-a","focus":"static"},{"paper_id":"paper-b","search_run_id":"run-b","focus":"dynamic"},{"title":"Model only","curated":"llm"}]} -->',
			].join("\n"),
			"utf8",
		);

		const result = await resolveSidebarSelection(store, root, "/api/agent/results/combined.md");

		expect(result.searchRunIds).toEqual(["run-a", "run-b"]);
		expect(result.records.map((item) => [item.record.id, item.focus])).toEqual([
			["paper-a", "static"],
			["paper-b", "dynamic"],
		]);
		expect(result.missingPaperIds).toEqual([]);
	});

	it("reports selected ids that are not backed by the sidebar search metadata", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("paper-a", "Paper A")]));
		const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(resultsDir, "subset.md"),
			'<!-- paper-agent-sidebar-meta {"rows":[{"paper_id":"paper-a","search_run_id":"run-a"}]} -->',
			"utf8",
		);

		const result = await resolveSidebarSelection(store, root, "/api/agent/results/subset.md", ["paper-a", "missing"]);
		expect(result.records.map((item) => item.record.id)).toEqual(["paper-a"]);
		expect(result.missingPaperIds).toEqual(["missing"]);
		await expect(resolveSidebarSelection(store, root, "../outside.md")).rejects.toThrow(
			"Invalid literature sidebar result URL",
		);
	});
});

describe("scrapeRowsFromMarkdown", () => {
	it("解析单张合并表并抓取 title/doi/year/venue/focus", () => {
		const md = `| 标题 | 年份/venue | 标识 | focus |
| --- | --- | --- | --- |
| [Paper One](https://doi.org/10.1/abc) | 2020 ACM TOPS | DOI 10.1/abc | 检测 |
| [Paper Two](https://arxiv.org/abs/1234) | 2021 arXiv | arXiv 1234 | 模糊测试 |`;
		const rows = scrapeRowsFromMarkdown(md);
		expect(rows).toHaveLength(2);
		expect(rows![0]).toMatchObject({
			title: "Paper One",
			url: "https://doi.org/10.1/abc",
			doi: "10.1/abc",
			year: "2020",
			venue: "ACM TOPS",
			focus: "检测",
		});
		expect(rows![1]).toMatchObject({ title: "Paper Two", year: "2021", venue: "arXiv", focus: "模糊测试" });
	});

	it("跳过表头与分隔行", () => {
		const md = `| 标题 | 年份/venue | 标识 | focus |
| --- | --- | --- | --- |
| [A](https://doi.org/10.1/a) | 2020 X | DOI 10.1/a | f |`;
		const rows = scrapeRowsFromMarkdown(md);
		expect(rows).toHaveLength(1);
		expect(rows![0].title).toBe("A");
	});
});

describe("mergeSidebarRows", () => {
	it("合并 Markdown 标题与结构化隐藏元数据", () => {
		const md = `| 标题 | 年份/venue | 标识 | focus |
| --- | --- | --- | --- |
| [Canonical Paper](https://doi.org/10.1/canonical) | 2024 JMLR | DOI 10.1/canonical | 理论 |`;
		const rows = mergeSidebarRows(md, [{ paper_id: "doi-10-1-canonical", curated: "search", relevance: "理论论文" }]);
		expect(rows).toEqual([
			expect.objectContaining({
				title: "Canonical Paper",
				doi: "10.1/canonical",
				paper_id: "doi-10-1-canonical",
				curated: "search",
				relevance: "理论论文",
			}),
		]);
	});

	it("拒绝与 Markdown 表格行数不一致的隐藏元数据", () => {
		const md = `| 标题 | 年份/venue | 标识 | focus |
| --- | --- | --- | --- |
| Paper One | 2024 JMLR | - | 理论 |`;
		expect(() => mergeSidebarRows(md, [{}, {}])).toThrow(/must align with the markdown table/);
	});
});

describe("enrichSidebarRows", () => {
	it("keeps abstracts out of persisted sidebar metadata", () => {
		expect(compactSidebarRows([{ paper_id: "paper-a", abstract: "Large abstract", focus: "kernel" }])).toEqual([
			{ paper_id: "paper-a", focus: "kernel" },
		]);
	});

	it("未给 run id 时, 从搜索 run 里按标题匹配并补全 abstract/year/venue/authors", async () => {
		const { root, store } = await makeStore();
		const paper = record("doi-1", "Learning-based Detection in Binary Code", "Abstract text here.");
		await store.saveSearchRun(run("run-a", [paper]));

		const rows = await enrichSidebarRows(root, undefined, [
			{ title: "Learning-based Detection in Binary Code", doi: "10.1145/x" },
		]);
		expect(rows).toHaveLength(1);
		expect(rows![0].abstract).toBe("Abstract text here.");
		expect(rows![0].year).toBeUndefined();
	});

	it("跨 run 合并时优先保留带摘要的那条", async () => {
		const { root, store } = await makeStore();
		const noAbs = record("doi-1", "Patch Matching", undefined);
		const withAbs = record("doi-1", "Patch Matching", "Has abstract.");
		await store.saveSearchRun(run("run-a", [noAbs]));
		await store.saveSearchRun(run("run-b", [withAbs]));

		const rows = await enrichSidebarRows(root, undefined, [{ title: "Patch Matching" }]);
		expect(rows![0].abstract).toBe("Has abstract.");
	});

	it("无匹配时保留原行", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("doi-1", "Something Else", "Abs")]));
		const rows = await enrichSidebarRows(root, undefined, [{ title: "Completely Different" }]);
		expect(rows![0].abstract).toBeUndefined();
	});

	it("从记录的 venueRank 补写 CCF 等级", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("doi-1", "A CCF-A Paper", "Abs", "A")]));
		const rows = await enrichSidebarRows(root, undefined, [{ title: "A CCF-A Paper" }]);
		expect(rows![0].ccf).toBe("A");
	});

	it("保留模型传入的 relevance/topic, 不覆盖", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("doi-1", "Kept Topics", "Abs")]));
		const rows = await enrichSidebarRows(root, undefined, [
			{ title: "Kept Topics", relevance: "高", topic: "机器学习;反编译代码" },
		]);
		expect(rows![0].relevance).toBe("高");
		expect(rows![0].topic).toBe("机器学习;反编译代码");
	});

	it("按标题命中后覆盖伪 paper_id 并写回搜索来源", async () => {
		const { root, store } = await makeStore();
		const paper = record("doi-canonical-hash", "Canonical Learning Theory", "Canonical abstract.");
		paper.identifiers.doi = "10.1000/canonical";
		await store.saveSearchRun(run("run-canonical", [paper]));

		const rows = await enrichSidebarRows(root, "run-canonical", [
			{
				title: "Canonical Learning Theory",
				paper_id: "doi-10-1000-canonical",
				curated: "llm",
			},
		]);
		expect(rows![0]).toMatchObject({
			paper_id: "doi-canonical-hash",
			doi: "10.1000/canonical",
			search_run_id: "run-canonical",
			curated: "search",
			abstract: "Canonical abstract.",
		});
	});

	it("无法匹配时清除伪搜索标识并标记为模型补充", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("doi-1", "Something Else", "Abs")]));
		const rows = await enrichSidebarRows(root, "run-a", [
			{
				title: "A Model Memory Paper",
				paper_id: "doi-invented",
				search_run_id: "run-a",
				curated: "search",
			},
		]);
		expect(rows![0]).toMatchObject({ title: "A Model Memory Paper", curated: "llm" });
		expect(rows![0].paper_id).toBeUndefined();
		expect(rows![0].search_run_id).toBeUndefined();
	});
});
