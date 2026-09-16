import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { collectionDescendantIds, validateCollectionParent } from "../domain/collection-hierarchy.ts";
import type { PaperCollection, PaperRecord } from "../domain/literature-types.ts";

import { pathExists, readJson, writeJsonAtomic } from "./literature-store-support.ts";
import { LiteratureStoreWrite } from "./literature-store-write.ts";

export abstract class LiteratureStoreLibrary extends LiteratureStoreWrite {
	async listPapers(): Promise<PaperRecord[]> {
		if (this.personalDatabase) return this.personalDatabase.listPapers();
		const directory = join(this.root, "records");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const records = await Promise.all(names.map((name) => readJson<PaperRecord>(join(directory, name))));
		return records.filter((value): value is PaperRecord => value !== undefined);
	}

	async listNamespaces(): Promise<string[]> {
		if (!this.personalDatabase) throw new Error("SQLite namespace listing is only available for personal corpora");
		return this.personalDatabase.listNamespaces();
	}

	async getPaper(id: string): Promise<PaperRecord | undefined> {
		if (this.personalDatabase) return this.personalDatabase.getPaper(id);
		const direct = await readJson<PaperRecord>(this.recordPath(id));
		if (direct) return direct;
		const aliases = (await this.listPapers()).filter((record) =>
			record.mergedFrom.some((alias) => alias.toLowerCase() === id.toLowerCase()),
		);
		if (aliases.length > 1) throw new Error(`Paper alias is ambiguous: ${id}`);
		return aliases[0];
	}

	async getCollection(id: string): Promise<PaperCollection | undefined> {
		if (this.personalDatabase) return this.personalDatabase.getCollection(id);
		return readJson<PaperCollection>(this.collectionPath(id));
	}

	async listCollections(): Promise<PaperCollection[]> {
		if (this.personalDatabase) return this.personalDatabase.listCollections();
		const directory = join(this.root, "collections");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const collections = await Promise.all(names.map((name) => readJson<PaperCollection>(join(directory, name))));
		return collections.filter((value): value is PaperCollection => value !== undefined);
	}

	/** 创建分类: 同一父级下同名则复用已有(幂等), 返回自动生成的 id。 */
	async createCollection(name: string, parentId?: string): Promise<PaperCollection> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("collection name is required");
		await this.initialize();
		const collections = await this.listCollections();
		validateCollectionParent(collections, "__new_collection__", parentId);
		const existing = collections.find(
			(collection) => collection.name === trimmed && (collection.parentId ?? undefined) === parentId,
		);
		if (existing) return existing;
		const now = new Date().toISOString();
		const collection: PaperCollection = {
			id: `col-${randomUUID().slice(0, 12)}`,
			name: trimmed,
			parentId,
			createdAt: now,
			updatedAt: now,
		};
		if (this.personalDatabase) {
			await this.personalDatabase.saveCollection(collection);
			return collection;
		}
		await this.withWriteLock(async () => {
			await writeJsonAtomic(this.collectionPath(collection.id), collection);
		});
		return collection;
	}

	async renameCollection(id: string, name: string): Promise<PaperCollection> {
		return this.updateCollection(id, { name });
	}

	async updateCollection(id: string, updates: { name?: string; parentId?: string | null }): Promise<PaperCollection> {
		const name = updates.name?.trim();
		if (updates.name !== undefined && !name) throw new Error("collection name is required");
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.updateCollection(id, { ...updates, name });
		const collections = await this.listCollections();
		const existing = collections.find((collection) => collection.id === id);
		if (!existing) throw new Error(`Collection not found: ${id}`);
		const parentId = updates.parentId === null ? undefined : (updates.parentId ?? existing.parentId);
		validateCollectionParent(collections, id, parentId);
		const updated: PaperCollection = {
			...existing,
			name: name ?? existing.name,
			parentId,
			updatedAt: new Date().toISOString(),
		};
		await this.withWriteLock(async () => {
			await writeJsonAtomic(this.collectionPath(id), updated);
		});
		return updated;
	}

	/** 删除分类树及其论文归属关系，不删除论文记录。 */
	async deleteCollection(id: string): Promise<string[]> {
		const collections = await this.listCollections();
		if (!collections.some((collection) => collection.id === id)) return [];
		if (this.personalDatabase) return this.personalDatabase.deleteCollection(id);
		const deletedIds = collectionDescendantIds(collections, id);
		const deletedSet = new Set(deletedIds);
		await this.withWriteLock(async () => {
			for (const collectionId of [...deletedIds].reverse()) {
				try {
					await unlink(this.collectionPath(collectionId));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const papers = await this.listPapers();
			for (const paper of papers) {
				if (paper.collectionIds?.some((collectionId) => deletedSet.has(collectionId))) {
					const updated = {
						...paper,
						collectionIds: paper.collectionIds.filter((collectionId) => !deletedSet.has(collectionId)),
					};
					await writeJsonAtomic(this.recordPath(paper.id), updated);
					await this.searchIndex.upsert(updated);
				}
			}
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
		});
		return deletedIds;
	}

	/** 设置一篇论文的分类(集合) id 列表, 多对多。 */
	async setPaperCollections(paperId: string, collectionIds: string[]): Promise<PaperRecord> {
		if (this.personalDatabase) return this.personalDatabase.setPaperCollections(paperId, collectionIds);
		const paper = await this.getPaper(paperId);
		if (!paper) throw new Error(`Paper not found: ${paperId}`);
		await this.initialize();
		const unique = Array.from(new Set(collectionIds));
		const updated: PaperRecord = { ...paper, collectionIds: unique.length ? unique : undefined };
		await this.withWriteLock(async () => {
			await writeJsonAtomic(this.recordPath(paperId), updated);
			await this.searchIndex.upsert(updated);
		});
		return updated;
	}

	async updatePaperCollectionMembership(
		paperIds: string[],
		collectionId: string,
		mode: "assign" | "unassign",
	): Promise<PaperRecord[]> {
		await this.initialize();
		if (this.personalDatabase) {
			return this.personalDatabase.updatePaperCollectionMembership(paperIds, collectionId, mode);
		}
		return this.withWriteLock(async () => {
			if (!(await this.getCollection(collectionId))) throw new Error(`Collection not found: ${collectionId}`);
			const uniqueIds = [...new Set(paperIds)];
			const records = await Promise.all(uniqueIds.map((id) => this.getPaper(id)));
			const missing = uniqueIds.filter((_, index) => !records[index]);
			if (missing.length) throw new Error(`Paper ids were not found: ${missing.join(", ")}`);
			const updated = records
				.filter((record): record is PaperRecord => Boolean(record))
				.map((record) => {
					const collectionIds = new Set(record.collectionIds ?? []);
					if (mode === "assign") collectionIds.add(collectionId);
					else collectionIds.delete(collectionId);
					return { ...record, collectionIds: collectionIds.size ? [...collectionIds] : undefined };
				});
			try {
				for (const record of updated) {
					await writeJsonAtomic(this.recordPath(record.id), record);
					await this.searchIndex.upsert(record);
				}
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
				return updated;
			} catch (error) {
				for (const record of records.filter((value): value is PaperRecord => Boolean(value))) {
					await writeJsonAtomic(this.recordPath(record.id), record);
					await this.searchIndex.upsert(record);
				}
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
				throw error;
			}
		});
	}
}
