import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeDoi, withCanonicalPaperLinks } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { ensurePersonalActivitySchema } from "./personal-schema-activity.ts";
import { ensurePersonalCoreSchema } from "./personal-schema-core.ts";
import { ensurePersonalResearchSchema } from "./personal-schema-research.ts";

function migrateCanonicalDoiLinks(database: DatabaseSync, appliedAt: string): void {
	const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
	if (applied) return;
	const rows = database
		.prepare("SELECT row_id, doi, record_json FROM papers WHERE doi IS NOT NULL")
		.all() as unknown as Array<{
		row_id: number;
		doi: string;
		record_json: string;
	}>;
	const insertLink = database.prepare(`
		INSERT INTO paper_links(paper_row_id, url, kind, open_access, created_at)
		VALUES (?, ?, 'doi', NULL, ?)
		ON CONFLICT(paper_row_id, url) DO UPDATE SET kind = 'doi'
	`);
	const updateRecord = database.prepare("UPDATE papers SET record_json = ? WHERE row_id = ?");
	database.exec("BEGIN IMMEDIATE");
	try {
		for (const row of rows) {
			const doi = normalizeDoi(row.doi);
			if (!doi) continue;
			const parsed = JSON.parse(row.record_json) as PaperRecord;
			const record = withCanonicalPaperLinks(
				parsed.identifiers.doi ? parsed : { ...parsed, identifiers: { ...parsed.identifiers, doi: row.doi } },
			);
			insertLink.run(row.row_id, `https://doi.org/${doi}`, appliedAt);
			updateRecord.run(JSON.stringify(record), row.row_id);
		}
		database
			.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (3, ?, ?, ?)")
			.run(
				"canonical-doi-links",
				createHash("sha256").update("personal-canonical-doi-links-v3").digest("hex"),
				appliedAt,
			);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function removeStructuredResearchSchema(database: DatabaseSync, appliedAt: string): void {
	const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
	if (applied) return;
	const legacyTable = database
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_records'")
		.get();
	const count = legacyTable
		? (database.prepare("SELECT COUNT(*) AS count FROM research_records").get() as { count: number })
		: undefined;
	if (Number(count?.count ?? 0) > 0) {
		throw new Error(
			"Structured research records still exist; export or remove them before upgrading to research notes",
		);
	}
	database.exec(`
		DROP TABLE IF EXISTS research_sources;
		DROP TABLE IF EXISTS research_evidence_edges;
		DROP TABLE IF EXISTS research_evidence_cards;
		DROP TABLE IF EXISTS research_evidence_graphs;
		DROP TABLE IF EXISTS research_comparison_cells;
		DROP TABLE IF EXISTS research_comparison_dimensions;
		DROP TABLE IF EXISTS research_skim_cards;
		DROP TABLE IF EXISTS research_record_papers;
		DROP TABLE IF EXISTS research_audit_events;
		DROP TABLE IF EXISTS research_legacy_migrations;
		DROP TABLE IF EXISTS research_records;
	`);
	database
		.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (6, ?, ?, ?)")
		.run(
			"markdown-research-notes",
			createHash("sha256").update("personal-markdown-research-notes-v6").digest("hex"),
			appliedAt,
		);
}

function addPublicationVersions(database: DatabaseSync, appliedAt: string): void {
	const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get();
	if (applied) return;
	const columns = database.prepare("PRAGMA table_info(paper_versions)").all() as unknown as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "publication_version_id")) {
		database.exec(
			"ALTER TABLE paper_versions ADD COLUMN publication_version_id TEXT REFERENCES publication_versions(id) ON DELETE SET NULL",
		);
	}
	database
		.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (9, ?, ?, ?)")
		.run(
			"paper-publication-versions",
			createHash("sha256").update("personal-paper-publication-versions-v9").digest("hex"),
			appliedAt,
		);
}

export function ensurePersonalDatabaseSchema(database: DatabaseSync): void {
	ensurePersonalCoreSchema(database);
	ensurePersonalResearchSchema(database);
	ensurePersonalActivitySchema(database);
	const appliedAt = new Date().toISOString();
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (1, ?, ?, ?)")
		.run("initial-personal-corpus", createHash("sha256").update("personal-schema-v1").digest("hex"), appliedAt);
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (2, ?, ?, ?)")
		.run(
			"sqlite-research-workspace",
			createHash("sha256").update("personal-schema-research-v2").digest("hex"),
			appliedAt,
		);
	migrateCanonicalDoiLinks(database, appliedAt);
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (4, ?, ?, ?)")
		.run(
			"zotero-local-api-mappings",
			createHash("sha256").update("personal-zotero-mappings-v4").digest("hex"),
			appliedAt,
		);
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (5, ?, ?, ?)")
		.run(
			"paper-agent-reader-sessions",
			createHash("sha256").update("personal-paper-agent-sessions-v5").digest("hex"),
			appliedAt,
		);
	removeStructuredResearchSchema(database, appliedAt);
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (7, ?, ?, ?)")
		.run(
			"mineru-pdf-materials",
			createHash("sha256").update("personal-mineru-pdf-materials-v7").digest("hex"),
			appliedAt,
		);
	database
		.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (8, ?, ?, ?)")
		.run(
			"research-note-folders",
			createHash("sha256").update("personal-research-note-folders-v8").digest("hex"),
			appliedAt,
		);
	addPublicationVersions(database, appliedAt);
}
