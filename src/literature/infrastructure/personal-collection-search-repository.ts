import type { DatabaseSync } from "node:sqlite";
import { collectionDescendantIds, validateCollectionParent } from "../domain/collection-hierarchy.ts";
import type { PaperCollection, PaperRecord, PaperVersion, SearchRun } from "../domain/literature-types.ts";

import { json, parseJson, pathExists } from "./personal-database-support.ts";
import { PersonalResearchNoteRepository } from "./personal-research-note-repository.ts";

export abstract class PersonalCollectionSearchRepository extends PersonalResearchNoteRepository {
	async paperDeletionImpact(ids: string[]): Promise<{
		pdfVersionCount: number;
		pdfBytes: number;
		derivedRecordCount: number;
	}> {
		await this.initialize();
		const uniqueIds = [...new Set(ids)];
		if (!uniqueIds.length) return { pdfVersionCount: 0, pdfBytes: 0, derivedRecordCount: 0 };
		return this.read((database) => {
			const placeholders = uniqueIds.map(() => "?").join(", ");
			const versions = database
				.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(sf.bytes), 0) AS bytes
					FROM paper_versions pv
					JOIN papers p ON p.row_id = pv.paper_row_id
					JOIN stored_files sf ON sf.id = pv.file_id
					WHERE p.paper_id IN (${placeholders})`)
				.get(...uniqueIds) as { count: number; bytes: number };
			const derived = database
				.prepare(`SELECT COUNT(*) AS count FROM derived_records
					WHERE is_current = 1 AND paper_id IN (${placeholders})`)
				.get(...uniqueIds) as { count: number };
			return {
				pdfVersionCount: versions.count,
				pdfBytes: versions.bytes,
				derivedRecordCount: derived.count,
			};
		});
	}

	async collectionMemberships(): Promise<{
		allPaperIds: string[];
		uncategorizedPaperIds: string[];
		collectionPaperIds: Record<string, string[]>;
	}> {
		await this.initialize();
		return this.read((database) => {
			const allPaperIds = (
				database.prepare("SELECT paper_id FROM papers ORDER BY paper_id").all() as unknown as Array<{
					paper_id: string;
				}>
			).map((row) => row.paper_id);
			const uncategorizedPaperIds = (
				database
					.prepare(`SELECT p.paper_id FROM papers p
						WHERE NOT EXISTS (SELECT 1 FROM paper_collections pc WHERE pc.paper_row_id = p.row_id)
						ORDER BY p.paper_id`)
					.all() as unknown as Array<{ paper_id: string }>
			).map((row) => row.paper_id);
			const collectionPaperIds: Record<string, string[]> = Object.fromEntries(
				this.collectionRows(database).map((collection) => [collection.id, []]),
			);
			const memberships = database
				.prepare(`SELECT pc.collection_id, p.paper_id
					FROM paper_collections pc JOIN papers p ON p.row_id = pc.paper_row_id ORDER BY pc.collection_id, p.paper_id`)
				.all() as unknown as Array<{ collection_id: string; paper_id: string }>;
			for (const row of memberships) collectionPaperIds[row.collection_id]?.push(row.paper_id);
			return { allPaperIds, uncategorizedPaperIds, collectionPaperIds };
		});
	}

	async deletePaper(id: string): Promise<PaperVersion[]> {
		await this.initialize();
		const versions = await this.listPaperVersions(id);
		this.write((database) => {
			const row = this.paperRow(database, id);
			if (!row) return;
			const fileIds = database
				.prepare("SELECT file_id FROM paper_versions WHERE paper_row_id = ?")
				.all(row.row_id) as unknown as Array<{ file_id: string }>;
			database.prepare("DELETE FROM derived_records WHERE paper_id = ?").run(id);
			database.prepare("DELETE FROM artifact_manifests WHERE paper_id = ?").run(id);
			database.prepare("DELETE FROM paper_search WHERE paper_row_id = ?").run(row.row_id);
			database.prepare("DELETE FROM papers WHERE row_id = ?").run(row.row_id);
			for (const file of fileIds) database.prepare("DELETE FROM stored_files WHERE id = ?").run(file.file_id);
		});
		return versions;
	}

	async deletePapers(ids: string[]): Promise<{ deleted: string[]; missing: string[] }> {
		await this.initialize();
		const uniqueIds = [...new Set(ids)];
		return this.write((database) => {
			const deleted: string[] = [];
			const missing: string[] = [];
			const rowQuery = database.prepare("SELECT row_id FROM papers WHERE paper_id = ?");
			const fileQuery = database.prepare("SELECT file_id FROM paper_versions WHERE paper_row_id = ?");
			const deleteDerived = database.prepare("DELETE FROM derived_records WHERE paper_id = ?");
			const deleteArtifacts = database.prepare("DELETE FROM artifact_manifests WHERE paper_id = ?");
			const deleteSearch = database.prepare("DELETE FROM paper_search WHERE paper_row_id = ?");
			const deletePaper = database.prepare("DELETE FROM papers WHERE row_id = ?");
			const deleteFile = database.prepare("DELETE FROM stored_files WHERE id = ?");
			for (const id of uniqueIds) {
				const row = rowQuery.get(id) as { row_id: number } | undefined;
				if (!row) {
					missing.push(id);
					continue;
				}
				const fileIds = fileQuery.all(row.row_id) as unknown as Array<{ file_id: string }>;
				deleteDerived.run(id);
				deleteArtifacts.run(id);
				deleteSearch.run(row.row_id);
				deletePaper.run(row.row_id);
				for (const file of fileIds) deleteFile.run(file.file_id);
				deleted.push(id);
			}
			return { deleted, missing };
		});
	}

	async listCollections(): Promise<PaperCollection[]> {
		if (!this.initialized && !(await pathExists(this.databasePath))) return [];
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare("SELECT id, name, parent_id, created_at, updated_at FROM collections ORDER BY created_at, id")
					.all() as unknown as Array<{
					id: string;
					name: string;
					parent_id: string | null;
					created_at: string;
					updated_at: string;
				}>
			).map((row) => ({
				id: row.id,
				name: row.name,
				parentId: row.parent_id ?? undefined,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			})),
		);
	}

	async getCollection(id: string): Promise<PaperCollection | undefined> {
		return (await this.listCollections()).find((value) => value.id === id);
	}

	async saveCollection(collection: PaperCollection): Promise<void> {
		await this.initialize();
		this.write((database) => {
			const collections = this.collectionRows(database);
			validateCollectionParent(collections, collection.id, collection.parentId);
			database
				.prepare(
					"INSERT INTO collections(id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, updated_at=excluded.updated_at",
				)
				.run(
					collection.id,

					collection.name,
					collection.parentId ?? null,
					collection.createdAt,
					collection.updatedAt,
				);
		});
	}

	async updateCollection(id: string, updates: { name?: string; parentId?: string | null }): Promise<PaperCollection> {
		await this.initialize();
		return this.write((database) => {
			const collections = this.collectionRows(database);
			const existing = collections.find((collection) => collection.id === id);
			if (!existing) throw new Error(`Collection not found: ${id}`);
			const parentId = updates.parentId === null ? undefined : (updates.parentId ?? existing.parentId);
			validateCollectionParent(collections, id, parentId);
			const updated: PaperCollection = {
				...existing,
				name: updates.name ?? existing.name,
				parentId,
				updatedAt: new Date().toISOString(),
			};
			database
				.prepare("UPDATE collections SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?")
				.run(updated.name, updated.parentId ?? null, updated.updatedAt, id);
			return updated;
		});
	}

	async deleteCollection(id: string): Promise<string[]> {
		await this.initialize();
		return this.write((database) => {
			const collections = this.collectionRows(database);
			if (!collections.some((collection) => collection.id === id)) return [];
			const deletedIds = collectionDescendantIds(collections, id);
			const deletedSet = new Set(deletedIds);
			const affected = (
				database.prepare("SELECT record_json FROM papers").all() as unknown as Array<{ record_json: string }>
			)
				.map((row) => parseJson<PaperRecord>(row.record_json))
				.filter((paper) => paper.collectionIds?.some((collectionId) => deletedSet.has(collectionId)));
			for (const collectionId of [...deletedIds].reverse()) {
				database.prepare("DELETE FROM collections WHERE id = ?").run(collectionId);
			}
			for (const paper of affected) {
				this.syncPaper(database, {
					...paper,
					collectionIds: paper.collectionIds?.filter((collectionId) => !deletedSet.has(collectionId)),
				});
			}
			return deletedIds;
		});
	}

	async updatePaperCollectionMembership(
		paperIds: string[],
		collectionId: string,
		mode: "assign" | "unassign",
	): Promise<PaperRecord[]> {
		await this.initialize();
		return this.write((database) => {
			if (!this.collectionRows(database).some((collection) => collection.id === collectionId)) {
				throw new Error(`Collection not found: ${collectionId}`);
			}
			const uniqueIds = [...new Set(paperIds)];
			const records = uniqueIds.map((paperId) => {
				const row = database.prepare("SELECT record_json FROM papers WHERE paper_id = ?").get(paperId) as
					| { record_json: string }
					| undefined;
				return row ? parseJson<PaperRecord>(row.record_json) : undefined;
			});
			const missing = uniqueIds.filter((_, index) => !records[index]);
			if (missing.length) throw new Error(`Paper ids were not found: ${missing.join(", ")}`);
			return records
				.filter((record): record is PaperRecord => Boolean(record))
				.map((record) => {
					const collectionIds = new Set(record.collectionIds ?? []);
					if (mode === "assign") collectionIds.add(collectionId);
					else collectionIds.delete(collectionId);
					const updated = { ...record, collectionIds: collectionIds.size ? [...collectionIds] : undefined };
					this.syncPaper(database, updated);
					return updated;
				});
		});
	}

	private collectionRows(database: DatabaseSync): PaperCollection[] {
		return (
			database
				.prepare("SELECT id, name, parent_id, created_at, updated_at FROM collections")
				.all() as unknown as Array<{
				id: string;
				name: string;
				parent_id: string | null;
				created_at: string;
				updated_at: string;
			}>
		).map((row) => ({
			id: row.id,
			name: row.name,
			parentId: row.parent_id ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	async setPaperCollections(paperId: string, collectionIds: string[]): Promise<PaperRecord> {
		const record = await this.getPaper(paperId);
		if (!record) throw new Error(`Paper not found: ${paperId}`);
		const unique = [...new Set(collectionIds)];
		const known = new Set((await this.listCollections()).map((collection) => collection.id));
		const missing = unique.filter((id) => !known.has(id));
		if (missing.length) throw new Error(`Collection ids were not found: ${missing.join(", ")}`);
		const updated = { ...record, collectionIds: unique.length ? unique : undefined };
		await this.savePaper(updated);
		return updated;
	}

	protected syncSearchRun(database: DatabaseSync, run: SearchRun): void {
		database
			.prepare(`INSERT INTO search_runs( id, started_at, completed_at, filters_json, pages_per_provider, max_results_per_provider, deduplicated_count, corpus_hit_count, scope, mode, resumed_from_checkpoint, search_plan_json, candidate_table_json, run_json)
			VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET completed_at=excluded.completed_at, run_json=excluded.run_json, candidate_table_json=excluded.candidate_table_json`)
			.run(
				run.id,
				run.startedAt,
				run.completedAt,
				json(run.filters),
				run.pagesPerProvider,
				run.maxResultsPerProvider,
				run.deduplicatedCount,
				run.corpusHitCount ?? null,
				run.scope,
				run.mode,
				Number(run.resumedFromCheckpoint ?? false),
				run.searchPlan ? json(run.searchPlan) : null,
				run.candidateTable ? json(run.candidateTable) : null,
				json(run),
			);
		for (const table of [
			"search_run_queries",
			"search_run_providers",
			"search_run_results",
			"search_failures",
			"possible_duplicates",
		])
			database.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(run.id);
		const queryInsert = database.prepare(
			"INSERT INTO search_run_queries( run_id, position, query) VALUES ( ?, ?, ?)",
		);
		for (const [position, query] of run.queries.entries()) queryInsert.run(run.id, position, query);
		const providerInsert = database.prepare(
			"INSERT INTO search_run_providers( run_id, provider, position, source_count, health_status, record_count, failure_count, checked_at, message, retry_after) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		run.providers.forEach((provider, position) => {
			const health = run.providerHealth?.[provider];
			providerInsert.run(
				run.id,
				provider,
				position,
				run.sourceCounts[provider] ?? null,
				health?.status ?? null,
				health?.recordCount ?? null,
				health?.failureCount ?? null,
				health?.checkedAt ?? null,
				health?.message ?? null,
				health?.retryAfter ?? null,
			);
		});
		const resultInsert = database.prepare(
			"INSERT INTO search_run_results( run_id, position, paper_id, record_json) VALUES ( ?, ?, ?, ?)",
		);
		for (const [position, record] of run.results.entries())
			resultInsert.run(run.id, position, record.id, json(record));
		const failureInsert = database.prepare(
			"INSERT INTO search_failures( run_id, provider, query, message, retryable, status_code, rate_limited, retry_after) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const failure of run.failures)
			failureInsert.run(
				run.id,
				failure.provider,
				failure.query,
				failure.message,
				Number(failure.retryable),
				failure.statusCode ?? null,
				failure.rateLimited === undefined ? null : Number(failure.rateLimited),
				failure.retryAfter ?? null,
			);
		const duplicateInsert = database.prepare(
			"INSERT INTO possible_duplicates( run_id, left_paper_id, right_paper_id, title_similarity, reason) VALUES ( ?, ?, ?, ?, ?)",
		);
		for (const duplicate of run.possibleDuplicates ?? [])
			duplicateInsert.run(run.id, duplicate.leftId, duplicate.rightId, duplicate.titleSimilarity, duplicate.reason);
	}

	async saveSearchRun(run: SearchRun): Promise<void> {
		await this.initialize();
		this.write((database) => this.syncSearchRun(database, run));
	}

	async getSearchRun(id: string): Promise<SearchRun | undefined> {
		if (!this.initialized && !(await pathExists(this.databasePath))) return undefined;
		await this.initialize();
		return this.read((database) => {
			const row = database.prepare("SELECT run_json FROM search_runs WHERE id = ?").get(id) as
				| { run_json: string }
				| undefined;
			return row ? parseJson<SearchRun>(row.run_json) : undefined;
		});
	}

	async listSearchRuns(): Promise<SearchRun[]> {
		if (!this.initialized && !(await pathExists(this.databasePath))) return [];
		await this.initialize();
		return this.read((database) =>
			(
				database.prepare("SELECT run_json FROM search_runs ORDER BY completed_at DESC").all() as unknown as Array<{
					run_json: string;
				}>
			).map((row) => parseJson<SearchRun>(row.run_json)),
		);
	}
}
