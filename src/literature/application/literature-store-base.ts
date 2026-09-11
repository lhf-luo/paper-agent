import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PdfMaterialRecord, SavePdfMaterialInput } from "../../pdf/domain/pdf-material-types.ts";
import type {
	CreateResearchNoteFolderInput,
	CreateResearchNoteInput,
	ResearchNote,
	ResearchNoteFolder,
	ResearchNoteSummary,
	ResearchNoteSyncResult,
	UpdateResearchNoteFolderInput,
	UpdateResearchNoteInput,
} from "../../research/domain/research-notes.ts";
import type {
	CorpusManifest,
	CorpusScope,
	PaperCollection,
	PaperRecord,
	PaperVersion,
	SearchRun,
} from "../domain/literature-types.ts";
import { LiteratureSearchIndex } from "../infrastructure/literature-search-index.ts";
import { PersonalCorpusDatabase } from "../infrastructure/personal-corpus-database.ts";

import { pathExists, readJson, safeSegment } from "./literature-store-support.ts";
export abstract class LiteratureStoreBase {
	readonly root: string;
	readonly scope: CorpusScope;
	readonly namespace: string;
	protected readonly searchIndex: LiteratureSearchIndex;
	protected readonly personalDatabase?: PersonalCorpusDatabase;
	protected initialized = false;
	abstract listPapers(): Promise<PaperRecord[]>;
	abstract listCollections(): Promise<PaperCollection[]>;
	abstract putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }>;
	abstract listPaperVersions(paperId: string): Promise<PaperVersion[]>;
	protected abstract refreshManifestUnlocked(): Promise<CorpusManifest>;

	constructor(root: string, scope: CorpusScope, namespace: string) {
		this.root = resolve(root);
		this.scope = scope;
		this.namespace = safeSegment(namespace, "namespace");
		this.searchIndex = new LiteratureSearchIndex(join(this.root, "index", "literature.sqlite"));
		this.personalDatabase = scope === "personal" ? new PersonalCorpusDatabase(this.root, this.namespace) : undefined;
	}

	get databasePath(): string {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.databasePath;
	}

	get personalFilesRoot(): string {
		if (!this.personalDatabase) throw new Error("Personal files require a personal SQLite corpus");
		return this.personalDatabase.filesRoot;
	}

	get personalDataRoot(): string {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.dataRoot;
	}

	async getPdfMaterial(paperId: string): Promise<PdfMaterialRecord | undefined> {
		if (!this.personalDatabase) throw new Error("PDF materials require a personal SQLite corpus");
		return this.personalDatabase.getPdfMaterial(paperId);
	}

	async savePdfMaterial(input: SavePdfMaterialInput): Promise<PdfMaterialRecord> {
		if (!this.personalDatabase) throw new Error("PDF materials require a personal SQLite corpus");
		return this.personalDatabase.savePdfMaterial(input);
	}

	async deletePdfMaterial(paperId: string): Promise<PdfMaterialRecord | undefined> {
		if (!this.personalDatabase) throw new Error("PDF materials require a personal SQLite corpus");
		return this.personalDatabase.deletePdfMaterial(paperId);
	}

	async listResearchNotes(query?: string, paperId?: string): Promise<ResearchNoteSummary[]> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.listResearchNotes(query, paperId);
	}

	async syncResearchNotes(): Promise<ResearchNoteSyncResult> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.syncResearchNotes();
	}

	async listResearchNoteFolders(): Promise<ResearchNoteFolder[]> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.listResearchNoteFolders();
	}

	async createResearchNoteFolder(input: CreateResearchNoteFolderInput): Promise<ResearchNoteFolder> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.createResearchNoteFolder(input);
	}

	async updateResearchNoteFolder(id: string, input: UpdateResearchNoteFolderInput): Promise<ResearchNoteFolder> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.updateResearchNoteFolder(id, input);
	}

	async deleteResearchNoteFolder(id: string): Promise<ResearchNoteFolder> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.deleteResearchNoteFolder(id);
	}

	async getResearchNote(id: string): Promise<ResearchNote | undefined> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.getResearchNote(id);
	}

	async createResearchNote(input: CreateResearchNoteInput & { id?: string }): Promise<ResearchNote> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.createResearchNote(input);
	}

	async updateResearchNote(id: string, input: UpdateResearchNoteInput): Promise<ResearchNote> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.updateResearchNote(id, input);
	}

	async setResearchNotePapers(id: string, paperIds: string[], expectedRevision: number): Promise<ResearchNote> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.setResearchNotePapers(id, paperIds, expectedRevision);
	}

	async deleteResearchNote(id: string): Promise<ResearchNote | undefined> {
		if (!this.personalDatabase) throw new Error("Research workspace requires a personal SQLite corpus");
		return this.personalDatabase.deleteResearchNote(id);
	}

	protected async recordsSignature(): Promise<string> {
		const directory = join(this.root, "records");
		try {
			const [directoryStat, names] = await Promise.all([stat(directory), readdir(directory)]);
			return `${names.filter((name) => name.endsWith(".json")).length}:${Math.trunc(directoryStat.mtimeMs)}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0:0";
			throw error;
		}
	}

	protected async markSearchIndexCurrent(): Promise<void> {
		await this.searchIndex.setRecordsSignature(await this.recordsSignature());
	}

	protected recordPath(id: string): string {
		return join(this.root, "records", `${safeSegment(id, "paper id")}.json`);
	}

	protected searchRunPath(id: string): string {
		return join(this.root, "search-runs", `${safeSegment(id, "search run id")}.json`);
	}

	async getSearchRun(id: string): Promise<SearchRun | undefined> {
		if (this.personalDatabase) return this.personalDatabase.getSearchRun(id);
		return readJson<SearchRun>(this.searchRunPath(id));
	}

	async listSearchRuns(): Promise<SearchRun[]> {
		if (this.personalDatabase) return this.personalDatabase.listSearchRuns();
		const directory = join(this.root, "search-runs");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const runs = await Promise.all(names.map((name) => readJson<SearchRun>(join(directory, name))));
		return runs
			.filter((run): run is SearchRun => Boolean(run))
			.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
	}

	protected derivedPath(key: string): string {
		return join(this.root, "derived", `${safeSegment(key, "derived key")}.json`);
	}

	protected collectionPath(id: string): string {
		return join(this.root, "collections", `${safeSegment(id, "collection id")}.json`);
	}

	protected async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true });
		const lockPath = join(this.root, ".write.lock");
		const deadline = Date.now() + 15_000;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			let candidate: Awaited<ReturnType<typeof open>> | undefined;
			try {
				candidate = await open(lockPath, "wx");
				await candidate.writeFile(
					JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), namespace: this.namespace }) +
						"\n",
					"utf8",
				);
				handle = candidate;
			} catch (error) {
				if (candidate) {
					try {
						await candidate.close();
					} catch {
						// Preserve the acquisition error.
					}
					try {
						await unlink(lockPath);
					} catch {
						// Stale-lock recovery handles a leftover file.
					}
					throw error;
				}
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
				try {
					const lockStat = await stat(lockPath);
					if (Date.now() - lockStat.mtimeMs > 120_000) {
						await unlink(lockPath);
						continue;
					}
				} catch (lockError) {
					if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
						if (code === "EEXIST") continue;
						throw error;
					}
					throw lockError;
				}
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for the corpus write lock: ${lockPath}`);
				}
				await delay(50);
			}
		}
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			try {
				await handle.close();
			} catch {
				// Preserve the operation error.
			}
			try {
				await unlink(lockPath);
			} catch {
				// A stale lock is recovered by age on the next writer; do not mask the primary operation result.
			}
			throw error;
		}
		try {
			await handle.close();
		} catch (error) {
			try {
				await unlink(lockPath);
			} catch {
				// Preserve the close error.
			}
			throw error;
		}
		try {
			await unlink(lockPath);
		} catch {
			// A stale lock is recovered by age on the next writer.
		}
		return result;
	}
}
