import { ResearchCanvasStore } from "../src/canvas/infrastructure/research-canvas-store.ts";
import { SearchRunGraphs } from "../src/canvas/application/search-run-graphs.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { stageBrowserLiterature } from "../src/literature/application/literature-browser-import.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { registerCollectionTools } from "../src/literature/presentation/collection-tools.ts";

const roots: string[] = [];
async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-browser-import-"));
	roots.push(root);
	return root;
}
const sourceUrl = "https://scholar.google.com/citations?user=example";
const first = {
	title: "LLM static analysis",
	authors: ["Ada Researcher"],
	year: 2025,
	doi: "10.1234/first",
	abstract: "A static analysis method",
	url: "https://example.org/first",
};
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("browser metadata Search Runs", () => {
	it("persists candidates and original source without adding personal papers, then appends and deduplicates pages", async () => {
		const root = await workspace();
		const run = await stageBrowserLiterature(root, {
			sourceUrl,
			label: "Ada Researcher",
			records: [first],
			expectedCount: 3,
		});
		expect(run.coverage?.status).toBe("partial");
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		expect(await store.listPapers()).toEqual([]);
		expect((await store.getSearchRun(run.id))?.results[0].provenance[0]).toMatchObject({
			provider: "json-import",
			rawUrl: sourceUrl,
		});
		const appended = await stageBrowserLiterature(root, {
			sourceUrl,
			label: "Ada Researcher",
			records: [first, { ...first, title: "LLM dynamic analysis", doi: "10.1234/second" }],
			appendTo: run.id,
			complete: true,
			expectedCount: 3,
		});
		expect(appended.id).toBe(run.id);
		expect(appended.results).toHaveLength(2);
		expect(appended.coverage?.status).toBe("partial");
		const finished = await stageBrowserLiterature(root, {
			sourceUrl,
			label: "Ada Researcher",
			records: [{ ...first, title: "LLM verification", doi: "10.1234/third" }],
			appendTo: run.id,
			complete: true,
			expectedCount: 3,
		});
		expect(finished.coverage?.status).toBe("complete");
		expect(finished.results).toHaveLength(3);
		expect(await store.listSearchRuns()).toHaveLength(1);
		expect(await store.listPapers()).toEqual([]);
	});
	it("keeps concurrent appended pages and refuses mismatched source URLs or malformed records", async () => {
		const root = await workspace();
		const run = await stageBrowserLiterature(root, { sourceUrl, label: "Ada", records: [] });
		await Promise.all(
			[1, 2, 3].map((index) =>
				stageBrowserLiterature(root, {
					sourceUrl,
					label: "Ada",
					records: [{ ...first, doi: `10.1234/page${index}`, title: `${first.title} ${index}` }],
					appendTo: run.id,
				}),
			),
		);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		expect((await store.getSearchRun(run.id))?.results).toHaveLength(3);
		await expect(
			stageBrowserLiterature(root, {
				sourceUrl: "https://example.org/other",
				label: "Ada",
				records: [],
				appendTo: run.id,
			}),
		).rejects.toThrow("相同网页");
		await expect(
			stageBrowserLiterature(root, { sourceUrl, label: "Ada", records: [{ ...first, authors: [] }] }),
		).rejects.toThrow("作者");
		await expect(
			stageBrowserLiterature(root, { sourceUrl: "javascript:alert(1)", label: "Ada", records: [first] }),
		).rejects.toThrow("HTTP(S)");
		expect(await store.listSearchRuns()).toHaveLength(1);
	});
	it("feeds the existing filter and sidebar tools with stable candidate IDs", async () => {
		const root = await workspace();
		const tools = new Map<string, any>();
		registerCollectionTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
		const ctx = { cwd: root, hasUI: false };
		const staged = await tools.get("stage_browser_literature").execute(
			"stage",
			{
				source_url: sourceUrl,
				label: "Ada",
				records: [first, { title: "LLM program verification", authors: ["Ada Researcher"] }],
			},
			undefined,
			undefined,
			ctx,
		);
		const filtered = await tools.get("filter_search_run_results").execute(
			"filter",
			{
				search_run_id: staged.details.searchRunId,
				groups: [{ with_abstract: { include_terms: ["LLM"] }, without_abstract: { include_terms: ["LLM"] } }],
			},
			undefined,
			undefined,
			ctx,
		);
		const sidebar = await tools.get("update_literature_sidebar").execute(
			"sidebar",
			{
				search_run_id: staged.details.searchRunId,
				filter_result_id: filtered.details.filterResultId,
				fields: ["title", "authors", "year", "identifier"],
				annotation_fields: [],
				annotations: [],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(sidebar.details.rowCount).toBe(2);
		expect(await readFile(sidebar.details.mdPath, "utf8")).toContain(first.title);
		expect(await new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal").listPapers()).toEqual([]);
	});
});

it("stages Scholar author pages with inclusive years, unknown-year audit and direct graph access", async () => {
	const root = await workspace();
	const profile = "https://scholar.google.com/citations?user=NuzUkMEAAAAJ&hl=zh-CN";
	const run = await stageBrowserLiterature(root, {
		sourceUrl: profile,
		label: "Observed Author",
		yearFrom: 2024,
		yearTo: 2026,
		records: [
			{ ...first, title: "Older", year: 2023, doi: "10.1234/old" },
			first,
			{ ...first, title: "Unknown year", year: undefined, doi: "10.1234/unknown" },
		],
		complete: true,
		expectedCount: 3,
	});
	expect(run.runKind).toBe("author-expansion");
	expect(run.results.map((p) => p.title)).toEqual([first.title]);
	expect(run.authorExpansion?.sources["google-scholar"]).toMatchObject({
		authorId: "NuzUkMEAAAAJ",
		status: "partial",
		fetchedCount: 1,
	});
	expect(run.browserCollection).toMatchObject({ excludedYearCount: 1, unknownYearCount: 1 });
	const appended = await stageBrowserLiterature(root, {
		sourceUrl: "https://scholar.google.com/citations?user=NuzUkMEAAAAJ&hl=en&sortby=pubdate",
		label: "Observed Author",
		appendTo: run.id,
		records: [
			{ ...first, title: "At lower bound", year: 2024, doi: "10.1234/lower" },
			{ ...first, title: "At upper bound", year: 2026, doi: "10.1234/upper" },
			{ ...first, title: "Unknown year", year: 2026, doi: "10.1234/unknown" },
		],
		complete: true,
		expectedCount: 5,
	});
	expect(appended.results).toHaveLength(4);
	expect(appended.filters).toMatchObject({ yearFrom: 2024, yearTo: 2026 });
	expect(appended.browserCollection?.observed).toHaveLength(5);
	expect(appended.coverage?.status).toBe("complete");
	const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal"),
		canvas = new ResearchCanvasStore(store.databasePath).create("Author");
	const graphs = new SearchRunGraphs(store, canvas.id);
	await graphs.show(run.id, "user");
	expect(graphs.views.get(run.id)?.title).toBe("作者检索：Observed Author");
	const graph = await graphs.graph(run.id);
	expect(graph.nodes).toHaveLength(4);
	expect(graph.edges).toEqual([]);
	expect(graph.nodes?.some((n) => n.isSeed)).toBe(false);
	expect(await store.listPapers()).toEqual([]);
	await expect(
		stageBrowserLiterature(root, {
			sourceUrl: profile,
			label: "Author",
			appendTo: run.id,
			yearFrom: 2025,
			records: [],
		}),
	).rejects.toThrow("年份范围");
	await expect(
		stageBrowserLiterature(root, { sourceUrl: profile, label: "Author", yearFrom: 2026, yearTo: 2024, records: [] }),
	).rejects.toThrow("开始年份");
});
it("uses Scholar publication identity across pagination without merging different same-title papers", async () => {
	const root = await workspace(),
		profile = "https://scholar.google.com/citations?user=profile";
	const link = (id: string) =>
		`https://scholar.google.com/citations?view_op=view_citation&user=profile&citation_for_view=profile:${id}`;
	const record = { title: "A repeated title", authors: ["Author"], year: 2025, url: link("one") };
	const run = await stageBrowserLiterature(root, {
		sourceUrl: profile,
		label: "Author",
		records: [record, { ...record, url: link("two") }],
		note: "CAPTCHA after first page",
	});
	expect(run.results).toHaveLength(2);
	expect(run.coverage?.status).toBe("partial");
	const appended = await stageBrowserLiterature(root, {
		sourceUrl: profile,
		label: "Author",
		appendTo: run.id,
		records: [{ ...record, title: "A corrected title" }],
	});
	expect(appended.results).toHaveLength(2);
	expect(appended.results.find((p) => p.id === run.results[0].id)).toBeDefined();
});
