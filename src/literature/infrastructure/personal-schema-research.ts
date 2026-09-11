import type { DatabaseSync } from "node:sqlite";

export function ensurePersonalResearchSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS research_note_folders (
			folder_id TEXT PRIMARY KEY,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			normalized_name TEXT NOT NULL,
			parent_id TEXT REFERENCES research_note_folders(folder_id) ON DELETE RESTRICT,
			relative_path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS research_note_folders_sibling_name
			ON research_note_folders(namespace_id, ifnull(parent_id, ''), normalized_name);
		CREATE TABLE IF NOT EXISTS research_notes (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			note_id TEXT NOT NULL,
			title TEXT NOT NULL,
			relative_path TEXT NOT NULL UNIQUE,
			template_id TEXT,
			revision INTEGER NOT NULL CHECK(revision >= 1),
			content_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(namespace_id, note_id)
		);
		CREATE INDEX IF NOT EXISTS research_notes_namespace_updated
			ON research_notes(namespace_id, updated_at DESC);
		CREATE TABLE IF NOT EXISTS research_note_papers (
			note_row_id INTEGER NOT NULL REFERENCES research_notes(row_id) ON DELETE CASCADE,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			position INTEGER NOT NULL CHECK(position >= 0),
			added_at TEXT NOT NULL,
			PRIMARY KEY(note_row_id, paper_row_id),
			UNIQUE(note_row_id, position)
		);
		CREATE INDEX IF NOT EXISTS research_note_papers_paper
			ON research_note_papers(paper_row_id);
	`);
	const columns = database.prepare("PRAGMA table_info(research_notes)").all() as unknown as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "folder_id")) {
		database.exec(
			"ALTER TABLE research_notes ADD COLUMN folder_id TEXT REFERENCES research_note_folders(folder_id) ON DELETE RESTRICT",
		);
	}
	database.exec("CREATE INDEX IF NOT EXISTS research_notes_folder ON research_notes(folder_id)");
}
