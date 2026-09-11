import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ArtifactManifest,
	DerivedRecord,
	PaperCollection,
	PaperRecord,
	PaperVersion,
	SearchRun,
} from "../domain/literature-types.ts";
import { ensurePersonalDatabaseSchema } from "./personal-database-schema.ts";

import {
	initializationPromises,
	type PaperRow,
	sqlitePathLayout,
} from "./personal-database-support.ts";
export abstract class PersonalDatabaseBase {
	readonly databasePath: string;
	readonly filesRoot: string;
	readonly dataRoot: string;
	readonly legacyRoot: string;
	readonly namespace: string;
	protected initialized = false;
	protected abstract paperRow(database: DatabaseSync, paperId: string): PaperRow | undefined;
	protected abstract syncPaper(database: DatabaseSync, record: PaperRecord, previousId?: string): number;
	protected abstract renamePaperFiles(paperId: string, title: string): Promise<string[]>;
	protected abstract recoverFileOperations(): Promise<void>;
	protected abstract migrateLegacyCorpus(): Promise<void>;
	abstract getPaper(id: string): Promise<PaperRecord | undefined>;
	abstract listPapers(): Promise<PaperRecord[]>;
	abstract listCollections(): Promise<PaperCollection[]>;
	abstract listPaperVersions(paperId: string): Promise<PaperVersion[]>;
	abstract savePaperVersion(version: PaperVersion): Promise<void>;
	abstract saveSearchRun(run: SearchRun, keep?: number): Promise<void>;
	abstract putDerived(record: DerivedRecord, replace?: boolean): Promise<"created" | "replaced" | "unchanged">;
	abstract saveArtifactManifest(manifest: ArtifactManifest, paperId?: string): Promise<string>;
	abstract listArtifactManifests(paperId?: string): Promise<ArtifactManifest[]>;

	constructor(root: string, namespace: string) {
		const layout = sqlitePathLayout(root, namespace);
		this.databasePath = layout.databasePath;
		this.filesRoot = layout.filesRoot;
		this.dataRoot = layout.dataRoot;
		this.legacyRoot = layout.legacyRoot;
		this.namespace = namespace;
	}

	protected open(): DatabaseSync {
		const database = new DatabaseSync(this.databasePath);
		ensurePersonalDatabaseSchema(database);
		return database;
	}

	protected read<T>(operation: (database: DatabaseSync) => T): T {
		const database = this.open();
		try {
			return operation(database);
		} finally {
			database.close();
		}
	}

	protected write<T>(operation: (database: DatabaseSync) => T): T {
		const database = this.open();
		try {
			database.exec("BEGIN IMMEDIATE");
			const result = operation(database);
			database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the primary transaction error.
			}
			throw error;
		} finally {
			database.close();
		}
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		const key = `${this.databasePath}:${this.namespace}`;
		let pending = initializationPromises.get(key);
		if (!pending) {
			pending = this.initializeOnce();
			initializationPromises.set(key, pending);
		}
		try {
			await pending;
			this.initialized = true;
		} catch (error) {
			this.initialized = false;
			initializationPromises.delete(key);
			throw error;
		}
	}

	protected async initializeOnce(): Promise<void> {
		await Promise.all([
			mkdir(dirname(this.databasePath), { recursive: true }),
			mkdir(this.filesRoot, { recursive: true }),
		]);
		this.write((database) => {
			const now = new Date().toISOString();
			database
				.prepare("INSERT OR IGNORE INTO namespaces(id, created_at, updated_at) VALUES (?, ?, ?)")
				.run(this.namespace, now, now);
		});
		this.initialized = true;
		await this.recoverFileOperations();
		await this.migrateLegacyCorpus();
	}
}
