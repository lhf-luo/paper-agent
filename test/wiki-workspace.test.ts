import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WikiWorkspace } from "../src/wiki/application/wiki-workspace.ts";
import type { WikiSourceSnapshot } from "../src/wiki/domain/wiki-types.ts";

async function testWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-wiki-"));
	const papers = new Map<string, WikiSourceSnapshot>([
		[
			"paper-1",
			{
				kind: "paper",
				id: "paper-1",
				title: "Paper One",
				version: "a".repeat(64),
			},
		],
	]);
	const notes = new Map<string, WikiSourceSnapshot>([
		[
			"note-1",
			{
				kind: "note",
				id: "note-1",
				title: "Note One",
				version: "b".repeat(64),
				revision: 1,
			},
		],
	]);
	return {
		root,
		papers,
		notes,
		workspace: new WikiWorkspace(root, "default", {
			resolvePaper: async (id) => papers.get(id),
			resolveNote: async (id) => notes.get(id),
		}),
	};
}

function pageChange(overrides: Record<string, unknown> = {}) {
	return {
		title: "Use-after-free detection",
		type: "concept" as const,
		markdown: "# Detection\n\nTemporal memory safety is detected through stale references. [E1]",
		evidence: [
			{
				id: "E1",
				kind: "paper" as const,
				sourceId: "paper-1",
				locator: { pdfPage: 7, section: "3.2", object: "Figure 2" },
			},
		],
		...overrides,
	};
}

describe("WikiWorkspace", () => {
	it("writes declaration-level evidence, chunk search, and rebuilds after an external move", async () => {
		const { workspace } = await testWorkspace();
		const page = await workspace.ingest(pageChange());
		expect(page.status).toBe("draft");
		expect(page.evidence[0]).toMatchObject({ id: "E1", sourceId: "paper-1", version: "a".repeat(64) });
		expect(page.claims).toHaveLength(1);
		expect(await readFile(join(workspace.directory, "index.md"), "utf8")).toContain(page.title);
		expect(await readFile(join(workspace.directory, "log.md"), "utf8")).toContain("| create |");

		const found = await workspace.search({ query: "stale references" });
		expect(found.pages[0].id).toBe(page.id);
		expect(found.pages[0].match?.heading).toContain("Detection");
		expect((await workspace.search({ paperId: "paper-1", status: "draft" })).pages[0].id).toBe(page.id);

		const moved = join(workspace.directory, "topics", "moved-page.md");
		await mkdir(dirname(moved), { recursive: true });
		await rename(join(workspace.directory, ...page.relativePath.split("/")), moved);
		const afterMove = await workspace.search({ query: "Temporal" });
		expect(afterMove.pages[0]).toMatchObject({ id: page.id, relativePath: "topics/moved-page.md" });
		expect(await readFile(moved, "utf8")).toContain("paper-1");
	});

	it("previews and applies a multi-page batch with one fingerprint", async () => {
		const { workspace } = await testWorkspace();
		const preview = await workspace.previewIngest({
			summary: "Deposit UAF knowledge",
			changes: [
				pageChange(),
				pageChange({
					title: "Dangling pointer",
					type: "concept",
					markdown: "# Dangling pointer\n\nA pointer can outlive its allocation. [E1]",
					aliases: ["stale pointer"],
				}),
			],
		});
		expect(preview.changes.map((change) => change.action)).toEqual(["create", "create"]);
		expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		const result = await workspace.applyIngest(preview);
		expect(result.pages).toHaveLength(2);
		expect((await workspace.lint()).issues.filter((issue) => issue.severity === "error")).toEqual([]);

		const stale = await workspace.previewIngest({
			summary: "Deposit UAF knowledge",
			changes: [pageChange()],
		});
		expect(stale.changes[0].action).toBe("conflict");
	});

	it("reports stale and missing declaration sources without deleting the page", async () => {
		const { workspace, papers, notes } = await testWorkspace();
		const preview = await workspace.previewIngest({
			summary: "Deposit note-backed synthesis",
			changes: [
				pageChange({
					evidence: [
						{
							id: "E1",
							kind: "paper",
							sourceId: "paper-1",
							locator: { pdfPage: 3 },
						},
						{
							id: "E2",
							kind: "note",
							sourceId: "note-1",
							version: "b".repeat(64),
							locator: { noteRevision: 1, noteHash: "b".repeat(64) },
						},
					],
					markdown: "# Synthesis\n\nCombined result. [E1][E2]",
				}),
			],
		});
		await workspace.applyIngest(preview);
		papers.clear();
		notes.set("note-1", { ...notes.get("note-1")!, version: "c".repeat(64), revision: 2 });
		const issues = (await workspace.lint()).issues.map((issue) => issue.code);
		expect(issues).toContain("missing-source");
		expect(issues).toContain("stale-source");
		expect((await workspace.search({ query: "Synthesis" })).pages).toHaveLength(1);
	});

	it("keeps legacy page-level sources readable with warnings instead of errors", async () => {
		const { workspace } = await testWorkspace();
		await workspace.initialize();
		await writeFile(
			join(workspace.directory, "legacy.md"),
			[
				"---",
				"id: wiki-legacy",
				"title: Legacy knowledge",
				"type: concept",
				"status: draft",
				"aliases: []",
				"tags: []",
				"source_notes: []",
				"paper_ids:",
				"  - paper-1",
				"created_at: 2026-01-01T00:00:00.000Z",
				"updated_at: 2026-01-01T00:00:00.000Z",
				"---",
				"# Legacy",
				"",
				"Page-level source only.",
			].join("\n"),
			"utf8",
		);
		const lint = await workspace.lint();
		expect(lint.issues).toContainEqual(
			expect.objectContaining({ code: "legacy-source-granularity", severity: "warning" }),
		);
		expect(lint.issues.filter((item) => item.severity === "error")).toEqual([]);
	});

	it("keeps malformed pages out of the index and rejects invalid evidence locators", async () => {
		const { workspace } = await testWorkspace();
		await workspace.initialize();
		await writeFile(join(workspace.directory, "bad.md"), "# Missing frontmatter\n", "utf8");
		const preview = await workspace.previewIngest({
			summary: "Bad locator",
			changes: [pageChange({ evidence: [{ id: "E1", kind: "paper", sourceId: "paper-1", locator: {} }] })],
		});
		expect(preview.changes[0].action).toBe("conflict");
		expect(preview.issues.map((issue) => issue.code)).toContain("invalid-evidence-locator");
		const lint = await workspace.lint();
		expect(lint.pageCount).toBe(0);
		expect(lint.issues.map((issue) => issue.code)).toContain("invalid-frontmatter");
	});

	it("returns reviewed pages to needs-review when updated", async () => {
		const { workspace } = await testWorkspace();
		const page = await workspace.ingest(pageChange());
		const path = join(workspace.directory, ...page.relativePath.split("/"));
		await writeFile(path, (await readFile(path, "utf8")).replace("status: draft", "status: reviewed"), "utf8");
		const current = await workspace.get(page.id);
		expect(current).toBeDefined();
		const updated = await workspace.ingest(
			pageChange({
				pageId: page.id,
				expectedContentHash: current!.page.contentHash,
				markdown: "# Detection\n\nUpdated claim. [E1]",
			}),
		);
		expect(updated.status).toBe("needs-review");
	});

	it("rejects source ids outside the current personal namespace", async () => {
		const { workspace } = await testWorkspace();
		const preview = await workspace.previewIngest({
			summary: "Invalid source",
			changes: [
				pageChange({ evidence: [{ id: "E1", kind: "paper", sourceId: "paper-2", locator: { pdfPage: 1 } }] }),
			],
		});
		expect(preview.changes[0].action).toBe("conflict");
		expect(preview.issues.map((issue) => issue.message).join(" ")).toContain("paper-2");
	});

	it("rejects a source changed after preview", async () => {
		const { workspace, notes } = await testWorkspace();
		const preview = await workspace.previewIngest({
			summary: "Note-backed batch",
			changes: [
				pageChange({
					title: "Note synthesis",
					type: "synthesis",
					markdown: "# Synthesis\n\nNote claim. [E1]",
					evidence: [
						{
							id: "E1",
							kind: "note",
							sourceId: "note-1",
							locator: { noteRevision: 1, noteHash: "b".repeat(64) },
						},
					],
				}),
			],
		});
		notes.set("note-1", { ...notes.get("note-1")!, version: "c".repeat(64), revision: 2 });
		await expect(workspace.applyIngest(preview)).rejects.toThrow("conflicts");
		expect((await workspace.search({ query: "Note synthesis" })).pages).toEqual([]);
	});

	it("previews and deletes paper, artifact, legacy, and explicitly included mixed-source pages", async () => {
		const { workspace } = await testWorkspace();
		const created = await workspace.previewIngest({
			summary: "Create deletion fixtures",
			changes: [
				pageChange(),
				pageChange({
					title: "Artifact-backed page",
					type: "system",
					markdown: "# Artifact\n\nThe artifact belongs to the paper. [E1]",
					evidence: [
						{ id: "E1", kind: "artifact", paperId: "paper-1", locator: { commit: "abc123", path: "src" } },
					],
				}),
				pageChange({
					title: "Mixed-source page",
					type: "synthesis",
					markdown: "# Mixed\n\nPaper and public evidence. [E1][E2]",
					evidence: [
						{ id: "E1", kind: "paper", sourceId: "paper-1", locator: { pdfPage: 2 } },
						{ id: "E2", kind: "public", locator: { url: "https://example.org/source" } },
					],
				}),
			],
		});
		await workspace.applyIngest(created);
		await writeFile(
			join(workspace.directory, "legacy.md"),
			[
				"---",
				"id: wiki-delete-legacy",
				"title: Legacy deletion page",
				"type: concept",
				"status: draft",
				"aliases: []",
				"tags: []",
				"source_notes: []",
				"paper_ids:",
				"  - paper-1",
				"created_at: 2026-01-01T00:00:00.000Z",
				"updated_at: 2026-01-01T00:00:00.000Z",
				"---",
				"# Legacy deletion page",
			].join("\n"),
			"utf8",
		);

		const initial = await workspace.previewSourcePageDeletion("paper-1");
		expect(initial.deletablePages.map((page) => page.title).sort()).toEqual([
			"Artifact-backed page",
			"Legacy deletion page",
			"Use-after-free detection",
		]);
		expect(initial.mixedPages).toHaveLength(1);
		expect(initial.targetPages).toHaveLength(3);
		await expect(workspace.previewSourcePageDeletion("paper-1", [initial.deletablePages[0].id])).rejects.toThrow(
			"not mixed",
		);

		const preview = await workspace.previewSourcePageDeletion("paper-1", [initial.mixedPages[0].id]);
		expect(preview.targetPages).toHaveLength(4);
		expect(preview.blocked).toBe(false);
		const result = await workspace.applySourcePageDeletion(preview);
		expect(result.deletedPages).toHaveLength(4);
		expect(result.lint.pageCount).toBe(0);
		expect(await readFile(join(workspace.directory, "log.md"), "utf8")).toContain("| delete |");
		expect((await workspace.search({ paperId: "paper-1" })).pages).toEqual([]);
	});

	it("blocks source-page deletion when a surviving page links to a target", async () => {
		const { workspace } = await testWorkspace();
		const created = await workspace.previewIngest({
			summary: "Create backlink fixture",
			changes: [
				pageChange(),
				pageChange({
					title: "Surviving note page",
					type: "synthesis",
					markdown: "# Synthesis\n\nSee [[Use-after-free detection]]. [E1]",
					evidence: [
						{
							id: "E1",
							kind: "note",
							sourceId: "note-1",
							locator: { noteRevision: 1, noteHash: "b".repeat(64) },
						},
					],
				}),
			],
		});
		await workspace.applyIngest(created);
		const preview = await workspace.previewSourcePageDeletion("paper-1");
		expect(preview.blocked).toBe(true);
		expect(preview.externalBacklinks).toEqual([
			expect.objectContaining({ title: "Surviving note page", targetPageIds: [preview.targetPages[0].id] }),
		]);
		await expect(workspace.applySourcePageDeletion(preview)).rejects.toThrow("external backlinks");
	});

	it("rejects stale deletion previews and restores files when synchronization fails", async () => {
		const { workspace } = await testWorkspace();
		const page = await workspace.ingest(pageChange());
		const path = join(workspace.directory, ...page.relativePath.split("/"));
		const stale = await workspace.previewSourcePageDeletion("paper-1");
		await writeFile(path, `${await readFile(path, "utf8")}\n`, "utf8");
		await expect(workspace.applySourcePageDeletion(stale)).rejects.toThrow("preview changed");

		const preview = await workspace.previewSourcePageDeletion("paper-1");
		const originalSync = workspace.sync.bind(workspace);
		let syncCalls = 0;
		workspace.sync = async () => {
			syncCalls += 1;
			if (syncCalls === 1) throw new Error("forced sync failure");
			return originalSync();
		};
		await expect(workspace.applySourcePageDeletion(preview)).rejects.toThrow("forced sync failure");
		expect(await readFile(path, "utf8")).toContain("Temporal memory safety");
	});
});
