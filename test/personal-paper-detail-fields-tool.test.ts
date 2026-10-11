import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { sqlitePathLayout } from "../src/literature/infrastructure/personal-database-support.ts";
import { registerCollectionTools } from "../src/literature/presentation/collection-tools.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function tools() {
	const registered = new Map<string, any>();
	registerCollectionTools({
		registerTool(tool: { name: string }) {
			registered.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	return registered;
}

const paper = (id: string): PaperRecord => ({
	id,
	title: "Kernel repair study",
	authors: ["Ada Researcher"],
	identifiers: {},
	citationCount: 42,
	referencedWorks: ["doi:10.1000/example"],
	links: [],
	provenance: [],
	mergedFrom: [],
});

describe("Agent paper research field editing", () => {
	it("hides a legacy card in both projected and complete tool results", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-agent-legacy-read-"));
		roots.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.upsertPaper(paper("paper-legacy"));
		const database = new DatabaseSync(sqlitePathLayout(store.root, "default").databasePath);
		try {
			database.exec(
				"DROP TRIGGER papers_detail_fields_insert_guard; DROP TRIGGER papers_detail_fields_update_guard",
			);
			const row = database.prepare("SELECT record_json FROM papers WHERE paper_id = 'paper-legacy'").get() as {
				record_json: string;
			};
			const old = JSON.parse(row.record_json) as PaperRecord;
			old.curation = {
				tags: [],
				userNotes: [],
				detailFields: {
					revision: 3,
					updatedAt: "2026-09-01T00:00:00.000Z",
					entries: [
						{
							id: "core-innovation",
							label: "核心创新点",
							type: "multiline",
							value: "Legacy card value",
							updatedAt: "2026-09-01T00:00:00.000Z",
						},
					],
				},
			};
			database.prepare("UPDATE papers SET record_json = ? WHERE paper_id = 'paper-legacy'").run(JSON.stringify(old));
		} finally {
			database.close();
		}
		const read = tools().get("get_personal_library_paper");
		const context = { cwd: root, hasUI: false, ui: { confirm: vi.fn() } };
		const projected = await read.execute(
			"projected",
			{ query: "paper-legacy", fields: ["detail_fields"] },
			undefined,
			undefined,
			context,
		);
		expect(projected.details.paper.detailFields.entries).toHaveLength(8);
		expect(JSON.stringify(projected)).not.toContain("Legacy card value");
		const complete = await read.execute("complete", { query: "paper-legacy" }, undefined, undefined, context);
		expect(complete.details.paper.record.curation.detailFields.entries).toEqual([]);
		expect(JSON.stringify(complete)).not.toContain("Legacy card value");
	});

	it("reads card fields and writes only selected fields with the stored revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-agent-"));
		roots.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.upsertPaper(paper("paper-one"));
		const registered = tools();
		const context = { cwd: root, hasUI: false, ui: { confirm: vi.fn() } };
		const read = await registered
			.get("get_personal_library_paper")
			.execute(
				"read",
				{ query: "paper-one", fields: ["detail_fields", "card_stats"] },
				undefined,
				undefined,
				context,
			);
		expect(read.details.paper.detailFields).toMatchObject({
			revision: 0,
		});
		expect(read.details.paper.detailFields.entries).toHaveLength(8);
		expect(read.details.paper.detailFields.entries[0]).toMatchObject({ id: "research-question", value: "" });
		expect(read.details.paper.detailFields.entries[1]).toMatchObject({ id: "research-gap", value: "" });
		expect(read.details.paper.cardStats).toEqual({
			pdfVersionCount: 0,
			derivedRecordCount: 0,
			referenceCount: 1,
			citationCount: 42,
		});
		const edit = registered.get("edit_personal_paper_detail_fields");
		const saved = await edit.execute(
			"edit",
			{
				paper_id: "paper-one",
				expected_revision: 0,
				fields: [
					{ id: "research-question", value: "How are kernel patches evaluated?" },
					{ id: "research-gap", value: "Existing evaluations omit crash reproduction." },
				],
				new_fields: [{ label: "复核页码", type: "text", value: "p. 4" }],
			},
			undefined,
			undefined,
			context,
		);
		expect(saved.details).toMatchObject({ status: "updated", paperId: "paper-one", revision: 1 });
		expect(context.ui.confirm).not.toHaveBeenCalled();
		const stored = await store.getPaper("paper-one");
		expect(stored?.title).toBe("Kernel repair study");
		expect(stored?.curation?.detailFields?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "research-question", value: "How are kernel patches evaluated?" }),
				expect.objectContaining({ id: "research-gap", value: "Existing evaluations omit crash reproduction." }),
				expect.objectContaining({ label: "复核页码", value: "p. 4" }),
			]),
		);
		const second = await edit.execute(
			"edit-again",
			{ paper_id: "paper-one", expected_revision: 1, fields: [{ id: "method-design", value: "Patch and test." }] },
			undefined,
			undefined,
			context,
		);
		expect(second.details.revision).toBe(2);
		expect((await store.getPaper("paper-one"))?.curation?.detailFields?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "research-question", value: "How are kernel patches evaluated?" }),
				expect.objectContaining({ id: "method-design", value: "Patch and test." }),
			]),
		);
	});

	it("rejects stale revisions and unknown or duplicate IDs without altering the card", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-agent-invalid-"));
		roots.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.upsertPaper(paper("paper-one"));
		const edit = tools().get("edit_personal_paper_detail_fields");
		const context = { cwd: root, hasUI: false, ui: { confirm: vi.fn() } };
		const call = (input: object) => edit.execute("edit", input, undefined, undefined, context);
		await expect(
			call({ paper_id: "paper-one", expected_revision: 0, fields: [{ id: "title", value: "changed" }] }),
		).rejects.toThrow(/not found/i);
		await expect(
			call({
				paper_id: "paper-one",
				expected_revision: 0,
				fields: [
					{ id: "research-question", value: "one" },
					{ id: "research-question", value: "two" },
				],
			}),
		).rejects.toThrow(/repeated/i);
		await call({
			paper_id: "paper-one",
			expected_revision: 0,
			fields: [{ id: "research-question", value: "saved" }],
		});
		await expect(
			call({ paper_id: "paper-one", expected_revision: 0, fields: [{ id: "research-question", value: "stale" }] }),
		).rejects.toThrow(/reread/i);
		expect((await store.getPaper("paper-one"))?.curation?.detailFields?.entries[0]?.value).toBe("saved");
	});
});
