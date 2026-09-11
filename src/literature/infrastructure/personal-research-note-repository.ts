import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type CreateResearchNoteFolderInput,
	type CreateResearchNoteInput,
	type ResearchNote,
	type ResearchNoteFolder,
	type ResearchNotePaper,
	type ResearchNoteSummary,
	type ResearchNoteSyncResult,
	type UpdateResearchNoteFolderInput,
	type UpdateResearchNoteInput,
	uniquePaperIds,
	validateResearchNoteFolderName,
	validateResearchNoteMarkdown,
	validateResearchNoteTitle,
} from "../../research/domain/research-notes.ts";
import { pathExists, safePathSegment } from "./personal-database-support.ts";
import { PersonalPaperRepository } from "./personal-paper-repository.ts";
import { reconcileResearchNoteFiles } from "./research-note-file-reconcile.ts";
import { scanResearchNoteFiles } from "./research-note-file-scan.ts";

interface ResearchNoteRow {
	row_id: number;
	note_id: string;
	title: string;
	relative_path: string;
	template_id: string | null;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
	folder_id: string | null;
}

interface ResearchNoteFolderRow {
	folder_id: string;
	name: string;
	parent_id: string | null;
	relative_path: string;
	created_at: string;
	updated_at: string;
}

function markdownHash(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}

const researchNoteSyncs = new Map<string, Promise<ResearchNoteSyncResult>>();

export abstract class PersonalResearchNoteRepository extends PersonalPaperRepository {
	private noteRow(database: DatabaseSync, noteId: string): ResearchNoteRow | undefined {
		return database
			.prepare(`SELECT row_id, note_id, title, relative_path, template_id, revision,
				content_hash, created_at, updated_at, folder_id
				FROM research_notes WHERE namespace_id = ? AND note_id = ?`)
			.get(this.namespace, noteId) as ResearchNoteRow | undefined;
	}

	private folderRow(database: DatabaseSync, folderId: string): ResearchNoteFolderRow | undefined {
		return database
			.prepare(`SELECT folder_id, name, parent_id, relative_path, created_at, updated_at
				FROM research_note_folders WHERE namespace_id = ? AND folder_id = ?`)
			.get(this.namespace, folderId) as ResearchNoteFolderRow | undefined;
	}

	private folderSummary(row: ResearchNoteFolderRow): ResearchNoteFolder {
		return {
			id: row.folder_id,
			name: row.name,
			...(row.parent_id ? { parentId: row.parent_id } : {}),
			relativePath: row.relative_path,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private folderDisplayPath(database: DatabaseSync, folderId: string): string {
		const names: string[] = [];
		let row = this.folderRow(database, folderId);
		while (row) {
			names.unshift(row.name);
			row = row.parent_id ? this.folderRow(database, row.parent_id) : undefined;
		}
		return names.join(" / ");
	}

	private notePapers(database: DatabaseSync, noteRowId: number): ResearchNotePaper[] {
		return database
			.prepare(`SELECT p.paper_id AS id, p.title
				FROM research_note_papers rnp
				JOIN papers p ON p.row_id = rnp.paper_row_id
				WHERE rnp.note_row_id = ? ORDER BY rnp.position`)
			.all(noteRowId) as unknown as ResearchNotePaper[];
	}

	private summary(database: DatabaseSync, row: ResearchNoteRow): ResearchNoteSummary {
		return {
			id: row.note_id,
			title: row.title,
			relativePath: row.relative_path,
			...(row.template_id ? { templateId: row.template_id } : {}),
			revision: row.revision,
			contentHash: row.content_hash,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			...(row.folder_id
				? {
						folderId: row.folder_id,
						folderPath: this.folderDisplayPath(database, row.folder_id),
					}
				: {}),
			papers: this.notePapers(database, row.row_id),
		};
	}

	private absoluteNotePath(relativePath: string): string {
		const absolute = resolve(this.dataRoot, relativePath);
		const fromRoot = relative(resolve(this.dataRoot), absolute);
		if (
			fromRoot === ".." ||
			fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(fromRoot)
		) {
			throw new Error("Research note path escapes the data root");
		}
		return absolute;
	}

	private notePath(title: string, noteId: string, folderPath?: string): { absolute: string; relative: string } {
		const directory = folderPath ? resolve(this.dataRoot, folderPath) : join(this.dataRoot, "notes", this.namespace);
		const safeTitle = safePathSegment(title, "note");
		const suffix = noteId.replace(/[^a-z0-9]/gi, "").slice(-8) || randomUUID().slice(0, 8);
		const absolute = join(directory, `${safeTitle}--${suffix}.md`);
		return { absolute, relative: relative(this.dataRoot, absolute) };
	}

	private requestedFolder(database: DatabaseSync, folderId?: string | null): ResearchNoteFolderRow | undefined {
		if (!folderId) return undefined;
		const folder = this.folderRow(database, folderId);
		if (!folder) throw new Error(`Research note folder is not in namespace ${this.namespace}: ${folderId}`);
		return folder;
	}

	async syncResearchNotes(): Promise<ResearchNoteSyncResult> {
		await this.initialize();
		const key = `${this.databasePath}:${this.namespace}`;
		const existing = researchNoteSyncs.get(key);
		if (existing) return existing;
		const sync = this.performResearchNoteSync();
		researchNoteSyncs.set(key, sync);
		try {
			return await sync;
		} finally {
			if (researchNoteSyncs.get(key) === sync) researchNoteSyncs.delete(key);
		}
	}

	private async performResearchNoteSync(): Promise<ResearchNoteSyncResult> {
		const root = join(this.dataRoot, "notes", this.namespace);
		await mkdir(root, { recursive: true });
		const scan = await scanResearchNoteFiles(this.dataRoot, this.namespace);
		return this.write((database) => reconcileResearchNoteFiles(database, this.namespace, scan));
	}

	async listResearchNoteFolders(): Promise<ResearchNoteFolder[]> {
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare(`SELECT folder_id, name, parent_id, relative_path, created_at, updated_at
						FROM research_note_folders WHERE namespace_id = ? ORDER BY name COLLATE NOCASE`)
					.all(this.namespace) as unknown as ResearchNoteFolderRow[]
			).map((row) => this.folderSummary(row)),
		);
	}

	private replacePaperLinks(database: DatabaseSync, noteRowId: number, paperIds: string[], now: string): void {
		const ids = uniquePaperIds(paperIds);
		const rows = ids.map((paperId) => {
			const row = database
				.prepare("SELECT row_id FROM papers WHERE namespace_id = ? AND paper_id = ?")
				.get(this.namespace, paperId) as { row_id: number } | undefined;
			if (!row) throw new Error(`Research note paper is not in namespace ${this.namespace}: ${paperId}`);
			return row.row_id;
		});
		database.prepare("DELETE FROM research_note_papers WHERE note_row_id = ?").run(noteRowId);
		const insert = database.prepare(
			"INSERT INTO research_note_papers(note_row_id, paper_row_id, position, added_at) VALUES (?, ?, ?, ?)",
		);
		for (const [position, paperRowId] of rows.entries()) insert.run(noteRowId, paperRowId, position, now);
	}

	async listResearchNotes(query?: string, paperId?: string): Promise<ResearchNoteSummary[]> {
		await this.initialize();
		return this.read((database) => {
			const normalizedQuery = query?.trim().toLocaleLowerCase() || null;
			const rows = database
				.prepare(`SELECT DISTINCT rn.row_id, rn.note_id, rn.title, rn.relative_path, rn.template_id,
					rn.revision, rn.content_hash, rn.created_at, rn.updated_at, rn.folder_id
					FROM research_notes rn
					LEFT JOIN research_note_papers rnp ON rnp.note_row_id = rn.row_id
					LEFT JOIN papers p ON p.row_id = rnp.paper_row_id
					WHERE rn.namespace_id = ?
					AND (? IS NULL OR lower(rn.title) LIKE '%' || ? || '%')
					AND (? IS NULL OR p.paper_id = ?)
					ORDER BY rn.updated_at DESC, rn.row_id DESC`)
				.all(
					this.namespace,
					normalizedQuery,
					normalizedQuery,
					paperId ?? null,
					paperId ?? null,
				) as unknown as ResearchNoteRow[];
			return rows.map((row) => this.summary(database, row));
		});
	}

	async getResearchNote(noteId: string): Promise<ResearchNote | undefined> {
		await this.initialize();
		const summary = this.read((database) => {
			const row = this.noteRow(database, noteId);
			return row ? this.summary(database, row) : undefined;
		});
		if (!summary) return undefined;
		let markdown: string;
		try {
			markdown = await readFile(this.absoluteNotePath(summary.relativePath), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Research note file is missing: ${summary.relativePath}`);
			}
			throw error;
		}
		return { ...summary, markdown, contentHash: markdownHash(markdown) };
	}

	async createResearchNote(input: CreateResearchNoteInput & { id?: string }): Promise<ResearchNote> {
		await this.initialize();
		const title = validateResearchNoteTitle(input.title);
		const markdown = validateResearchNoteMarkdown(input.markdown ?? "");
		const noteId = input.id ?? `note-${randomUUID()}`;
		const folder = this.read((database) => this.requestedFolder(database, input.folderId));
		const path = this.notePath(title, noteId, folder?.relative_path);
		await mkdir(dirname(path.absolute), { recursive: true });
		if (await pathExists(path.absolute)) throw new Error(`Research note file already exists: ${path.relative}`);
		const temporary = `${path.absolute}.tmp-${randomUUID()}`;
		await writeFile(temporary, markdown, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path.absolute);
		const now = new Date().toISOString();
		try {
			this.write((database) => {
				database
					.prepare(`INSERT INTO research_notes(
						namespace_id, note_id, title, relative_path, template_id, revision,
						content_hash, created_at, updated_at, folder_id
					) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
					.run(
						this.namespace,
						noteId,
						title,
						path.relative,
						input.templateId ?? null,
						markdownHash(markdown),
						now,
						now,
						folder?.folder_id ?? null,
					);
				const row = this.noteRow(database, noteId);
				if (!row) throw new Error("Research note was not created");
				this.replacePaperLinks(database, row.row_id, input.paperIds ?? [], now);
			});
		} catch (error) {
			await rm(path.absolute, { force: true });
			throw error;
		}
		const created = await this.getResearchNote(noteId);
		if (!created) throw new Error("Research note was not created");
		return created;
	}

	async updateResearchNote(noteId: string, input: UpdateResearchNoteInput): Promise<ResearchNote> {
		const existing = await this.getResearchNote(noteId);
		if (!existing) throw new Error(`Research note not found: ${noteId}`);
		if (existing.revision !== input.expectedRevision || existing.contentHash !== input.expectedContentHash) {
			throw new Error("Research note changed since it was opened");
		}
		const title = validateResearchNoteTitle(input.title);
		const markdown = validateResearchNoteMarkdown(input.markdown);
		const oldPath = this.absoluteNotePath(existing.relativePath);
		const folder = this.read((database) =>
			this.requestedFolder(database, input.folderId === undefined ? existing.folderId : input.folderId),
		);
		const nextPath = this.notePath(title, noteId, folder?.relative_path);
		if (nextPath.absolute !== oldPath && (await pathExists(nextPath.absolute))) {
			throw new Error(`Research note file already exists: ${nextPath.relative}`);
		}
		const temporary = `${nextPath.absolute}.tmp-${randomUUID()}`;
		const backup = `${oldPath}.bak-${randomUUID()}`;
		await mkdir(dirname(nextPath.absolute), { recursive: true });
		await writeFile(temporary, markdown, { encoding: "utf8", flag: "wx" });
		await rename(oldPath, backup);
		let committed = false;
		try {
			await rename(temporary, nextPath.absolute);
			const now = new Date().toISOString();
			this.write((database) => {
				const row = this.noteRow(database, noteId);
				if (!row || row.revision !== input.expectedRevision) throw new Error("Research note revision conflict");
				database
					.prepare(`UPDATE research_notes SET title = ?, relative_path = ?, revision = revision + 1,
						content_hash = ?, updated_at = ?, folder_id = ? WHERE row_id = ?`)
					.run(title, nextPath.relative, markdownHash(markdown), now, folder?.folder_id ?? null, row.row_id);
				if (input.paperIds) this.replacePaperLinks(database, row.row_id, input.paperIds, now);
			});
			committed = true;
		} catch (error) {
			await rm(nextPath.absolute, { force: true });
			await rename(backup, oldPath).catch(() => undefined);
			await rm(temporary, { force: true });
			throw error;
		}
		if (committed) await rm(backup, { force: true }).catch(() => undefined);
		const updated = await this.getResearchNote(noteId);
		if (!updated) throw new Error("Research note disappeared after update");
		return updated;
	}

	async createResearchNoteFolder(input: CreateResearchNoteFolderInput): Promise<ResearchNoteFolder> {
		await this.initialize();
		const name = validateResearchNoteFolderName(input.name);
		const parent = this.read((database) => this.requestedFolder(database, input.parentId));
		const folderId = `note-folder-${randomUUID()}`;
		const relativePath = relative(
			this.dataRoot,
			join(
				parent ? resolve(this.dataRoot, parent.relative_path) : join(this.dataRoot, "notes", this.namespace),
				safePathSegment(name, "folder"),
			),
		);
		const absolutePath = this.absoluteNotePath(relativePath);
		if (await pathExists(absolutePath)) throw new Error(`Research note folder already exists: ${relativePath}`);
		await mkdir(dirname(absolutePath), { recursive: true });
		await mkdir(absolutePath, { recursive: false });
		const now = new Date().toISOString();
		try {
			this.write((database) =>
				database
					.prepare(`INSERT INTO research_note_folders(
						folder_id, namespace_id, name, normalized_name, parent_id, relative_path, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						folderId,
						this.namespace,
						name,
						name.normalize("NFKC").toLocaleLowerCase(),
						parent?.folder_id ?? null,
						relativePath,
						now,
						now,
					),
			);
		} catch (error) {
			await rm(absolutePath, { recursive: true, force: true });
			throw error;
		}
		return this.read((database) => this.folderSummary(this.folderRow(database, folderId)!));
	}

	async updateResearchNoteFolder(folderId: string, input: UpdateResearchNoteFolderInput): Promise<ResearchNoteFolder> {
		await this.initialize();
		const name = validateResearchNoteFolderName(input.name);
		const state = this.read((database) => {
			const folder = this.folderRow(database, folderId);
			if (!folder) throw new Error(`Research note folder not found: ${folderId}`);
			const parent = this.requestedFolder(database, input.parentId);
			let cursor = parent;
			while (cursor) {
				if (cursor.folder_id === folderId)
					throw new Error("Research note folder cannot be moved into itself or a descendant");
				cursor = cursor.parent_id ? this.folderRow(database, cursor.parent_id) : undefined;
			}
			return { folder, parent };
		});
		const nextRelative = relative(
			this.dataRoot,
			join(
				state.parent
					? resolve(this.dataRoot, state.parent.relative_path)
					: join(this.dataRoot, "notes", this.namespace),
				safePathSegment(name, "folder"),
			),
		);
		if (nextRelative === state.folder.relative_path) return this.folderSummary(state.folder);
		const oldAbsolute = this.absoluteNotePath(state.folder.relative_path);
		const nextAbsolute = this.absoluteNotePath(nextRelative);
		if (await pathExists(nextAbsolute)) throw new Error(`Research note folder already exists: ${nextRelative}`);
		await mkdir(dirname(nextAbsolute), { recursive: true });
		await rename(oldAbsolute, nextAbsolute);
		try {
			const now = new Date().toISOString();
			this.write((database) => {
				const folderRows = database
					.prepare("SELECT folder_id, relative_path FROM research_note_folders WHERE namespace_id = ?")
					.all(this.namespace) as unknown as Array<{ folder_id: string; relative_path: string }>;
				for (const row of folderRows) {
					if (
						row.relative_path !== state.folder.relative_path &&
						!row.relative_path.startsWith(`${state.folder.relative_path}${sep}`)
					)
						continue;
					const path = `${nextRelative}${row.relative_path.slice(state.folder.relative_path.length)}`;
					database
						.prepare("UPDATE research_note_folders SET relative_path = ?, updated_at = ? WHERE folder_id = ?")
						.run(path, now, row.folder_id);
				}
				const noteRows = database
					.prepare("SELECT row_id, relative_path FROM research_notes WHERE namespace_id = ?")
					.all(this.namespace) as unknown as Array<{ row_id: number; relative_path: string }>;
				for (const row of noteRows) {
					if (!row.relative_path.startsWith(`${state.folder.relative_path}${sep}`)) continue;
					database
						.prepare("UPDATE research_notes SET relative_path = ? WHERE row_id = ?")
						.run(`${nextRelative}${row.relative_path.slice(state.folder.relative_path.length)}`, row.row_id);
				}
				database
					.prepare(
						"UPDATE research_note_folders SET name = ?, normalized_name = ?, parent_id = ? WHERE folder_id = ?",
					)
					.run(name, name.normalize("NFKC").toLocaleLowerCase(), state.parent?.folder_id ?? null, folderId);
			});
		} catch (error) {
			await rename(nextAbsolute, oldAbsolute).catch(() => undefined);
			throw error;
		}
		return this.read((database) => this.folderSummary(this.folderRow(database, folderId)!));
	}

	async deleteResearchNoteFolder(folderId: string): Promise<ResearchNoteFolder> {
		await this.initialize();
		const folder = this.read((database) => {
			const row = this.folderRow(database, folderId);
			if (!row) throw new Error(`Research note folder not found: ${folderId}`);
			const child = database
				.prepare("SELECT 1 FROM research_note_folders WHERE parent_id = ? LIMIT 1")
				.get(folderId);
			const note = database.prepare("SELECT 1 FROM research_notes WHERE folder_id = ? LIMIT 1").get(folderId);
			if (child || note) throw new Error("Research note folder is not empty");
			return row;
		});
		const path = this.absoluteNotePath(folder.relative_path);
		const staged = `${path}.delete-${randomUUID()}`;
		await rename(path, staged);
		try {
			this.write((database) =>
				database.prepare("DELETE FROM research_note_folders WHERE folder_id = ?").run(folderId),
			);
		} catch (error) {
			await rename(staged, path).catch(() => undefined);
			throw error;
		}
		await rm(staged, { recursive: true, force: true });
		return this.folderSummary(folder);
	}

	async setResearchNotePapers(noteId: string, paperIds: string[], expectedRevision: number): Promise<ResearchNote> {
		await this.initialize();
		this.write((database) => {
			const row = this.noteRow(database, noteId);
			if (!row) throw new Error(`Research note not found: ${noteId}`);
			if (row.revision !== expectedRevision) throw new Error("Research note revision conflict");
			const now = new Date().toISOString();
			this.replacePaperLinks(database, row.row_id, paperIds, now);
			database
				.prepare("UPDATE research_notes SET revision = revision + 1, updated_at = ? WHERE row_id = ?")
				.run(now, row.row_id);
		});
		const updated = await this.getResearchNote(noteId);
		if (!updated) throw new Error("Research note disappeared after updating papers");
		return updated;
	}

	async deleteResearchNote(noteId: string): Promise<ResearchNote | undefined> {
		const existing = await this.getResearchNote(noteId);
		if (!existing) return undefined;
		const path = this.absoluteNotePath(existing.relativePath);
		const staged = `${path}.delete-${randomUUID()}`;
		await rename(path, staged);
		let committed = false;
		try {
			this.write((database) => {
				const row = this.noteRow(database, noteId);
				if (row) database.prepare("DELETE FROM research_notes WHERE row_id = ?").run(row.row_id);
			});
			committed = true;
		} catch (error) {
			await rename(staged, path).catch(() => undefined);
			throw error;
		}
		if (committed) await rm(staged, { force: true }).catch(() => undefined);
		return existing;
	}
}
