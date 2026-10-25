import type { DatabaseSync } from "node:sqlite";
import { PAPER_DETAIL_FIELDS_SCHEMA_VERSION } from "../domain/paper-detail-fields.ts";
import { ensurePersonalActivitySchema } from "./personal-schema-activity.ts";
import { ensurePersonalCoreSchema } from "./personal-schema-core.ts";
import { ensurePersonalResearchSchema } from "./personal-schema-research.ts";
import { ensureQuickNotesSchema } from "./personal-schema-quick-notes.ts";

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
	ensureQuickNotesSchema(database);
	ensurePersonalActivitySchema(database);
	guardResearchFieldCards(database);
}
