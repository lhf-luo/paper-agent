import { describe, expect, it } from "vitest";
import {
	ALL_ZOTERO_ITEMS,
	allZoteroItemKeys,
	missingMetadataZoteroItems,
	UNCATEGORIZED_ZOTERO_ITEMS,
	zoteroItemsForCollection,
} from "../web/src/zotero-selection.ts";
import type { ZoteroCollectionEntry, ZoteroLibraryItem } from "../web/src/types.ts";

const collections: ZoteroCollectionEntry[] = [
	{ key: "A", version: 1, name: "A", path: ["A"] },
	{ key: "B", version: 1, name: "B", parentKey: "A", path: ["A", "B"] },
	{ key: "C", version: 1, name: "C", parentKey: "B", path: ["A", "B", "C"] },
];

const item = (key: string, collectionKeys: string[], valid = true): ZoteroLibraryItem => ({
	key,
	version: 1,
	title: key,
	authors: valid ? ["Author"] : [],
	itemType: "journalArticle",
	collectionKeys,
	collectionPaths: [],
	valid,
	missingFields: valid ? [] : ["authors"],
});

const items = [item("direct", ["A"]), item("child", ["B"]), item("deep", ["C"]), item("root", []), item("invalid", ["A"], false)];

describe("Zotero web selection", () => {
	it("uses direct papers for display and the full subtree for parent selection", () => {
		expect(zoteroItemsForCollection(collections, items, "A", false).map(({ key }) => key)).toEqual([
			"direct",
			"invalid",
		]);
		expect(zoteroItemsForCollection(collections, items, "A", true).map(({ key }) => key)).toEqual([
			"direct",
			"child",
			"deep",
			"invalid",
		]);
	});

	it("supports all and uncategorized views", () => {
		expect(zoteroItemsForCollection(collections, items, ALL_ZOTERO_ITEMS, false)).toEqual(items);
		expect(zoteroItemsForCollection(collections, items, UNCATEGORIZED_ZOTERO_ITEMS, false)).toEqual([
			items[3],
		]);
	});

	it("keeps invalid papers in category selection so their missing fields can be reported", () => {
		expect(allZoteroItemKeys(items)).toEqual(["direct", "child", "deep", "root", "invalid"]);
	});

	it("keeps only missing-metadata papers after import", () => {
		const previews = [
			{ itemKey: "missing", itemVersion: 1, action: "skip" as const, collectionPaths: [], warnings: [], missingFields: ["authors" as const] },
			{ itemKey: "existing", itemVersion: 1, action: "unchanged" as const, collectionPaths: [], warnings: [] },
			{ itemKey: "conflict", itemVersion: 1, action: "conflict" as const, collectionPaths: [], warnings: [], conflict: "identifier conflict" },
		];
		expect(missingMetadataZoteroItems(previews).map((item) => item.itemKey)).toEqual(["missing"]);
	});
});
