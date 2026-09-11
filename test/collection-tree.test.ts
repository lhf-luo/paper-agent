import { describe, expect, it } from "vitest";
import {
	buildCollectionTree,
	collectionDescendantIds,
	flattenCollectionTree,
} from "../web/src/collection-tree.ts";
import type { PaperCollection } from "../web/src/types.ts";

const collection = (id: string, name: string, parentId?: string): PaperCollection => ({
	id,
	name,
	parentId,
	createdAt: "2026-09-04T00:00:00.000Z",
	updatedAt: "2026-09-04T00:00:00.000Z",
});

describe("collection tree", () => {
	it("builds arbitrary depth and sorts siblings by name", () => {
		const tree = buildCollectionTree([
			collection("second", "B"),
			collection("child", "Child", "first"),
			collection("grandchild", "Grandchild", "child"),
			collection("first", "A"),
		]);
		expect(tree.map((node) => node.collection.id)).toEqual(["first", "second"]);
		expect(flattenCollectionTree(tree).map((node) => node.path.join(" / "))).toEqual([
			"A",
			"A / Child",
			"A / Child / Grandchild",
			"B",
		]);
		expect(collectionDescendantIds(tree, "first")).toEqual(["child", "grandchild"]);
	});

	it("shows orphaned and cyclic legacy collections at the root", () => {
		const tree = buildCollectionTree([
			collection("orphan", "Orphan", "missing"),
			collection("left", "Left", "right"),
			collection("right", "Right", "left"),
		]);
		expect(flattenCollectionTree(tree).map((node) => node.collection.id).sort()).toEqual([
			"left",
			"orphan",
			"right",
		]);
	});
});
