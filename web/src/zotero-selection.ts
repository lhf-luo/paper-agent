import type { ZoteroCollectionEntry, ZoteroImportPreparation, ZoteroLibraryItem } from "./types.js";

export const ALL_ZOTERO_ITEMS = "__all__";
export const UNCATEGORIZED_ZOTERO_ITEMS = "__uncategorized__";

function collectionScope(
	collections: ZoteroCollectionEntry[],
	collectionKey: string,
	includeChildren: boolean,
): Set<string> {
	const keys = new Set([collectionKey]);
	if (!includeChildren) return keys;
	let changed = true;
	while (changed) {
		changed = false;
		for (const collection of collections) {
			if (!collection.parentKey || !keys.has(collection.parentKey) || keys.has(collection.key)) continue;
			keys.add(collection.key);
			changed = true;
		}
	}
	return keys;
}

export function zoteroItemsForCollection(
	collections: ZoteroCollectionEntry[],
	items: ZoteroLibraryItem[],
	collectionKey: string,
	includeChildren: boolean,
): ZoteroLibraryItem[] {
	if (collectionKey === ALL_ZOTERO_ITEMS) return items;
	if (collectionKey === UNCATEGORIZED_ZOTERO_ITEMS) {
		return items.filter((item) => item.collectionKeys.length === 0);
	}
	const scope = collectionScope(collections, collectionKey, includeChildren);
	return items.filter((item) => item.collectionKeys.some((key) => scope.has(key)));
}

export function allZoteroItemKeys(items: ZoteroLibraryItem[]): string[] {
	return items.map((item) => item.key);
}

export function missingMetadataZoteroItems(
	items: ZoteroImportPreparation["items"],
): ZoteroImportPreparation["items"] {
	return items.filter((item) => item.action === "skip" && Boolean(item.missingFields?.length));
}
