import type { DatabaseSync } from "node:sqlite";

export function ensureQuickNotesSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS quick_notes (
			id TEXT PRIMARY KEY,
			client_request_id TEXT NOT NULL UNIQUE,
			request_hash TEXT NOT NULL,
			content TEXT NOT NULL CHECK(length(trim(content)) > 0),
			paper_row_id INTEGER REFERENCES papers(row_id) ON DELETE SET NULL,
			source_paper_id TEXT NOT NULL,
			source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json)),
			locator_json TEXT CHECK(locator_json IS NULL OR json_valid(locator_json)),
			revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS quick_notes_created ON quick_notes(created_at DESC, id DESC);
		CREATE INDEX IF NOT EXISTS quick_notes_paper ON quick_notes(paper_row_id);
		CREATE INDEX IF NOT EXISTS quick_notes_source ON quick_notes(source_paper_id);
	`);
}
