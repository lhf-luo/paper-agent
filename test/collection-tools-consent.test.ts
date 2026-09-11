import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";
import { registerCollectionTools } from "../src/literature/presentation/collection-tools.ts";

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
			userNotes: [
				{ id: `note-${id}`, text: "private note", author: "Ada", createdAt: "2026-01-01T00:00:00.000Z" },
			],
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
			context(root, vi.fn(async () => true)),
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
