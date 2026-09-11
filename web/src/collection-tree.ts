import type { PaperCollection } from "./types.ts";

export const COLLECTION_DRAG_TYPE = "application/x-paper-agent-collection";
export const PAPER_DRAG_TYPE = "application/x-paper-agent-paper-ids";

export interface CollectionTreeNode {
	collection: PaperCollection;
	children: CollectionTreeNode[];
	path: string[];
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function hasInvalidParent(collection: PaperCollection, byId: Map<string, PaperCollection>): boolean {
	if (!collection.parentId || !byId.has(collection.parentId)) return true;
	const visited = new Set([collection.id]);
	let parentId: string | undefined = collection.parentId;
	while (parentId) {
		if (visited.has(parentId)) return true;
		visited.add(parentId);
		parentId = byId.get(parentId)?.parentId;
	}
	return false;
}

export function buildCollectionTree(collections: PaperCollection[]): CollectionTreeNode[] {
	const byId = new Map(collections.map((collection) => [collection.id, collection]));
	const children = new Map<string, PaperCollection[]>();
	const roots: PaperCollection[] = [];
	for (const collection of collections) {
		if (!collection.parentId || hasInvalidParent(collection, byId)) {
			roots.push(collection);
			continue;
		}
		const siblings = children.get(collection.parentId) ?? [];
		siblings.push(collection);
		children.set(collection.parentId, siblings);
	}
	const makeNodes = (items: PaperCollection[], parentPath: string[]): CollectionTreeNode[] =>
		[...items]
			.sort((left, right) => collator.compare(left.name, right.name) || left.id.localeCompare(right.id))
			.map((collection) => {
				const path = [...parentPath, collection.name];
				return { collection, path, children: makeNodes(children.get(collection.id) ?? [], path) };
			});
	return makeNodes(roots, []);
}

export function flattenCollectionTree(nodes: CollectionTreeNode[]): CollectionTreeNode[] {
	const result: CollectionTreeNode[] = [];
	const visit = (node: CollectionTreeNode) => {
		result.push(node);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return result;
}

export function collectionDescendantIds(nodes: CollectionTreeNode[], collectionId: string): string[] {
	const node = flattenCollectionTree(nodes).find((candidate) => candidate.collection.id === collectionId);
	if (!node) return [];
	return flattenCollectionTree(node.children).map((candidate) => candidate.collection.id);
}
