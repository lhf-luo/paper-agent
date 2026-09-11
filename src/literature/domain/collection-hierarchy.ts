import type { PaperCollection } from "./literature-types.ts";

export function collectionDescendantIds(collections: PaperCollection[], rootId: string): string[] {
	const children = new Map<string, string[]>();
	for (const collection of collections) {
		if (!collection.parentId) continue;
		const siblings = children.get(collection.parentId) ?? [];
		siblings.push(collection.id);
		children.set(collection.parentId, siblings);
	}
	const result: string[] = [];
	const pending = [rootId];
	const visited = new Set<string>();
	while (pending.length) {
		const id = pending.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		result.push(id);
		pending.push(...(children.get(id) ?? []));
	}
	return result;
}

export function validateCollectionParent(
	collections: PaperCollection[],
	collectionId: string,
	parentId: string | undefined,
): void {
	if (!parentId) return;
	if (!collections.some((collection) => collection.id === parentId)) {
		throw new Error(`Collection parent was not found in this namespace: ${parentId}`);
	}
	if (collectionId === parentId || collectionDescendantIds(collections, collectionId).includes(parentId)) {
		throw new Error("A collection cannot be moved into itself or one of its descendants");
	}
}
