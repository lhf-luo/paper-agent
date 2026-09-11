import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ResearchNoteSyncResult, validateResearchNoteTitle } from "../../research/domain/research-notes.ts";
import { safePathSegment } from "./personal-database-support.ts";
import type { DiskResearchNote, ResearchNoteFileScan } from "./research-note-file-scan.ts";

interface NoteRow {
	row_id: number;
	note_id: string;
	title: string;
	relative_path: string;
	content_hash: string;
	folder_id: string | null;
}

interface FolderRow {
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

function pathKey(value: string): string {
	return process.platform === "win32" ? value.toLocaleLowerCase() : value;
}

function noteSuffix(noteId: string): string {
	return noteId
		.replace(/[^a-z0-9]/gi, "")
		.slice(-8)
		.toLocaleLowerCase();
}

function titleFromDiskNote(note: DiskResearchNote, matched?: NoteRow): string {
	if (!matched) return note.filenameTitle;
	const suffix = noteSuffix(matched.note_id);
	const marker = suffix ? new RegExp(`--${suffix}$`, "i") : undefined;
	const filenameTitle = marker?.test(note.filenameTitle) ? note.filenameTitle.replace(marker, "") : note.filenameTitle;
	return filenameTitle === safePathSegment(matched.title, "note") ? matched.title : filenameTitle;
}

function reconcileFolders(
	database: DatabaseSync,
	namespace: string,
	scan: ResearchNoteFileScan,
	result: ResearchNoteSyncResult,
	now: string,
): { folders: FolderRow[]; folderByPath: Map<string, FolderRow>; diskFolderKeys: Set<string> } {
	const folders = database
		.prepare(`SELECT folder_id, name, parent_id, relative_path, created_at, updated_at
			FROM research_note_folders WHERE namespace_id = ?`)
		.all(namespace) as unknown as FolderRow[];
	const folderByPath = new Map(folders.map((folder) => [pathKey(folder.relative_path), folder]));
	const diskFolderKeys = new Set(scan.folderRelativePaths.map(pathKey));
	const orderedPaths = [...scan.folderRelativePaths].sort(
		(left, right) => left.split(/[\\/]/).length - right.split(/[\\/]/).length,
	);
	for (const relativePath of orderedPaths) {
		const key = pathKey(relativePath);
		const parent = folderByPath.get(pathKey(dirname(relativePath)));
		const name = relativePath.slice(Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\")) + 1);
		const existing = folderByPath.get(key);
		if (existing) {
			if (
				existing.name !== name ||
				existing.parent_id !== (parent?.folder_id ?? null) ||
				existing.relative_path !== relativePath
			) {
				database
					.prepare(`UPDATE research_note_folders SET name = ?, normalized_name = ?, parent_id = ?,
						relative_path = ?, updated_at = ? WHERE folder_id = ?`)
					.run(
						name,
						name.normalize("NFKC").toLocaleLowerCase(),
						parent?.folder_id ?? null,
						relativePath,
						now,
						existing.folder_id,
					);
				existing.name = name;
				existing.parent_id = parent?.folder_id ?? null;
				existing.relative_path = relativePath;
				existing.updated_at = now;
			}
			continue;
		}
		const folder: FolderRow = {
			folder_id: `note-folder-${randomUUID()}`,
			name,
			parent_id: parent?.folder_id ?? null,
			relative_path: relativePath,
			created_at: now,
			updated_at: now,
		};
		database
			.prepare(`INSERT INTO research_note_folders(
				folder_id, namespace_id, name, normalized_name, parent_id, relative_path, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				folder.folder_id,
				namespace,
				folder.name,
				folder.name.normalize("NFKC").toLocaleLowerCase(),
				folder.parent_id,
				folder.relative_path,
				folder.created_at,
				folder.updated_at,
			);
		folderByPath.set(key, folder);
		result.createdFolders += 1;
	}
	return { folders, folderByPath, diskFolderKeys };
}

function noteIndexes(rows: NoteRow[]) {
	const rowsBySuffix = new Map<string, NoteRow[]>();
	const rowsByHash = new Map<string, NoteRow[]>();
	for (const row of rows) {
		const suffix = noteSuffix(row.note_id);
		if (suffix) rowsBySuffix.set(suffix, [...(rowsBySuffix.get(suffix) ?? []), row]);
		rowsByHash.set(row.content_hash, [...(rowsByHash.get(row.content_hash) ?? []), row]);
	}
	return { rowsBySuffix, rowsByHash };
}

export function reconcileResearchNoteFiles(
	database: DatabaseSync,
	namespace: string,
	scan: ResearchNoteFileScan,
): ResearchNoteSyncResult {
	const result: ResearchNoteSyncResult = {
		createdNotes: 0,
		updatedNotes: 0,
		deletedNotes: 0,
		createdFolders: 0,
		deletedFolders: 0,
		warnings: [...scan.warnings],
	};
	const now = new Date().toISOString();
	const { folders, folderByPath, diskFolderKeys } = reconcileFolders(database, namespace, scan, result, now);
	const rows = database
		.prepare(`SELECT row_id, note_id, title, relative_path, content_hash, folder_id
			FROM research_notes WHERE namespace_id = ?`)
		.all(namespace) as unknown as NoteRow[];
	const unmatchedRows = new Set(rows);
	const rowsByPath = new Map(rows.map((row) => [pathKey(row.relative_path), row]));
	const { rowsBySuffix, rowsByHash } = noteIndexes(rows);
	const diskHashCounts = new Map<string, number>();
	for (const note of scan.notes) {
		const hash = markdownHash(note.markdown);
		diskHashCounts.set(hash, (diskHashCounts.get(hash) ?? 0) + 1);
	}

	for (const note of scan.notes) {
		const hash = markdownHash(note.markdown);
		const suffixMatch = /--([a-z0-9]{8})$/i.exec(note.filenameTitle)?.[1]?.toLocaleLowerCase();
		let row = rowsByPath.get(pathKey(note.relativePath));
		if (!row && suffixMatch) {
			const candidates = (rowsBySuffix.get(suffixMatch) ?? []).filter((candidate) => unmatchedRows.has(candidate));
			if (candidates.length === 1) [row] = candidates;
		}
		if (!row && diskHashCounts.get(hash) === 1) {
			const candidates = (rowsByHash.get(hash) ?? []).filter((candidate) => unmatchedRows.has(candidate));
			if (candidates.length === 1) [row] = candidates;
		}
		const folder = note.folderRelativePath ? folderByPath.get(pathKey(note.folderRelativePath)) : undefined;
		let title = titleFromDiskNote(note, row);
		try {
			title = validateResearchNoteTitle(title);
		} catch (error) {
			result.warnings.push(error instanceof Error ? `${note.relativePath}: ${error.message}` : String(error));
			if (!row) continue;
			title = row.title;
		}
		if (!row) {
			database
				.prepare(`INSERT INTO research_notes(
					namespace_id, note_id, title, relative_path, template_id, revision,
					content_hash, created_at, updated_at, folder_id
				) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`)
				.run(
					namespace,
					`note-${randomUUID()}`,
					title,
					note.relativePath,
					hash,
					note.modifiedAt,
					note.modifiedAt,
					folder?.folder_id ?? null,
				);
			result.createdNotes += 1;
			continue;
		}
		unmatchedRows.delete(row);
		const changed =
			row.title !== title ||
			pathKey(row.relative_path) !== pathKey(note.relativePath) ||
			row.content_hash !== hash ||
			row.folder_id !== (folder?.folder_id ?? null);
		if (!changed) continue;
		database
			.prepare(`UPDATE research_notes SET title = ?, relative_path = ?, folder_id = ?,
				content_hash = ?, revision = revision + 1, updated_at = ? WHERE row_id = ?`)
			.run(title, note.relativePath, folder?.folder_id ?? null, hash, now, row.row_id);
		result.updatedNotes += 1;
	}

	for (const row of unmatchedRows) {
		database.prepare("DELETE FROM research_notes WHERE row_id = ?").run(row.row_id);
		result.deletedNotes += 1;
	}
	for (const folder of [...folders].sort(
		(left, right) => right.relative_path.split(/[\\/]/).length - left.relative_path.split(/[\\/]/).length,
	)) {
		if (diskFolderKeys.has(pathKey(folder.relative_path))) continue;
		database.prepare("DELETE FROM research_note_folders WHERE folder_id = ?").run(folder.folder_id);
		result.deletedFolders += 1;
	}
	return result;
}
