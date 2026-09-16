import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { ResearchNotebook } from "../src/research/application/research-notebook.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(id: string): PaperRecord {
	return {
		id,
		title: `Paper ${id}`,
		authors: ["Alice Example"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "crossref", query: id, retrievedAt: "2026-09-06T00:00:00.000Z" }],
		mergedFrom: [],
	};
}

async function workspace(namespace = "default") {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-research-notes-"));
	temporaryPaths.push(root);
	const corpus = join(root, ".paper-agent", "corpus", "personal", namespace);
	const store = new LiteratureStore(corpus, "personal", namespace);
	await store.initialize();
	return { root, store, notebook: new ResearchNotebook(store) };
}

describe("Markdown research notebook", () => {
	it("seeds built-in templates and copies each into a note without papers", async () => {
		const { root, notebook } = await workspace();
		const templates = await notebook.templates();
		expect(templates.map((template) => template.name)).toEqual(["空白", "比较矩阵", "精读", "略读"]);
		for (const templateId of ["skim", "deep-reading", "comparison-matrix"]) {
			const template = templates.find((value) => value.id === templateId)!;
			expect(template.markdown.trim().length).toBeGreaterThan(0);
			expect(
				await readFile(join(root, ".paper-agent", "templates", "research-notes", template.filename!), "utf8"),
			).toBe(template.markdown);
			const note = await notebook.create({ title: `UAF 调研 ${templateId}`, templateId });
			expect(note).toMatchObject({ revision: 1, markdown: template.markdown, papers: [], templateId });
			expect(await readFile(resolve(root, ".paper-agent", note.relativePath), "utf8")).toBe(template.markdown);
		}
	});

	it("fills old zero-byte defaults while preserving custom templates and existing notes", async () => {
		const { notebook } = await workspace();
		const existing = await notebook.create({ title: "Old blank note", markdown: "" });
		await mkdir(notebook.templateStore.directory, { recursive: true });
		await writeFile(join(notebook.templateStore.directory, "skim.md"), "", "utf8");
		await writeFile(join(notebook.templateStore.directory, "deep-reading.md"), "# 我的自定义精读\n", "utf8");

		const templates = await notebook.templates();
		expect(templates.find((value) => value.id === "skim")!.markdown.length).toBeGreaterThan(0);
		expect(templates.find((value) => value.id === "deep-reading")!.markdown).toBe("# 我的自定义精读\n");
		expect((await notebook.get(existing.id))!.markdown).toBe("");
		expect((await notebook.create({ title: "Custom", templateId: "deep-reading" })).markdown).toBe(
			"# 我的自定义精读\n",
		);
	});

	it("keeps blank notes empty and saves supplied analysis instead of the template skeleton", async () => {
		const { notebook } = await workspace();
		expect((await notebook.create({ title: "Blank", templateId: "blank" })).markdown).toBe("");
		const note = await notebook.create({
			title: "Reviewed skim",
			templateId: "skim",
			markdown: "# Verified findings\n",
		});
		expect(note.markdown).toBe("# Verified findings\n");
		expect((await notebook.create({ title: "Intentionally empty", templateId: "skim", markdown: "" })).markdown).toBe(
			"",
		);
	});

	it("links multiple personal papers and keeps the note when a paper is deleted", async () => {
		const { notebook, store } = await workspace();
		await store.upsertPapers([paper("paper-one"), paper("paper-two")]);
		const note = await notebook.create({
			title: "Comparison",
			markdown: "# Findings",
			paperIds: ["paper-one", "paper-two", "paper-one"],
		});
		expect(note.papers.map((value) => value.id)).toEqual(["paper-one", "paper-two"]);

		await store.deletePapers(["paper-one"]);
		const afterDelete = await notebook.get(note.id);
		expect(afterDelete?.papers.map((value) => value.id)).toEqual(["paper-two"]);
		expect(afterDelete?.markdown).toBe("# Findings");
	});

	it("uses revision and file hashes to reject stale or externally modified writes", async () => {
		const { root, notebook } = await workspace();
		const note = await notebook.create({ title: "Evidence", markdown: "first" });
		const updated = await notebook.update(note.id, {
			title: "Evidence renamed",
			markdown: "second",
			expectedRevision: note.revision,
			expectedContentHash: note.contentHash,
		});
		expect(updated).toMatchObject({ title: "Evidence renamed", markdown: "second", revision: 2 });
		await expect(
			notebook.update(note.id, {
				title: note.title,
				markdown: "stale",
				expectedRevision: note.revision,
				expectedContentHash: note.contentHash,
			}),
		).rejects.toThrow("changed since");

		await writeFile(resolve(root, ".paper-agent", updated.relativePath), "external", "utf8");
		await expect(
			notebook.update(note.id, {
				title: updated.title,
				markdown: "overwrite",
				expectedRevision: updated.revision,
				expectedContentHash: updated.contentHash,
			}),
		).rejects.toThrow("changed since");
	});

	it("rejects papers from another namespace and removes the Markdown file on note deletion", async () => {
		const { root, notebook, store } = await workspace();
		await store.upsertPapers([paper("paper-local")]);
		await expect(notebook.create({ title: "Wrong namespace", paperIds: ["paper-elsewhere"] })).rejects.toThrow(
			"not in namespace",
		);
		const note = await notebook.create({ title: "Disposable", paperIds: ["paper-local"] });
		const path = resolve(root, ".paper-agent", note.relativePath);
		await expect(access(path)).resolves.toBeUndefined();
		await expect(notebook.delete(note.id)).resolves.toMatchObject({ id: note.id });
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await notebook.get(note.id)).toBeUndefined();
	});

	it("loads custom top-level Markdown templates", async () => {
		const { notebook } = await workspace();
		await notebook.templateStore.initialize();
		await writeFile(join(notebook.templateStore.directory, "custom.md"), "# 自定义模板\n", "utf8");
		const custom = (await notebook.templates()).find((template) => template.id === "custom");
		expect(custom).toMatchObject({ name: "自定义模板", markdown: "# 自定义模板\n" });
	});

	it("stores notes in real nested folders and keeps paths in sync", async () => {
		const { root, notebook } = await workspace();
		const parent = await notebook.createFolder({ name: "UAF" });
		const child = await notebook.createFolder({ name: "动态检测", parentId: parent.id });
		const note = await notebook.create({ title: "FreeWill", folderId: child.id, markdown: "# Evidence" });
		expect(note).toMatchObject({ folderId: child.id, folderPath: "UAF / 动态检测" });
		await expect(access(resolve(root, ".paper-agent", note.relativePath))).resolves.toBeUndefined();

		const renamed = await notebook.updateFolder(parent.id, { name: "内存安全" });
		expect(renamed.name).toBe("内存安全");
		const moved = await notebook.get(note.id);
		expect(moved).toMatchObject({ folderPath: "内存安全 / 动态检测", markdown: "# Evidence" });
		await expect(access(resolve(root, ".paper-agent", moved!.relativePath))).resolves.toBeUndefined();
		await expect(notebook.updateFolder(parent.id, { name: parent.name, parentId: child.id })).rejects.toThrow(
			"descendant",
		);
		await expect(notebook.deleteFolder(child.id)).rejects.toThrow("not empty");
	});

	it("moves notes to the root before deleting empty folders", async () => {
		const { notebook } = await workspace();
		const parent = await notebook.createFolder({ name: "Systems" });
		const child = await notebook.createFolder({ name: "Fuzzing", parentId: parent.id });
		const note = await notebook.create({ title: "Survey", folderId: child.id });
		const moved = await notebook.update(note.id, {
			title: note.title,
			markdown: note.markdown,
			folderId: null,
			expectedRevision: note.revision,
			expectedContentHash: note.contentHash,
		});
		expect(moved.folderId).toBeUndefined();
		await expect(notebook.deleteFolder(child.id)).resolves.toMatchObject({ id: child.id });
		await expect(notebook.deleteFolder(parent.id)).resolves.toMatchObject({ id: parent.id });
	});

	it("indexes Markdown files created outside Paper Agent", async () => {
		const { root, notebook } = await workspace();
		const externalFolder = join(root, ".paper-agent", "notes", "default", "External", "Nested");
		await mkdir(externalFolder, { recursive: true });
		await writeFile(join(externalFolder, "New finding.md"), "# External note\n", "utf8");

		const sync = await notebook.sync();
		expect(sync).toMatchObject({ createdNotes: 1, createdFolders: 2 });
		const [note] = await notebook.list();
		expect(note).toMatchObject({ title: "New finding", folderPath: "External / Nested", papers: [] });
		expect((await notebook.get(note.id))?.markdown).toBe("# External note\n");
	});

	it("does not replace display titles with their sanitized filenames", async () => {
		const { notebook } = await workspace();
		const note = await notebook.create({ title: "Question: evidence" });

		await notebook.sync();
		expect(await notebook.get(note.id)).toMatchObject({ title: "Question: evidence", revision: 1 });
	});

	it("preserves note identity and paper links across external moves and edits", async () => {
		const { root, notebook, store } = await workspace();
		await store.upsertPapers([paper("paper-linked")]);
		const note = await notebook.create({
			title: "Original title",
			markdown: "first",
			paperIds: ["paper-linked"],
		});
		const destination = join(root, ".paper-agent", "notes", "default", "Moved");
		await mkdir(destination, { recursive: true });
		const movedPath = join(destination, basename(note.relativePath).replace("Original title", "Renamed outside"));
		await rename(resolve(root, ".paper-agent", note.relativePath), movedPath);
		await writeFile(movedPath, "changed outside", "utf8");

		const sync = await notebook.sync();
		expect(sync).toMatchObject({ updatedNotes: 1, createdFolders: 1, deletedNotes: 0 });
		const updated = await notebook.get(note.id);
		expect(updated).toMatchObject({
			id: note.id,
			title: "Renamed outside",
			folderPath: "Moved",
			markdown: "changed outside",
			revision: 2,
		});
		expect(updated?.papers.map((linked) => linked.id)).toEqual(["paper-linked"]);
	});

	it("removes stale note indexes after files are deleted outside Paper Agent", async () => {
		const { root, notebook } = await workspace();
		const note = await notebook.create({ title: "Deleted outside" });
		await rm(resolve(root, ".paper-agent", note.relativePath));

		const sync = await notebook.sync();
		expect(sync).toMatchObject({ deletedNotes: 1 });
		expect(await notebook.get(note.id)).toBeUndefined();
	});

	it("uses only the Markdown note index and paper relationship tables", async () => {
		const { store } = await workspace();
		const database = new DatabaseSync(store.databasePath, { readOnly: true });
		try {
			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'research_%' ORDER BY name")
				.all()
				.map((row) => (row as { name: string }).name);
			expect(tables).toEqual(["research_note_folders", "research_note_papers", "research_notes"]);
		} finally {
			database.close();
		}
	});
});
