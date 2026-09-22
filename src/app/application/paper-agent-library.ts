import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PaperCollection, PaperRecord, ScreeningStatus } from "../../literature/domain/literature-types.ts";

import { PaperAgentOperations } from "./paper-agent-operations.ts";

export abstract class PaperAgentLibrary extends PaperAgentOperations {
	async listNamespaces(scope: "personal" | "team"): Promise<string[]> {
		if (scope === "personal") return this.personalStore().listNamespaces();
		const root = join(this.corpusRoot, scope);
		try {
			return (await readdir(root, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async searchPersonalLibrary(input: {
		query?: string;
		namespace?: string;
		yearFrom?: number;
		yearTo?: number;
		tags?: string[];
		screeningStatuses?: ScreeningStatus[];
		collectionId?: string;
		offset?: number;
		limit?: number;
	}) {
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const page = await store.searchPapersPage({
			query: input.query,
			yearFrom: input.yearFrom,
			yearTo: input.yearTo,
			tags: input.tags,
			screeningStatuses: input.screeningStatuses,
			collectionId: input.collectionId,
			offset: input.offset,
			limit: input.limit ?? 100,
			readOnly: true,
		});
		return {
			namespace,
			corpusPath: store.root,
			collectionId: input.collectionId,
			...page,
		};
	}

	async listLibraryCollections(namespace = this.defaultNamespace): Promise<PaperCollection[]> {
		const store = this.personalStore(namespace);
		await store.initialize();
		return store.listCollections();
	}

	async libraryCollectionMemberships(namespace = this.defaultNamespace) {
		const store = this.personalStore(namespace);
		await store.initialize();
		return { namespace, ...(await store.collectionMemberships()) };
	}

	async createLibraryCollection(
		name: string,
		parentId: string | undefined,
		namespace = this.defaultNamespace,
	): Promise<PaperCollection> {
		return this.personalStore(namespace).createCollection(name, parentId);
	}

	async renameLibraryCollection(
		id: string,
		name: string,
		namespace = this.defaultNamespace,
	): Promise<PaperCollection> {
		return this.personalStore(namespace).renameCollection(id, name);
	}

	async updateLibraryCollection(
		id: string,
		updates: { name?: string; parentId?: string | null },
		namespace = this.defaultNamespace,
	): Promise<PaperCollection> {
		return this.personalStore(namespace).updateCollection(id, updates);
	}

	async deleteLibraryCollection(id: string, namespace = this.defaultNamespace): Promise<string[]> {
		return this.personalStore(namespace).deleteCollection(id);
	}

	async updateLibraryCollectionMembership(
		collectionId: string,
		paperIds: string[],
		mode: "assign" | "unassign",
		namespace = this.defaultNamespace,
	): Promise<PaperRecord[]> {
		return this.personalStore(namespace).updatePaperCollectionMembership(paperIds, collectionId, mode);
	}

	async setPaperCollections(
		paperId: string,
		collectionIds: string[],
		namespace = this.defaultNamespace,
	): Promise<PaperRecord> {
		return this.personalStore(namespace).setPaperCollections(paperId, collectionIds);
	}
}
