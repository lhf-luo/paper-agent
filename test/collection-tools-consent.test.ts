import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCollectionTools } from "../src/collection-tools.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature-store.ts";
import type { PaperRecord } from "../src/literature-types.ts";

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
			userNotes: [{ id: "note-1", text: "private note", author: "Ada", createdAt: "2026-01-01T00:00:00.000Z" }],
			screening: {
				status: "include",
				updatedBy: "Ada",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
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

	it("requires confirmation for export and annotation before changing personal data", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-corpus-consent-"));
		temporaryPaths.push(root);
		const corpusBase = join(root, "corpus");
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice", corpusBase), "personal", "alice");
		await store.upsertPaper(paper("paper-1"));
		const tool = registeredTools().get("manage_literature_corpus");

		await expect(
			tool.execute(
				"annotate-blocked",
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
			),
		).rejects.toThrow("interactive confirmation");
		expect((await store.getPaper("paper-1"))?.curation?.tags).toEqual(["private-tag"]);

		await expect(
			tool.execute(
				"export-blocked",
				{ action: "export", namespace: "alice", corpus_root: corpusBase, format: "json", filename: "papers.json" },
				undefined,
				undefined,
				context(root),
			),
		).rejects.toThrow("interactive confirmation");
		expect(await readdir(join(store.root, "exports"))).toEqual([]);

		const confirm = vi.fn(async () => true);
		await tool.execute(
			"annotate-confirmed",
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
			context(root, confirm),
		);
		expect((await store.getPaper("paper-1"))?.curation?.tags).toEqual(["private-tag", "reviewed"]);

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
});
