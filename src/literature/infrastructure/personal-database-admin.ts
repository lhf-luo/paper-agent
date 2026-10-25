import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { backup as backupDatabase } from "node:sqlite";
import type { ZoteroCollectionMapping, ZoteroItemMapping } from "../../extensions/zotero/domain/zotero-types.ts";
import type { CorpusManifest } from "../domain/literature-types.ts";

import { pathExists } from "./personal-database-support.ts";
import { PersonalLocalImportRepository } from "./personal-local-import-repository.ts";

export class PersonalDatabaseAdmin extends PersonalLocalImportRepository {
	async listZoteroItemMappings(serverId: string): Promise<ZoteroItemMapping[]> {
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare(`SELECT p.paper_id, m.server_id, m.library_id, m.zotero_item_key,
					m.item_version, m.last_direction, m.last_synced_at
				FROM zotero_item_mappings m JOIN papers p ON p.row_id = m.paper_row_id
				WHERE m.server_id = ?`)
					.all(serverId) as unknown as Array<Record<string, string | number>>
			).map((row) => ({
				paperId: String(row.paper_id),
				serverId: String(row.server_id),
				libraryId: String(row.library_id),
				itemKey: String(row.zotero_item_key),
				itemVersion: Number(row.item_version),
				lastDirection: String(row.last_direction) as ZoteroItemMapping["lastDirection"],
				lastSyncedAt: String(row.last_synced_at),
			})),
		);
	}

	async listZoteroCollectionMappings(serverId: string): Promise<ZoteroCollectionMapping[]> {
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare(`SELECT collection_id, server_id, library_id, zotero_collection_key,
					collection_version, path_json, last_synced_at
				FROM zotero_collection_mappings WHERE server_id = ?`)
					.all(serverId) as unknown as Array<Record<string, string | number>>
			).map((row) => ({
				collectionId: String(row.collection_id),
				serverId: String(row.server_id),
				libraryId: String(row.library_id),
				collectionKey: String(row.zotero_collection_key),
				collectionVersion: Number(row.collection_version),
				path: JSON.parse(String(row.path_json)) as string[],
				lastSyncedAt: String(row.last_synced_at),
			})),
		);
	}

	async saveZoteroItemMapping(mapping: ZoteroItemMapping): Promise<void> {
		await this.initialize();
		this.write((database) => {
			const paper = database.prepare("SELECT row_id FROM papers WHERE paper_id = ?").get(mapping.paperId) as
				| { row_id: number }
				| undefined;
			if (!paper) throw new Error(`Personal paper not found: ${mapping.paperId}`);
			database
				.prepare(`INSERT INTO zotero_item_mappings( paper_row_id, server_id, library_id, zotero_item_key,
					item_version, last_direction, last_synced_at
				) VALUES ( ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(paper_row_id, server_id, library_id) DO UPDATE SET
					zotero_item_key=excluded.zotero_item_key, item_version=excluded.item_version,
					last_direction=excluded.last_direction, last_synced_at=excluded.last_synced_at`)
				.run(
					paper.row_id,
					mapping.serverId,
					mapping.libraryId,
					mapping.itemKey,
					mapping.itemVersion,
					mapping.lastDirection,
					mapping.lastSyncedAt,
				);
		});
	}

	async saveZoteroCollectionMapping(mapping: ZoteroCollectionMapping): Promise<void> {
		await this.initialize();
		this.write((database) => {
			database
				.prepare(`INSERT INTO zotero_collection_mappings( collection_id, server_id, library_id, zotero_collection_key,
					collection_version, path_json, last_synced_at
				) VALUES ( ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(collection_id, server_id, library_id) DO UPDATE SET
					zotero_collection_key=excluded.zotero_collection_key,
					collection_version=excluded.collection_version,
					path_json=excluded.path_json, last_synced_at=excluded.last_synced_at`)
				.run(
					mapping.collectionId,
					mapping.serverId,
					mapping.libraryId,
					mapping.collectionKey,
					mapping.collectionVersion,
					JSON.stringify(mapping.path),
					mapping.lastSyncedAt,
				);
		});
	}
	async manifest(): Promise<CorpusManifest> {
		await this.initialize();
		return this.read((database) => {
			const count = (table: string, currentOnly = "") =>
				Number(
					(database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${currentOnly}`).get() as { count: number })
						.count,
				);
			return {
				schemaVersion: 1,
				scope: "personal",

				updatedAt: new Date().toISOString(),
				recordCount: count("papers"),
				searchRunCount: count("search_runs"),
				derivedRecordCount: count("derived_records", "WHERE is_current = 1"),
			};
		});
	}

	async backupTo(destinationRoot: string): Promise<string> {
		await this.initialize();
		const timestamp = new Date()
			.toISOString()
			.replace(/[^0-9]/g, "")
			.slice(0, 14);
		const destination = join(resolve(destinationRoot), `personal-${timestamp}-${randomUUID().slice(0, 8)}`);
		await mkdir(destination, { recursive: true });
		const database = this.open();
		try {
			await backupDatabase(database, join(destination, "personal.sqlite"));
		} finally {
			database.close();
		}
		const personalFilesRoot = dirname(this.filesRoot);
		if (await pathExists(personalFilesRoot))
			await cp(personalFilesRoot, join(destination, "files", "personal"), { recursive: true });
		return destination;
	}

	async recordExport(format: string, filename: string, path: string, paperCount: number): Promise<void> {
		await this.initialize();
		this.write((database) => {
			database
				.prepare(
					"INSERT INTO export_runs(id, format, filename, relative_path, paper_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					`export-${randomUUID()}`,

					format,
					filename,
					relative(this.dataRoot, path),
					paperCount,
					new Date().toISOString(),
				);
		});
	}
}
