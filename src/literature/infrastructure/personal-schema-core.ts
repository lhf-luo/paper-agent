import type { DatabaseSync } from "node:sqlite";

export function ensurePersonalCoreSchema(database: DatabaseSync): void {
	database.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 15000;
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			checksum TEXT NOT NULL,
			applied_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS namespaces (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS papers (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			paper_id TEXT NOT NULL,
			title TEXT NOT NULL,
			normalized_title TEXT NOT NULL,
			abstract TEXT,
			year INTEGER,
			venue TEXT,
			venue_rank TEXT,
			publication_type TEXT,
			citation_count INTEGER,
			cited_by_api_url TEXT,
			doi TEXT,
			arxiv_id TEXT,
			openalex_id TEXT,
			semantic_scholar_id TEXT,
			dblp_key TEXT,
			core_id TEXT,
			opencitations_id TEXT,
			record_json TEXT NOT NULL CHECK(json_valid(record_json)),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(namespace_id, paper_id)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS papers_namespace_doi ON papers(namespace_id, doi) WHERE doi IS NOT NULL;
		CREATE UNIQUE INDEX IF NOT EXISTS papers_namespace_arxiv ON papers(namespace_id, arxiv_id) WHERE arxiv_id IS NOT NULL;
		CREATE INDEX IF NOT EXISTS papers_namespace_year ON papers(namespace_id, year);
		CREATE TABLE IF NOT EXISTS paper_authors (
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			name TEXT NOT NULL,
			normalized_name TEXT NOT NULL,
			PRIMARY KEY(paper_row_id, position)
		);
		CREATE INDEX IF NOT EXISTS paper_authors_name ON paper_authors(normalized_name);
		CREATE TABLE IF NOT EXISTS paper_links (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			url TEXT NOT NULL,
			kind TEXT NOT NULL,
			open_access INTEGER,
			created_at TEXT NOT NULL,
			UNIQUE(paper_row_id, url)
		);
		CREATE TABLE IF NOT EXISTS paper_provenance (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			provider TEXT NOT NULL,
			query TEXT NOT NULL,
			retrieved_at TEXT NOT NULL,
			provider_record_id TEXT,
			raw_url TEXT
		);
		CREATE TABLE IF NOT EXISTS paper_discovery_paths (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			query TEXT,
			provider TEXT,
			seed_paper_id TEXT,
			source_url TEXT,
			note TEXT,
			discovered_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS paper_references (
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			referenced_work_id TEXT NOT NULL,
			PRIMARY KEY(paper_row_id, position)
		);
		CREATE TABLE IF NOT EXISTS paper_merges (
			canonical_paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			merged_from_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			merged_at TEXT NOT NULL,
			PRIMARY KEY(canonical_paper_row_id, merged_from_id)
		);
		CREATE TABLE IF NOT EXISTS collections (
			id TEXT PRIMARY KEY,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS collections_sibling_name
			ON collections(namespace_id, COALESCE(parent_id, ''), name);
		CREATE TABLE IF NOT EXISTS paper_collections (
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			added_at TEXT NOT NULL,
			PRIMARY KEY(paper_row_id, collection_id)
		);
		CREATE TABLE IF NOT EXISTS paper_tags (
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			tag TEXT NOT NULL,
			normalized_tag TEXT NOT NULL,
			PRIMARY KEY(paper_row_id, normalized_tag)
		);
		CREATE TABLE IF NOT EXISTS paper_notes (
			id TEXT PRIMARY KEY,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			author TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS paper_curation (
			paper_row_id INTEGER PRIMARY KEY REFERENCES papers(row_id) ON DELETE CASCADE,
			screening_status TEXT,
			screening_reason TEXT,
			screening_updated_by TEXT,
			screening_updated_at TEXT,
			reading_status TEXT,
			reading_note TEXT,
			reading_updated_by TEXT,
			reading_updated_at TEXT,
			team_review_status TEXT,
			proposed_by TEXT,
			proposed_at TEXT,
			reviewed_by TEXT,
			reviewed_at TEXT,
			review_reason TEXT
		);
		CREATE TABLE IF NOT EXISTS stored_files (
			id TEXT PRIMARY KEY,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			relative_path TEXT NOT NULL UNIQUE,
			filename TEXT NOT NULL,
			original_filename TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			content_type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			verified_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS stored_files_sha256 ON stored_files(sha256);
		CREATE TABLE IF NOT EXISTS paper_versions (
			id TEXT PRIMARY KEY,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			file_id TEXT NOT NULL UNIQUE REFERENCES stored_files(id) ON DELETE CASCADE,
			source_url TEXT NOT NULL,
			final_url TEXT NOT NULL,
			retrieved_at TEXT NOT NULL,
			version_kind TEXT,
			version_label TEXT,
			related_version_id TEXT REFERENCES paper_versions(id) ON DELETE SET NULL,
			is_preferred INTEGER NOT NULL DEFAULT 0,
			version_json TEXT NOT NULL CHECK(json_valid(version_json)),
			UNIQUE(paper_row_id, file_id)
		);
		CREATE TABLE IF NOT EXISTS pdf_materials (
			id TEXT PRIMARY KEY,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			paper_row_id INTEGER NOT NULL UNIQUE REFERENCES papers(row_id) ON DELETE CASCADE,
			paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
			source_sha256 TEXT NOT NULL,
			relative_path TEXT NOT NULL UNIQUE,
			engine TEXT NOT NULL CHECK(engine IN ('mineru')),
			model_version TEXT NOT NULL CHECK(model_version IN ('pipeline', 'vlm')),
			package_sha256 TEXT NOT NULL,
			content_sha256 TEXT NOT NULL,
			page_count INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			bytes INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS file_operations (
			id TEXT PRIMARY KEY,
			operation TEXT NOT NULL,
			paper_row_id INTEGER REFERENCES papers(row_id) ON DELETE CASCADE,
			file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
			from_path TEXT,
			to_path TEXT NOT NULL,
			status TEXT NOT NULL,
			error TEXT,
			created_at TEXT NOT NULL,
			completed_at TEXT
		);
		CREATE TABLE IF NOT EXISTS zotero_item_mappings (
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			server_id TEXT NOT NULL,
			library_id TEXT NOT NULL DEFAULT '0',
			zotero_item_key TEXT NOT NULL,
			item_version INTEGER NOT NULL,
			last_direction TEXT NOT NULL,
			last_synced_at TEXT NOT NULL,
			PRIMARY KEY(namespace_id, paper_row_id, server_id, library_id),
			UNIQUE(namespace_id, server_id, library_id, zotero_item_key)
		);
		CREATE TABLE IF NOT EXISTS zotero_collection_mappings (
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			server_id TEXT NOT NULL,
			library_id TEXT NOT NULL DEFAULT '0',
			zotero_collection_key TEXT NOT NULL,
			collection_version INTEGER NOT NULL,
			path_json TEXT NOT NULL CHECK(json_valid(path_json)),
			last_synced_at TEXT NOT NULL,
			PRIMARY KEY(namespace_id, collection_id, server_id, library_id),
			UNIQUE(namespace_id, server_id, library_id, zotero_collection_key)
		);
		CREATE TABLE IF NOT EXISTS paper_agent_sessions (
			id TEXT PRIMARY KEY,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			paper_row_id INTEGER NOT NULL REFERENCES papers(row_id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			mode TEXT NOT NULL CHECK(mode IN ('once', 'persistent')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_opened_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS paper_agent_sessions_paper_updated
			ON paper_agent_sessions(namespace_id, paper_row_id, updated_at DESC);
		CREATE TABLE IF NOT EXISTS paper_agent_messages (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES paper_agent_sessions(id) ON DELETE CASCADE,
			message_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
			content TEXT NOT NULL,
			thinking TEXT,
			status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'error', 'aborted')),
			error TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(session_id, message_id),
			UNIQUE(session_id, position)
		);
		CREATE TABLE IF NOT EXISTS paper_agent_tool_calls (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES paper_agent_sessions(id) ON DELETE CASCADE,
			tool_call_id TEXT NOT NULL,
			assistant_message_id TEXT,
			position INTEGER NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
			input TEXT,
			output TEXT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			UNIQUE(session_id, tool_call_id),
			FOREIGN KEY(session_id, assistant_message_id)
				REFERENCES paper_agent_messages(session_id, message_id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS paper_agent_session_cleanup (
			session_id TEXT PRIMARY KEY,
			requested_at TEXT NOT NULL
		);
		CREATE TRIGGER IF NOT EXISTS paper_agent_sessions_queue_cleanup
			BEFORE DELETE ON paper_agent_sessions
			BEGIN
				INSERT INTO paper_agent_session_cleanup(session_id, requested_at)
				VALUES (OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				ON CONFLICT(session_id) DO UPDATE SET requested_at = excluded.requested_at;
			END;`);
}
