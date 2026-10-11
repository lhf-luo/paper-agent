import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeDoi, withCanonicalPaperLinks } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import {
	isCurrentPaperDetailFields,
	PAPER_DETAIL_FIELDS_SCHEMA_VERSION,
	resetPaperDetailFields,
} from "../domain/paper-detail-fields.ts";
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

function resetResearchFieldCards(database: DatabaseSync, appliedAt: string): void {
	if (database.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get()) return;
	const rows = database.prepare("SELECT row_id, record_json FROM papers").all() as unknown as Array<{
		row_id: number;
		record_json: string;
	}>;
	const update = database.prepare("UPDATE papers SET record_json = ?, updated_at = ? WHERE row_id = ?");
	database.exec("BEGIN IMMEDIATE");
	try {
		for (const row of rows) {
			const record = JSON.parse(row.record_json) as PaperRecord;
			const curation = record.curation ?? { tags: [], userNotes: [] };
			const revised: PaperRecord = {
				...record,
				curation: {
					...curation,
					detailFields: resetPaperDetailFields(curation.detailFields, appliedAt),
				},
			};
			update.run(JSON.stringify(revised), appliedAt, row.row_id);
		}
		database
			.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (10, ?, ?, ?)")
			.run(
				"reset-research-field-cards",
				createHash("sha256").update("personal-research-field-cards-v10").digest("hex"),
				appliedAt,
			);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function repairLegacyResearchFieldCards(database: DatabaseSync, appliedAt: string): void {
	if (database.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get()) return;
	const rows = database.prepare("SELECT row_id, record_json FROM papers").all() as unknown as Array<{
		row_id: number;
		record_json: string;
	}>;
	const update = database.prepare("UPDATE papers SET record_json = ?, updated_at = ? WHERE row_id = ?");
	database.exec("BEGIN IMMEDIATE");
	try {
		for (const row of rows) {
			const record = JSON.parse(row.record_json) as PaperRecord;
			const fields = record.curation?.detailFields;
			if (!fields || isCurrentPaperDetailFields(fields)) continue;
			const revised: PaperRecord = {
				...record,
				curation: {
					...record.curation!,
					detailFields: resetPaperDetailFields(fields, appliedAt),
				},
			};
			update.run(JSON.stringify(revised), appliedAt, row.row_id);
		}
		database
			.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (11, ?, ?, ?)")
			.run(
				"repair-legacy-research-field-cards",
				createHash("sha256").update("personal-research-field-cards-v11").digest("hex"),
				appliedAt,
			);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function guardResearchFieldCards(database: DatabaseSync): void {
	const fields = "$.curation.detailFields";
	const version = `${fields}.schemaVersion`;
	const revision = `${fields}.revision`;
	database.exec(`
		CREATE TRIGGER IF NOT EXISTS papers_detail_fields_insert_guard
		BEFORE INSERT ON papers
		WHEN json_type(NEW.record_json, '${fields}') IS NOT NULL
			AND COALESCE(json_extract(NEW.record_json, '${version}'), -1) <> ${PAPER_DETAIL_FIELDS_SCHEMA_VERSION}
		BEGIN
			SELECT RAISE(ABORT, 'Outdated research card format; restart Paper Agent');
		END;
		CREATE TRIGGER IF NOT EXISTS papers_detail_fields_update_guard
		BEFORE UPDATE OF record_json ON papers
		WHEN (
			json_type(NEW.record_json, '${fields}') IS NOT NULL
			AND COALESCE(json_extract(NEW.record_json, '${version}'), -1) <> ${PAPER_DETAIL_FIELDS_SCHEMA_VERSION}
		) OR (
			json_extract(OLD.record_json, '${version}') = ${PAPER_DETAIL_FIELDS_SCHEMA_VERSION}
			AND (
				json_type(NEW.record_json, '${fields}') IS NULL
				OR COALESCE(json_extract(NEW.record_json, '${revision}'), -1)
					< COALESCE(json_extract(OLD.record_json, '${revision}'), -1)
			)
		)
		BEGIN
			SELECT RAISE(ABORT, 'Outdated research card format or revision; restart Paper Agent');
		END;
	`);
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
	resetResearchFieldCards(database, appliedAt);
	repairLegacyResearchFieldCards(database, appliedAt);
	guardResearchFieldCards(database);
}
