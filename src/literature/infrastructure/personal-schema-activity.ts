import type { DatabaseSync } from "node:sqlite";

export function ensurePersonalActivitySchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS search_runs (
			id TEXT NOT NULL,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			started_at TEXT NOT NULL,
			completed_at TEXT NOT NULL,
			filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
			pages_per_provider INTEGER NOT NULL,
			max_results_per_provider INTEGER NOT NULL,
			deduplicated_count INTEGER NOT NULL,
			corpus_hit_count INTEGER,
			scope TEXT NOT NULL,
			mode TEXT NOT NULL,
			resumed_from_checkpoint INTEGER NOT NULL DEFAULT 0,
			search_plan_json TEXT CHECK(search_plan_json IS NULL OR json_valid(search_plan_json)),
			candidate_table_json TEXT CHECK(candidate_table_json IS NULL OR json_valid(candidate_table_json)),
			run_json TEXT NOT NULL CHECK(json_valid(run_json)),
			PRIMARY KEY(namespace_id, id)
		);
		CREATE TABLE IF NOT EXISTS search_run_queries (
			namespace_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			query TEXT NOT NULL,
			PRIMARY KEY(namespace_id, run_id, position),
			FOREIGN KEY(namespace_id, run_id) REFERENCES search_runs(namespace_id, id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS search_run_providers (
			namespace_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			position INTEGER NOT NULL,
			source_count INTEGER,
			health_status TEXT,
			record_count INTEGER,
			failure_count INTEGER,
			checked_at TEXT,
			message TEXT,
			retry_after TEXT,
			PRIMARY KEY(namespace_id, run_id, provider),
			FOREIGN KEY(namespace_id, run_id) REFERENCES search_runs(namespace_id, id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS search_run_results (
			namespace_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			paper_id TEXT NOT NULL,
			record_json TEXT NOT NULL CHECK(json_valid(record_json)),
			PRIMARY KEY(namespace_id, run_id, position),
			FOREIGN KEY(namespace_id, run_id) REFERENCES search_runs(namespace_id, id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS search_failures (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			namespace_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			query TEXT NOT NULL,
			message TEXT NOT NULL,
			retryable INTEGER NOT NULL,
			status_code INTEGER,
			rate_limited INTEGER,
			retry_after TEXT,
			FOREIGN KEY(namespace_id, run_id) REFERENCES search_runs(namespace_id, id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS possible_duplicates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			namespace_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			left_paper_id TEXT NOT NULL,
			right_paper_id TEXT NOT NULL,
			title_similarity REAL NOT NULL,
			reason TEXT NOT NULL,
			FOREIGN KEY(namespace_id, run_id) REFERENCES search_runs(namespace_id, id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS derived_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			task_key TEXT NOT NULL,
			revision INTEGER NOT NULL,
			paper_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			input_hashes_json TEXT NOT NULL CHECK(json_valid(input_hashes_json)),
			pipeline_version TEXT NOT NULL,
			model_version TEXT,
			prompt_version TEXT,
			config_json TEXT NOT NULL CHECK(json_valid(config_json)),
			result_json TEXT NOT NULL CHECK(json_valid(result_json)),
			record_json TEXT NOT NULL CHECK(json_valid(record_json)),
			created_by TEXT,
			created_at TEXT NOT NULL,
			is_current INTEGER NOT NULL,
			UNIQUE(namespace_id, task_key, revision)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS derived_current_key
			ON derived_records(namespace_id, task_key) WHERE is_current = 1;
		CREATE TABLE IF NOT EXISTS import_runs (
			id TEXT NOT NULL,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			input_path TEXT,
			status TEXT NOT NULL,
			target_collection_id TEXT,
			started_at TEXT,
			completed_at TEXT,
			parsed_count INTEGER,
			imported_count INTEGER,
			needs_metadata_count INTEGER,
			rejected_count INTEGER,
			report_json TEXT NOT NULL CHECK(json_valid(report_json)),
			error TEXT,
			PRIMARY KEY(namespace_id, id)
		);
		CREATE TABLE IF NOT EXISTS export_runs (
			id TEXT NOT NULL,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			format TEXT NOT NULL,
			filename TEXT NOT NULL,
			relative_path TEXT NOT NULL,
			paper_count INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY(namespace_id, id)
		);
		CREATE TABLE IF NOT EXISTS artifact_manifests (
			id TEXT NOT NULL,
			namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
			paper_id TEXT,
			pdf_sha256 TEXT,
			manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
			discovered_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(namespace_id, id)
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS paper_search USING fts5(
			paper_row_id UNINDEXED,
			namespace_id UNINDEXED,
			title,
			authors,
			venue,
			abstract,
			tags,
			identifiers,
			user_notes,
			publication_type,
			tokenize='unicode61 remove_diacritics 2'
		);
		CREATE TABLE IF NOT EXISTS legacy_migrations (
			namespace_id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			backup_path TEXT,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);
	`);
}
