import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactSidebarRows, resolveSidebarSelection } from "../src/literature/application/literature-sidebar.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";

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

function record(id: string, title: string): PaperRecord {
	return {
		id,
		title,
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
				'<!-- paper-agent-sidebar-meta {"fields":["title","focus"],"rows":[{"paper_id":"paper-a","search_run_id":"run-a","focus":"static"},{"paper_id":"paper-b","search_run_id":"run-b","focus":"dynamic"},{"title":"Model only","curated":"llm"}]} -->',
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

	it("reports selected ids that are not backed by sidebar search metadata", async () => {
		const { root, store } = await makeStore();
		await store.saveSearchRun(run("run-a", [record("paper-a", "Paper A")]));
		const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(resultsDir, "subset.md"),
			'<!-- paper-agent-sidebar-meta {"fields":["title"],"rows":[{"paper_id":"paper-a","search_run_id":"run-a"}]} -->',
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

describe("compactSidebarRows", () => {
	it("keeps abstracts out of persisted sidebar metadata", () => {
		expect(compactSidebarRows([{ paper_id: "paper-a", abstract: "Large abstract", focus: "kernel" }])).toEqual([
			{ paper_id: "paper-a", focus: "kernel" },
		]);
	});
});
