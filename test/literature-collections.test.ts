import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import { paperRecordId } from "../src/literature/domain/literature-identifiers.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function memStore(): Promise<LiteratureStore> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-collections-"));
	temporaryPaths.push(root);
	const store = new LiteratureStore(root, "personal", "default");
	await store.initialize();
	return store;
}

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
	const record: PaperRecord = {
		id: "",
		title: "A Study of Stateful Fuzzing",
		authors: ["Ada Example"],
		year: 2025,
		identifiers: { doi: "10.1000/Example.1" },
		links: [{ url: "https://doi.org/10.1000/example.1", kind: "doi" }],
		provenance: [{ provider: "crossref", query: "stateful fuzzing", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		...overrides,
	};
	record.id = paperRecordId(record);
	return record;
}

describe("literature store collections", () => {
	it("creates a collection and lists it", async () => {
		const store = await memStore();
		const collection = await store.createCollection("ML Safety");
		expect(collection.id).toMatch(/^col-/);
		expect(collection.name).toBe("ML Safety");
		const all = await store.listCollections();
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe("ML Safety");
	});

	it("is idempotent for same name under same parent", async () => {
		const store = await memStore();
		const first = await store.createCollection("Systems");
		const second = await store.createCollection("Systems");
		expect(second.id).toBe(first.id);
		expect(await store.listCollections()).toHaveLength(1);
	});

	it("allows the same name under different parents and supports nesting", async () => {
		const store = await memStore();
		const parent = await store.createCollection("Research");
		const a = await store.createCollection("AI", parent.id);
		const b = await store.createCollection("AI", undefined);
		expect(a.id).not.toBe(b.id);
		expect(a.parentId).toBe(parent.id);
		expect(b.parentId).toBeUndefined();
	});

	it("validates collection parents and prevents hierarchy cycles", async () => {
		const store = await memStore();
		await expect(store.createCollection("Orphan", "missing-parent")).rejects.toThrow("not found");
		const parent = await store.createCollection("Parent");
		const child = await store.createCollection("Child", parent.id);
		const grandchild = await store.createCollection("Grandchild", child.id);
		await expect(store.updateCollection(parent.id, { parentId: grandchild.id })).rejects.toThrow("descendants");
		await expect(store.updateCollection(child.id, { parentId: child.id })).rejects.toThrow("itself");
		const moved = await store.updateCollection(grandchild.id, { parentId: null });
		expect(moved.parentId).toBeUndefined();
	});

	it("renames a collection", async () => {
		const store = await memStore();
		const collection = await store.createCollection("Old Name");
		const updated = await store.renameCollection(collection.id, "New Name");
		expect(updated.name).toBe("New Name");
		expect((await store.getCollection(collection.id))?.name).toBe("New Name");
	});

	it("sets paper collections and reads them back", async () => {
		const store = await memStore();
		const record = paper();
		await store.upsertPaper(record);
		const col = await store.createCollection("Fuzzing");
		await store.setPaperCollections(record.id, [col.id]);
		const back = await store.getPaper(record.id);
		expect(back?.collectionIds).toEqual([col.id]);
	});

	it("removes a paper from a collection when the collection is deleted", async () => {
		const store = await memStore();
		const record = paper();
		await store.upsertPaper(record);
		const col = await store.createCollection("To Delete");
		await store.setPaperCollections(record.id, [col.id]);
		await store.deleteCollection(col.id);
		const back = await store.getPaper(record.id);
		expect(back?.collectionIds ?? []).not.toContain(col.id);
		expect(await store.getCollection(col.id)).toBeUndefined();
	});

	it("deletes a complete collection subtree without deleting its papers", async () => {
		const store = await memStore();
		const parent = await store.createCollection("Parent");
		const child = await store.createCollection("Child", parent.id);
		const grandchild = await store.createCollection("Grandchild", child.id);
		const retained = await store.createCollection("Retained");
		const record = paper({ collectionIds: [grandchild.id, retained.id] });
		await store.upsertPaper(record);
		const deletedIds = await store.deleteCollection(parent.id);
		expect(deletedIds).toEqual([parent.id, child.id, grandchild.id]);
		expect(await store.getCollection(parent.id)).toBeUndefined();
		expect(await store.getCollection(child.id)).toBeUndefined();
		expect(await store.getCollection(grandchild.id)).toBeUndefined();
		expect(await store.getPaper(record.id)).toMatchObject({ collectionIds: [retained.id] });
	});
});
