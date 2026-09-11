import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	DerivedRecord,
	PaperCollection,
	PaperRecord,
	PaperVersion,
	SearchRun,
} from "../domain/literature-types.ts";

import { json, parseJson, pathExists, requireLegacyJson } from "./personal-database-support.ts";
import { PersonalFileRepository } from "./personal-file-repository.ts";

export abstract class PersonalLegacyCorpusMigration extends PersonalFileRepository {
	protected async migrateLegacyCorpus(): Promise<void> {
		const migration = this.read(
			(database) =>
				database.prepare("SELECT status FROM legacy_migrations WHERE namespace_id = ?").get(this.namespace) as
					| { status: string }
					| undefined,
		);
		if (migration?.status === "completed") return;
		const recordsRoot = join(this.legacyRoot, "records");
		if (!(await pathExists(recordsRoot))) {
			this.write((database) =>
				database
					.prepare(
						"INSERT OR REPLACE INTO legacy_migrations(namespace_id, status, started_at, completed_at) VALUES (?, 'completed', ?, ?)",
					)
					.run(this.namespace, new Date().toISOString(), new Date().toISOString()),
			);
			return;
		}

		const timestamp = new Date()
			.toISOString()
			.replace(/[^0-9]/g, "")
			.slice(0, 14);
		const backupRoot = join(dirname(this.databasePath), "legacy-backups", `${this.namespace}-${timestamp}`);
		await mkdir(backupRoot, { recursive: true });
		for (const name of [
			"records",
			"collections",
			"paper-versions",
			"search-runs",
			"derived",
			"imports",
			"exports",
			"blobs",
			"manifest.json",
		]) {
			const source = join(this.legacyRoot, name);
			if (await pathExists(source)) await cp(source, join(backupRoot, name), { recursive: true });
		}
		this.write((database) =>
			database
				.prepare(
					"INSERT OR REPLACE INTO legacy_migrations(namespace_id, status, backup_path, started_at) VALUES (?, 'running', ?, ?)",
				)
				.run(this.namespace, backupRoot, new Date().toISOString()),
		);

		try {
			const collectionNames = (await readdir(join(this.legacyRoot, "collections")).catch(() => [])).filter((name) =>
				name.endsWith(".json"),
			);
			const collections = await Promise.all(
				collectionNames.map(async (name) =>
					parseJson<PaperCollection>(await readFile(join(this.legacyRoot, "collections", name), "utf8")),
				),
			);
			const recordNames = (await readdir(recordsRoot)).filter((name) => name.endsWith(".json"));
			const records = await Promise.all(
				recordNames.map(async (name) => parseJson<PaperRecord>(await readFile(join(recordsRoot, name), "utf8"))),
			);
			this.write((database) => {
				for (const collection of collections)
					database
						.prepare(
							"INSERT OR IGNORE INTO collections(id, namespace_id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
						)
						.run(collection.id, this.namespace, collection.name, collection.createdAt, collection.updatedAt);
				for (const collection of collections.filter((value) => value.parentId))
					database
						.prepare("UPDATE collections SET parent_id = ? WHERE namespace_id = ? AND id = ?")
						.run(collection.parentId!, this.namespace, collection.id);
				for (const record of records) this.syncPaper(database, record);
			});
			for (const record of records) {
				const path = join(this.legacyRoot, "paper-versions", `${record.id}.json`);
				if (!(await pathExists(path))) continue;
				const versions = parseJson<PaperVersion[]>(await readFile(path, "utf8"));
				for (const version of versions) {
					if (!(await pathExists(version.blobPath))) continue;
					await this.savePaperVersion({ ...version, paperId: record.id });
				}
			}
			const runNames = (await readdir(join(this.legacyRoot, "search-runs")).catch(() => [])).filter((name) =>
				name.endsWith(".json"),
			);
			for (const name of runNames)
				await this.saveSearchRun(
					parseJson<SearchRun>(await readFile(join(this.legacyRoot, "search-runs", name), "utf8")),
				);
			const derivedNames = (await readdir(join(this.legacyRoot, "derived")).catch(() => [])).filter((name) =>
				name.endsWith(".json"),
			);
			for (const name of derivedNames)
				await this.putDerived(
					parseJson<DerivedRecord>(await readFile(join(this.legacyRoot, "derived", name), "utf8")),
					true,
				);
			const importNames = (await readdir(join(this.legacyRoot, "imports")).catch(() => [])).filter((name) =>
				name.endsWith(".json"),
			);
			this.write((database) => {
				for (const name of importNames) {
					const path = join(this.legacyRoot, "imports", name);
					const report = parseJson<Record<string, unknown>>(requireLegacyJson(path));
					const id = name.slice(0, -".json".length);
					const now = String(report.generatedAt ?? new Date().toISOString());
					database
						.prepare(`INSERT OR IGNORE INTO import_runs(
						id, namespace_id, input_path, status, started_at, completed_at, parsed_count,
						imported_count, needs_metadata_count, rejected_count, report_json
					) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`)
						.run(
							id,
							this.namespace,
							typeof report.inputPath === "string" ? report.inputPath : null,
							now,
							now,
							Number(report.parsed ?? 0),
							Number(report.imported ?? 0),
							Array.isArray(report.needsMetadata) ? report.needsMetadata.length : 0,
							Array.isArray(report.rejected) ? report.rejected.length : 0,
							json(report),
						);
				}
			});
			this.write((database) =>
				database
					.prepare(
						"UPDATE legacy_migrations SET status = 'completed', completed_at = ?, error = NULL WHERE namespace_id = ?",
					)
					.run(new Date().toISOString(), this.namespace),
			);
		} catch (error) {
			this.write((database) =>
				database
					.prepare(
						"UPDATE legacy_migrations SET status = 'failed', completed_at = ?, error = ? WHERE namespace_id = ?",
					)
					.run(new Date().toISOString(), error instanceof Error ? error.message : String(error), this.namespace),
			);
			throw error;
		}
	}
}
