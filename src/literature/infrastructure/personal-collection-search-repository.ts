import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { collectionDescendantIds, validateCollectionParent } from "../domain/collection-hierarchy.ts";
import type { PaperCollection, PaperRecord, PaperVersion, SearchRun } from "../domain/literature-types.ts";

import { json, parseJson, pathExists } from "./personal-database-support.ts";
import { PersonalResearchNoteRepository } from "./personal-research-note-repository.ts";

export abstract class PersonalCollectionSearchRepository extends PersonalResearchNoteRepository {
	async deletePaper(id: string): Promise<PaperVersion[]> {
		await this.initialize();
		const versions = await this.listPaperVersions(id);
		this.write((database) => {
			const row = this.paperRow(database, id);
			if (!row) return;
			const fileIds = database
				.prepare("SELECT file_id FROM paper_versions WHERE paper_row_id = ?")
				.all(row.row_id) as unknown as Array<{ file_id: string }>;
			database
				.prepare("DELETE FROM derived_records WHERE namespace_id = ? AND paper_id = ?")
				.run(this.namespace, id);
			database
				.prepare("DELETE FROM artifact_manifests WHERE namespace_id = ? AND paper_id = ?")
				.run(this.namespace, id);
			database.prepare("DELETE FROM paper_search WHERE paper_row_id = ?").run(row.row_id);
			database.prepare("DELETE FROM papers WHERE row_id = ?").run(row.row_id);
			for (const file of fileIds) database.prepare("DELETE FROM stored_files WHERE id = ?").run(file.file_id);
		});
		return versions;
	}

	async listCollections(): Promise<PaperCollection[]> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "collections")))
		)
			return [];
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare(
						"SELECT id, name, parent_id, created_at, updated_at FROM collections WHERE namespace_id = ? ORDER BY created_at, id",
					)
					.all(this.namespace) as unknown as Array<{
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
					"INSERT INTO collections(id, namespace_id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, updated_at=excluded.updated_at",
				)
				.run(
					collection.id,
					this.namespace,
					collection.name,
					collection.parentId ?? null,
					collection.createdAt,
					collection.updatedAt,
				);
		});
	}

	async updateCollection(
		id: string,
		updates: { name?: string; parentId?: string | null },
	): Promise<PaperCollection> {
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
				.prepare("UPDATE collections SET name = ?, parent_id = ?, updated_at = ? WHERE namespace_id = ? AND id = ?")
				.run(updated.name, updated.parentId ?? null, updated.updatedAt, this.namespace, id);
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
				database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = ?")
					.all(this.namespace) as unknown as Array<{ record_json: string }>
			)
				.map((row) => parseJson<PaperRecord>(row.record_json))
				.filter((paper) => paper.collectionIds?.some((collectionId) => deletedSet.has(collectionId)));
			for (const collectionId of [...deletedIds].reverse()) {
				database.prepare("DELETE FROM collections WHERE namespace_id = ? AND id = ?").run(this.namespace, collectionId);
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
				const row = database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = ? AND paper_id = ?")
					.get(this.namespace, paperId) as { record_json: string } | undefined;
				return row ? parseJson<PaperRecord>(row.record_json) : undefined;
			});
			const missing = uniqueIds.filter((_, index) => !records[index]);
			if (missing.length) throw new Error(`Paper ids were not found: ${missing.join(", ")}`);
			return records.filter((record): record is PaperRecord => Boolean(record)).map((record) => {
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
				.prepare("SELECT id, name, parent_id, created_at, updated_at FROM collections WHERE namespace_id = ?")
				.all(this.namespace) as unknown as Array<{
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
			.prepare(`INSERT INTO search_runs(namespace_id, id, started_at, completed_at, filters_json, pages_per_provider, max_results_per_provider, deduplicated_count, corpus_hit_count, scope, mode, resumed_from_checkpoint, search_plan_json, candidate_table_json, run_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(namespace_id, id) DO UPDATE SET completed_at=excluded.completed_at, run_json=excluded.run_json, candidate_table_json=excluded.candidate_table_json`)
			.run(
				this.namespace,
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
			database.prepare(`DELETE FROM ${table} WHERE namespace_id = ? AND run_id = ?`).run(this.namespace, run.id);
		const queryInsert = database.prepare(
			"INSERT INTO search_run_queries(namespace_id, run_id, position, query) VALUES (?, ?, ?, ?)",
		);
		for (const [position, query] of run.queries.entries()) queryInsert.run(this.namespace, run.id, position, query);
		const providerInsert = database.prepare(
			"INSERT INTO search_run_providers(namespace_id, run_id, provider, position, source_count, health_status, record_count, failure_count, checked_at, message, retry_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		run.providers.forEach((provider, position) => {
			const health = run.providerHealth?.[provider];
			providerInsert.run(
				this.namespace,
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
			"INSERT INTO search_run_results(namespace_id, run_id, position, paper_id, record_json) VALUES (?, ?, ?, ?, ?)",
		);
		for (const [position, record] of run.results.entries())
			resultInsert.run(this.namespace, run.id, position, record.id, json(record));
		const failureInsert = database.prepare(
			"INSERT INTO search_failures(namespace_id, run_id, provider, query, message, retryable, status_code, rate_limited, retry_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const failure of run.failures)
			failureInsert.run(
				this.namespace,
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
			"INSERT INTO possible_duplicates(namespace_id, run_id, left_paper_id, right_paper_id, title_similarity, reason) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const duplicate of run.possibleDuplicates ?? [])
			duplicateInsert.run(
				this.namespace,
				run.id,
				duplicate.leftId,
				duplicate.rightId,
				duplicate.titleSimilarity,
				duplicate.reason,
			);
	}

	async saveSearchRun(run: SearchRun, keep = 30): Promise<void> {
		await this.initialize();
		this.write((database) => {
			this.syncSearchRun(database, run);
			const stale = database
				.prepare("SELECT id FROM search_runs WHERE namespace_id = ? ORDER BY completed_at DESC LIMIT -1 OFFSET ?")
				.all(this.namespace, keep) as unknown as Array<{ id: string }>;
			for (const row of stale)
				database.prepare("DELETE FROM search_runs WHERE namespace_id = ? AND id = ?").run(this.namespace, row.id);
		});
	}

	async getSearchRun(id: string): Promise<SearchRun | undefined> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "search-runs", `${id}.json`)))
		)
			return undefined;
		await this.initialize();
		return this.read((database) => {
			const row = database
				.prepare("SELECT run_json FROM search_runs WHERE namespace_id = ? AND id = ?")
				.get(this.namespace, id) as { run_json: string } | undefined;
			return row ? parseJson<SearchRun>(row.run_json) : undefined;
		});
	}

	async listSearchRuns(): Promise<SearchRun[]> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "search-runs")))
		)
			return [];
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare("SELECT run_json FROM search_runs WHERE namespace_id = ? ORDER BY completed_at DESC")
					.all(this.namespace) as unknown as Array<{ run_json: string }>
			).map((row) => parseJson<SearchRun>(row.run_json)),
		);
	}
}
