import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import {
	MAX_SIDEBAR_BYTES,
	parseSidebarResultMetadata,
	writeLiteratureSidebarResult,
} from "../src/literature/application/literature-sidebar.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";
import { registerCollectionTools } from "../src/literature/presentation/collection-tools.ts";
import { parseLiteratureTables } from "../web/src/literature-markdown.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(id: string): PaperRecord {
	return {
		id,
		title: `Consent paper ${id}`,
		authors: ["Ada Researcher"],
		year: 2026,
		identifiers: {},
		links: [{ kind: "landing", url: `https://example.org/${id}` }],
		provenance: [{ provider: "local-pdf", query: "fixture", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		curation: {
			tags: ["private-tag"],
			userNotes: [{ id: `note-${id}`, text: "private note", author: "Ada", createdAt: "2026-01-01T00:00:00.000Z" }],
			screening: {
				status: "include",
				updatedBy: "Ada",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	};
}

function searchRun(id: string, records: PaperRecord[]): SearchRun {
	return {
		id,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		queries: [id],
		filters: {},
		providers: [],
		pagesPerProvider: 1,
		maxResultsPerProvider: 20,
		results: records,
		failures: [],
		sourceCounts: {},
		deduplicatedCount: records.length,
		scope: "personal",
		mode: "once",
		namespace: "default",
	};
}

function registeredTools(): Map<string, any> {
	const tools = new Map<string, any>();
	registerCollectionTools({
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	return tools;
}

function context(root: string, confirm?: ReturnType<typeof vi.fn>) {
	return {
		cwd: root,
		hasUI: Boolean(confirm),
		ui: { confirm: confirm ?? vi.fn() },
	};
}

describe("collection tool mutation consent", () => {
	it("records duplicate decisions and merges same-work search records under the chosen id", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-duplicate-review-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const value = searchRun("run-duplicates", [paper("paper-a"), paper("paper-b")]);
		value.possibleDuplicates = [
			{ leftId: "paper-a", rightId: "paper-b", titleSimilarity: 0.97, reason: "similar-title" },
		];
		await store.saveSearchRun(value);

		const result = await registeredTools()
			.get("review_literature_duplicates")
			.execute(
				"review",
				{
					search_run_id: value.id,
					decisions: [{ left_id: "paper-a", right_id: "paper-b", decision: "same-work", reason: "same authors" }],
				},
				undefined,
				undefined,
				context(root),
			);

		expect(result.details).toMatchObject({ resultCount: 1, possibleDuplicates: [] });
		const stored = await store.getSearchRun(value.id);
		expect(stored?.results).toHaveLength(1);
		expect(stored?.results[0]).toMatchObject({ id: "paper-a", mergedFrom: ["paper-b"] });
		expect(stored?.identityDecisions).toMatchObject([{ decision: "same-work" }]);
	});

	it("reads sidebar pages and selected search abstracts on demand", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-read-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const first = { ...paper("paper-a"), abstract: "First abstract" };
		const second = { ...paper("paper-b"), abstract: "Second abstract" };
		await store.saveSearchRun(searchRun("run-a", [first, second]));
		const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(resultsDir, "read.md"),
			'<!-- paper-agent-sidebar-meta {"rows":[{"title":"First","paper_id":"paper-a","search_run_id":"run-a"},{"title":"Second","paper_id":"paper-b","search_run_id":"run-a"}]} -->',
			"utf8",
		);

		const tools = registeredTools();
		const page = await tools
			.get("inspect_literature_sidebar")
			.execute(
				"inspect",
				{ result_url: "/api/agent/results/read.md", limit: 1 },
				undefined,
				undefined,
				context(root),
			);
		expect(page.details).toMatchObject({ total: 2, nextOffset: 1 });
		expect(page.content[0].text).toContain("paper_id=paper-a");

		const selected = await tools
			.get("get_search_run_papers")
			.execute(
				"read-paper",
				{ search_run_id: "run-a", paper_ids: ["paper-b"] },
				undefined,
				undefined,
				context(root),
			);
		expect(selected.content[0].text).toContain("Second abstract");
		expect(selected.content[0].text).not.toContain("First abstract");
	});

	it("returns every retained Paper ID and lets update_literature_sidebar build the full list", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-filter-table-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const records = [
			{ ...paper("paper-a"), title: "Linux UAF A", abstract: "kernel use after free" },
			{ ...paper("paper-b"), title: "Linux UAF B", abstract: "kernel use after free" },
			{ ...paper("paper-c"), title: "Linux candidate" },
		];
		await store.saveSearchRun(searchRun("run-filter", records));

		const tools = registeredTools();
		expect(tools.has("assess_literature_sidebar")).toBe(false);
		const result = await tools.get("filter_search_run_results").execute(
			"filter",
			{
				search_run_id: "run-filter",
				include_term_groups: [["linux"], ["uaf", "use after free"]],
				limit: 1,
			},
			undefined,
			undefined,
			context(root),
		);

		expect(result.details).toMatchObject({
			totalResults: 3,
			matched: 2,
			unresolved: 1,
			groups: [{ matched: 2, unresolved: 1, excluded: 0, paperIds: ["paper-a", "paper-b", "paper-c"] }],
		});
		expect(result.details).not.toHaveProperty("mdUrl");
		expect(result.content[0].text).toContain("paper_id=paper-a | title=Linux UAF A");
		expect(result.content[0].text).toContain("paper_id=paper-b | title=Linux UAF B");
		expect(result.content[0].text).toContain("Unresolved (missing abstract; review before excluding; all):");
		expect(result.content[0].text).toContain("paper_id=paper-c | title=Linux candidate");
		await expect(stat(join(root, ".paper-agent", "web-agent-memory", "results"))).rejects.toThrow();

		const sidebar = await tools.get("update_literature_sidebar").execute(
			"update",
			{
				search_run_id: "run-filter",
				filter_result_id: result.details.filterResultId,
				annotations: [{ paper_id: "paper-a", focus: "内核漏洞", relevance: "标题涉及内核漏洞", topic: "内核安全" }],
			},
			undefined,
			undefined,
			context(root),
		);
		expect(sidebar.details).toMatchObject({ rowCount: 3, revision: 1, unannotatedCount: 2 });
		const content = await readFile(sidebar.details.mdPath, "utf8");
		const metadata = parseSidebarResultMetadata(content);
		expect(metadata.rows?.map((row) => row.paper_id)).toEqual(["paper-a", "paper-b", "paper-c"]);
		expect(metadata.rows?.map((row) => row.screening_status)).toEqual(["matched", "matched", "unresolved"]);
		expect(metadata.rows?.[0].annotation_basis).toBe("title");
		expect(content).not.toContain("kernel use after free");
	});

	it("keeps all unique papers beyond 500 across overlapping groups and rejects invalid annotations", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-filter-large-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const records = Array.from({ length: 520 }, (_, index) => {
			const id = `paper-${String(index).padStart(4, "0")}`;
			const title =
				index < 501
					? index < 2
						? "Linux UAF | [same] title"
						: `Linux UAF paper ${index}`
					: index < 511
						? `Linux candidate ${index}`
						: index < 515
							? `OS candidate ${index}`
							: `Finance ${index}`;
			return {
				...paper(id),
				title,
				...(index === 0
					? { abstract: "Research on kernel security" }
					: index >= 515
						? { abstract: "Financial analysis" }
						: {}),
			};
		});
		await store.saveSearchRun(searchRun("run-large", records));
		const tools = registeredTools();
		const sessionContext = { ...context(root), sessionManager: { getSessionId: () => "large-session" } };
		const filtered = await tools.get("filter_search_run_results").execute(
			"filter",
			{
				search_run_id: "run-large",
				limit: 1,
				groups: [
					{ label: "A", include_term_groups: [["linux"], ["uaf"]], limit: 1 },
					{ label: "B", include_terms: ["linux"], limit: 1 },
				],
			},
			undefined,
			undefined,
			sessionContext,
		);
		expect(filtered.details).toMatchObject({ totalResults: 520, matched: 511, unresolved: 4, excluded: 5 });
		expect(filtered.details.retained).toHaveLength(515);
		expect(filtered.details.groups[0].paperIds).toHaveLength(515);
		expect(filtered.content[0].text).toContain("paper_id=paper-0514 | title=OS candidate 514");
		expect(filtered.content[0].text).not.toContain("paper_id=paper-0515");
		expect(filtered.content[0].text.match(/paper_id=paper-0000 \| title=/g)).toHaveLength(1);
		const input = { search_run_id: "run-large", filter_result_id: filtered.details.filterResultId };
		const update = tools.get("update_literature_sidebar");
		const sidebar = await update.execute(
			"update",
			{
				...input,
				annotations: [{ paper_id: "paper-0000", focus: "内核漏洞", relevance: "标题涉及内核漏洞", topic: "UAF" }],
			},
			undefined,
			undefined,
			sessionContext,
		);
		expect(sidebar.details).toMatchObject({ rowCount: 515, unannotatedCount: 514, matched: 511, unresolved: 4 });
		const markdown = await readFile(sidebar.details.mdPath, "utf8");
		const rows = parseSidebarResultMetadata(markdown).rows ?? [];
		expect(rows).toHaveLength(515);
		expect(rows.map((row) => row.paper_id)).toContain("paper-0000");
		expect(rows.map((row) => row.paper_id)).toContain("paper-0001");
		expect(rows.find((row) => row.paper_id === "paper-0514")?.screening_status).toBe("unresolved");
		expect(rows[0]).not.toHaveProperty("abstract");
		expect(markdown).not.toContain("Research on kernel security");
		const onDemand = await tools
			.get("get_search_run_papers")
			.execute(
				"abstract",
				{ search_run_id: "run-large", paper_ids: ["paper-0000"] },
				undefined,
				undefined,
				sessionContext,
			);
		expect(onDemand.content[0].text).toContain("Research on kernel security");
		expect(markdown.split("\n").filter((line) => line.startsWith("| ["))).toHaveLength(515);
		const parsed = parseLiteratureTables(markdown);
		expect(parsed?.tables[0].rows).toHaveLength(515);
		expect(parsed?.tables[0].rows[0]).toHaveLength(4);
		expect(parsed?.tables[0].rowMeta?.[0].paper_id).toBe("paper-0000");
		expect(parsed?.tables[0].rows[0][0].text).toBe("Linux UAF | [same] title");
		expect(parsed?.tables[0].rows[0][0].url).toBe("https://example.org/paper-0000");
		const edited = await tools.get("edit_literature_sidebar").execute(
			"edit",
			{
				result_url: sidebar.details.mdUrl,
				expected_revision: 1,
				operations: [{ action: "patch", target_paper_id: "paper-0514", focus: "待复核更新" }],
			},
			undefined,
			undefined,
			sessionContext,
		);
		expect(edited.details).toMatchObject({ rowCount: 515, revision: 2 });
		expect(parseSidebarResultMetadata(await readFile(sidebar.details.mdPath, "utf8")).rows).toHaveLength(515);
		await expect(
			update.execute(
				"unknown",
				{ ...input, annotations: [{ paper_id: "absent" }] },
				undefined,
				undefined,
				sessionContext,
			),
		).rejects.toThrow("Unknown annotation Paper ID");
		await expect(
			update.execute(
				"duplicate",
				{ ...input, annotations: [{ paper_id: "paper-0000" }, { paper_id: "paper-0000" }] },
				undefined,
				undefined,
				sessionContext,
			),
		).rejects.toThrow("Duplicate annotation Paper ID");
		await expect(
			update.execute("session", input, undefined, undefined, {
				...context(root),
				sessionManager: { getSessionId: () => "other-session" },
			}),
		).rejects.toThrow("current session");
		const changedRun = await store.getSearchRun("run-large");
		if (!changedRun) throw new Error("Test search run disappeared");
		changedRun.results[0].title = "Revised title";
		await store.saveSearchRun(changedRun);
		await expect(update.execute("stale", input, undefined, undefined, sessionContext)).rejects.toThrow("stale");
		changedRun.results.shift();
		await store.saveSearchRun(changedRun);
		await expect(update.execute("missing", input, undefined, undefined, sessionContext)).rejects.toThrow(
			"no longer exists",
		);
	});

	it("rejects an oversized sidebar rather than silently truncating it", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-size-"));
		temporaryPaths.push(root);
		await expect(
			writeLiteratureSidebarResult({
				cwd: root,
				content: "x".repeat(MAX_SIDEBAR_BYTES),
				rows: [],
			}),
		).rejects.toThrow("max 5MB");
	});

	it("preserves the legacy Markdown input for lists outside one filter result", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-legacy-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.saveSearchRun(searchRun("run-legacy", [paper("paper-a")]));
		const result = await registeredTools()
			.get("update_literature_sidebar")
			.execute(
				"legacy",
				{
					search_run_id: "run-legacy",
					content: [
						"| 标题 | 年份/venue | 标识 | focus |",
						"| --- | --- | --- | --- |",
						"| [Consent paper paper-a](https://example.org/paper-a) | 2026 | paper-a | 测试 |",
					].join("\n"),
					rows: [{ paper_id: "paper-a", search_run_id: "run-legacy", focus: "测试" }],
				},
				undefined,
				undefined,
				context(root),
			);
		expect(result.details.rowCount).toBe(1);
		expect(parseSidebarResultMetadata(await readFile(result.details.mdPath, "utf8")).rows?.[0].paper_id).toBe(
			"paper-a",
		);
	});

	it("saves one generated sidebar whose papers belong to multiple search runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-save-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.saveSearchRun(searchRun("run-a", [paper("paper-a")]));
		await store.saveSearchRun(searchRun("run-b", [paper("paper-b")]));
		const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(resultsDir, "combined.md"),
			'<!-- paper-agent-sidebar-meta {"rows":[{"paper_id":"paper-a","search_run_id":"run-a","focus":"static"},{"paper_id":"paper-b","search_run_id":"run-b","focus":"dynamic"}]} -->',
			"utf8",
		);
		const tool = registeredTools().get("save_literature_selection");
		const result = await tool.execute(
			"save-sidebar",
			{
				sidebar_result_url: "/api/agent/results/combined.md",
				contributor: "Agent",
			},
			undefined,
			undefined,
			context(
				root,
				vi.fn(async () => true),
			),
		);

		expect((await store.listPapers()).map((record) => record.id).sort()).toEqual(["paper-a", "paper-b"]);
		expect(result.details.searchRunIds).toEqual(["run-a", "run-b"]);
		expect(result.details.focusGroups).toEqual({ static: ["paper-a"], dynamic: ["paper-b"] });
	});

	it("persists once-mode searches in SQLite without creating a JSONL journal", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-sqlite-"));
		temporaryPaths.push(root);
		const tool = registeredTools().get("collect_literature");
		const result = await tool.execute(
			"search-sqlite",
			{
				query: "existing local papers",
				providers: ["arxiv"],
				corpus_only: true,
				mode: "once",
				namespace: "research",
			},
			undefined,
			undefined,
			context(root),
		);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "research"), "personal", "research");
		expect((await store.listSearchRuns()).map((run) => run.id)).toEqual([result.details.searchRunId]);
		await expect(stat(join(root, ".paper-agent", "search-runs.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("blocks non-interactive derived-memory writes and records an exact confirmed write", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-memory-consent-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const tool = registeredTools().get("manage_literature_memory");
		const params = {
			action: "record",
			paper_id: "paper-1",
			operation: "skim-card",
			input_hashes: ["a".repeat(64)],
			pipeline_version: "1",
			result: { claim: "checked" },
			created_by: "Ada",
			namespace: "alice",
			corpus_root: corpusBase,
		};

		await expect(tool.execute("memory-blocked", params, undefined, undefined, context(root))).rejects.toThrow(
			"interactive confirmation",
		);
		await expect(stat(corpusBase)).rejects.toMatchObject({ code: "ENOENT" });

		const confirm = vi.fn(async () => true);
		const result = await tool.execute("memory-confirmed", params, undefined, undefined, context(root, confirm));
		expect(confirm).toHaveBeenCalledWith("Record derived research memory?", expect.stringContaining("Manifest:"));
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice", corpusBase), "personal", "alice");
		expect(await store.getDerived(result.details.key)).toMatchObject({
			createdBy: "Ada",
			result: { claim: "checked" },
		});
		const audit = await readFile(join(root, ".paper-agent", "audit", "operations.jsonl"), "utf8");
		expect(audit).toContain('"event":"consumed"');
	});

	it("auto-authorizes ordinary writes by default and honors the Agent confirmation switch", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-corpus-consent-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice", corpusBase), "personal", "alice");
		await store.upsertPaper(paper("paper-1"));
		const tool = registeredTools().get("manage_literature_corpus");

		await tool.execute(
			"annotate-automatic",
			{
				action: "annotate",
				namespace: "alice",
				corpus_root: corpusBase,
				paper_ids: ["paper-1"],
				contributor: "Ada",
				tags: ["reviewed"],
			},
			undefined,
			undefined,
			context(root),
		);
		expect((await store.getPaper("paper-1"))?.curation?.tags).toEqual(["private-tag", "reviewed"]);
		const automaticExport = await tool.execute(
			"export-automatic",
			{ action: "export", namespace: "alice", corpus_root: corpusBase, format: "json", filename: "automatic.json" },
			undefined,
			undefined,
			context(root),
		);
		expect(JSON.parse(await readFile(automaticExport.details.exportPath, "utf8")).records).toHaveLength(1);

		const config = defaultPaperAgentConfig();
		config.confirmations.requireAgentWriteConfirmation = true;
		await savePaperAgentConfig(root, config);
		await expect(
			tool.execute(
				"annotate-blocked",
				{
					action: "annotate",
					namespace: "alice",
					corpus_root: corpusBase,
					paper_ids: ["paper-1"],
					contributor: "Ada",
					tags: ["confirmed"],
				},
				undefined,
				undefined,
				context(root),
			),
		).rejects.toThrow("interactive confirmation");
		expect((await store.getPaper("paper-1"))?.curation?.tags).toEqual(["private-tag", "reviewed"]);

		const confirm = vi.fn(async () => true);
		await tool.execute(
			"annotate-confirmed",
			{
				action: "annotate",
				namespace: "alice",
				corpus_root: corpusBase,
				paper_ids: ["paper-1"],
				contributor: "Ada",
				tags: ["confirmed"],
			},
			undefined,
			undefined,
			context(root, confirm),
		);
		expect((await store.getPaper("paper-1"))?.curation?.tags).toEqual(["private-tag", "reviewed", "confirmed"]);

		const exported = await tool.execute(
			"export-confirmed",
			{ action: "export", namespace: "alice", corpus_root: corpusBase, format: "json", filename: "papers.json" },
			undefined,
			undefined,
			context(root, confirm),
		);
		expect(JSON.parse(await readFile(exported.details.exportPath, "utf8")).records).toHaveLength(1);
	});

	it("prevents unconfirmed local team proposals and reviews while scrubbing personal curation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-consent-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const personal = new LiteratureStore(
			resolveCorpusRoot(root, "personal", "alice", corpusBase),
			"personal",
			"alice",
		);
		await personal.upsertPaper(paper("paper-1"));
		const teamRoot = resolveCorpusRoot(root, "team", "lab", corpusBase);
		const tool = registeredTools().get("manage_literature_corpus");
		const proposal = {
			action: "promote",
			namespace: "alice",
			corpus_root: corpusBase,
			paper_ids: ["paper-1"],
			target_namespace: "lab",
			target_corpus_root: corpusBase,
			contributor: "Ada",
		};

		await expect(tool.execute("promote-blocked", proposal, undefined, undefined, context(root))).rejects.toThrow(
			"interactive confirmation",
		);
		await expect(stat(teamRoot)).rejects.toMatchObject({ code: "ENOENT" });

		const confirm = vi.fn(async () => true);
		await tool.execute("promote-confirmed", proposal, undefined, undefined, context(root, confirm));
		const team = new LiteratureStore(teamRoot, "team", "lab");
		const proposed = await team.getPaper("paper-1");
		expect(proposed?.curation).toMatchObject({ userNotes: [], teamReview: { status: "team-proposed" } });
		expect(proposed?.curation?.screening).toBeUndefined();

		await expect(
			tool.execute(
				"review-blocked",
				{
					action: "review",
					scope: "team",
					namespace: "lab",
					corpus_root: corpusBase,
					paper_ids: ["paper-1"],
					reviewer: "Reviewer",
					review_decision: "team-approved",
				},
				undefined,
				undefined,
				context(root),
			),
		).rejects.toThrow("interactive confirmation");
		expect((await team.getPaper("paper-1"))?.curation?.teamReview?.status).toBe("team-proposed");

		await tool.execute(
			"review-confirmed",
			{
				action: "review",
				scope: "team",
				namespace: "lab",
				corpus_root: corpusBase,
				paper_ids: ["paper-1"],
				reviewer: "Reviewer",
				review_decision: "team-approved",
			},
			undefined,
			undefined,
			context(root, confirm),
		);
		expect((await team.getPaper("paper-1"))?.curation?.teamReview).toMatchObject({
			status: "team-approved",
			reviewedBy: "Reviewer",
		});
	});

	it("manages collection membership for existing personal papers with confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-collection-management-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice", corpusBase), "personal", "alice");
		await store.upsertPaper(paper("paper-1"));
		const tool = registeredTools().get("manage_literature_collections");
		const confirm = vi.fn(async () => true);

		const created = await tool.execute(
			"collection-create",
			{ action: "create", namespace: "alice", corpus_root: corpusBase, collection_name: "Compiler Testing" },
			undefined,
			undefined,
			context(root, confirm),
		);
		const collectionId = created.details.result.id as string;
		await tool.execute(
			"collection-assign",
			{
				action: "assign",
				namespace: "alice",
				corpus_root: corpusBase,
				collection_id: collectionId,
				paper_ids: ["paper-1"],
			},
			undefined,
			undefined,
			context(root, confirm),
		);
		expect((await store.getPaper("paper-1"))?.collectionIds).toEqual([collectionId]);

		await expect(
			tool.execute(
				"collection-unassign-blocked",
				{
					action: "unassign",
					namespace: "alice",
					corpus_root: corpusBase,
					collection_id: collectionId,
					paper_ids: ["paper-1"],
				},
				undefined,
				undefined,
				context(root),
			),
		).rejects.toThrow("interactive confirmation");
		expect((await store.getPaper("paper-1"))?.collectionIds).toEqual([collectionId]);

		await tool.execute(
			"collection-unassign",
			{
				action: "unassign",
				namespace: "alice",
				corpus_root: corpusBase,
				collection_id: collectionId,
				paper_ids: ["paper-1"],
			},
			undefined,
			undefined,
			context(root, confirm),
		);
		expect((await store.getPaper("paper-1"))?.collectionIds ?? []).toEqual([]);

		await tool.execute(
			"collection-rename",
			{
				action: "rename",
				namespace: "alice",
				corpus_root: corpusBase,
				collection_id: collectionId,
				new_name: "Compiler Validation",
			},
			undefined,
			undefined,
			context(root, confirm),
		);
		const listed = await tool.execute(
			"collection-list",
			{ action: "list", namespace: "alice", corpus_root: corpusBase },
			undefined,
			undefined,
			context(root),
		);
		expect(listed.details.collections).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: collectionId, name: "Compiler Validation" })]),
		);

		await tool.execute(
			"collection-delete",
			{ action: "delete", namespace: "alice", corpus_root: corpusBase, collection_id: collectionId },
			undefined,
			undefined,
			context(root, confirm),
		);
		expect(await store.listCollections()).toEqual([]);
	});

	it("deletes a personal paper and its version only after confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-paper-delete-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice", corpusBase), "personal", "alice");
		await store.upsertPaper(paper("paper-1"));
		const tool = registeredTools().get("manage_literature_corpus");

		await expect(
			tool.execute(
				"delete-blocked",
				{ action: "delete", namespace: "alice", corpus_root: corpusBase, paper_ids: ["paper-1"] },
				undefined,
				undefined,
				context(root),
			),
		).rejects.toThrow("interactive confirmation");
		expect(await store.getPaper("paper-1")).toBeDefined();

		await tool.execute(
			"delete-confirmed",
			{ action: "delete", namespace: "alice", corpus_root: corpusBase, paper_ids: ["paper-1"] },
			undefined,
			undefined,
			context(
				root,
				vi.fn(async () => true),
			),
		);
		expect(await store.getPaper("paper-1")).toBeUndefined();
	});
});
