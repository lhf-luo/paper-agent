import { join } from "node:path";
import type { DerivedRecord } from "../domain/literature-types.ts";
import { PersonalCollectionSearchRepository } from "./personal-collection-search-repository.ts";
import { json, parseJson, pathExists } from "./personal-database-support.ts";

export abstract class PersonalDerivedRepository extends PersonalCollectionSearchRepository {
	async putDerived(record: DerivedRecord, replace = false): Promise<"created" | "replaced" | "unchanged"> {
		await this.initialize();
		return this.write((database) => {
			const current = database
				.prepare(
					"SELECT revision, record_json FROM derived_records WHERE namespace_id = ? AND task_key = ? AND is_current = 1",
				)
				.get(this.namespace, record.key) as { revision: number; record_json: string } | undefined;
			if (current && current.record_json === json(record)) return "unchanged";
			if (current && !replace)
				throw new Error(`Derived task key collision: ${record.key}; use a new version or configuration`);
			if (current)
				database
					.prepare("UPDATE derived_records SET is_current = 0 WHERE namespace_id = ? AND task_key = ?")
					.run(this.namespace, record.key);
			const revision = (current?.revision ?? 0) + 1;
			database
				.prepare(
					"INSERT INTO derived_records(namespace_id, task_key, revision, paper_id, operation, input_hashes_json, pipeline_version, model_version, prompt_version, config_json, result_json, record_json, created_by, created_at, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
				)
				.run(
					this.namespace,
					record.key,
					revision,
					record.paperId,
					record.operation,
					json(record.inputHashes),
					record.pipelineVersion,
					record.modelVersion ?? null,
					record.promptVersion ?? null,
					json(record.normalizedConfig),
					json(record.result),
					json(record),
					record.createdBy ?? null,
					record.createdAt,
				);
			return current ? "replaced" : "created";
		});
	}

	async getDerived(key: string): Promise<DerivedRecord | undefined> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "derived", `${key}.json`)))
		)
			return undefined;
		await this.initialize();
		return this.read((database) => {
			const row = database
				.prepare(
					"SELECT record_json FROM derived_records WHERE namespace_id = ? AND task_key = ? AND is_current = 1",
				)
				.get(this.namespace, key) as { record_json: string } | undefined;
			return row ? parseJson<DerivedRecord>(row.record_json) : undefined;
		});
	}

	async listDerived(options: { paperId?: string; operation?: string } = {}): Promise<DerivedRecord[]> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "derived")))
		)
			return [];
		await this.initialize();
		return this.read((database) => {
			const rows = database
				.prepare(
					"SELECT record_json FROM derived_records WHERE namespace_id = ? AND is_current = 1 ORDER BY created_at DESC",
				)
				.all(this.namespace) as unknown as Array<{ record_json: string }>;
			return rows
				.map((row) => parseJson<DerivedRecord>(row.record_json))
				.filter(
					(record) =>
						(!options.paperId || record.paperId === options.paperId) &&
						(!options.operation || record.operation === options.operation),
				);
		});
	}
}
