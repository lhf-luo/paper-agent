import type { PaperCollection, PaperRecord, ScreeningStatus } from "../../literature/domain/literature-types.ts";

import { PaperAgentOperations } from "./paper-agent-operations.ts";

export abstract class PaperAgentLibrary extends PaperAgentOperations {
	async searchPersonalLibrary(input: {
		query?: string;

		yearFrom?: number;
		yearTo?: number;
		tags?: string[];
		screeningStatuses?: ScreeningStatus[];
		collectionId?: string;
		offset?: number;
		limit?: number;
	}) {
		const store = this.personalStore();
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
			corpusPath: store.root,
			collectionId: input.collectionId,
			...page,
		};
	}

	async listLibraryCollections(): Promise<PaperCollection[]> {
		const store = this.personalStore();
		await store.initialize();
		return store.listCollections();
	}

	async libraryCollectionMemberships() {
		const store = this.personalStore();
		await store.initialize();
		return { ...(await store.collectionMemberships()) };
	}

	async createLibraryCollection(name: string, parentId: string | undefined): Promise<PaperCollection> {
		return this.personalStore().createCollection(name, parentId);
	}

	async renameLibraryCollection(id: string, name: string): Promise<PaperCollection> {
		return this.personalStore().renameCollection(id, name);
	}

	async updateLibraryCollection(
		id: string,
		updates: { name?: string; parentId?: string | null },
	): Promise<PaperCollection> {
		return this.personalStore().updateCollection(id, updates);
	}

	async deleteLibraryCollection(id: string): Promise<string[]> {
		return this.personalStore().deleteCollection(id);
	}

	async updateLibraryCollectionMembership(
		collectionId: string,
		paperIds: string[],
		mode: "assign" | "unassign",
	): Promise<PaperRecord[]> {
		return this.personalStore().updatePaperCollectionMembership(paperIds, collectionId, mode);
	}

	async setPaperCollections(paperId: string, collectionIds: string[]): Promise<PaperRecord> {
		return this.personalStore().setPaperCollections(paperId, collectionIds);
	}
}
