import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensurePersonalDatabaseSchema } from "../src/literature/infrastructure/personal-database-schema.ts";

describe("current personal storage contract", () => {
	it("creates the complete schema directly and can initialize it repeatedly", () => {
		const db = new DatabaseSync(":memory:");
		try {
			ensurePersonalDatabaseSchema(db);
			ensurePersonalDatabaseSchema(db);
			const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
			expect(names).toEqual(expect.arrayContaining(["papers", "research_notes", "paper_versions", "search_runs"]));
			expect(names.some((name) => /namespace|migration/.test(String(name)))).toBe(false);
			const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
			expect(columns("paper_versions")).toContain("publication_version_id");
			expect(columns("research_notes")).toContain("folder_id");
		} finally {
			db.close();
		}
	});

	it("rejects invalid research fields rather than resetting stored paper contents", () => {
		const db = new DatabaseSync(":memory:");
		try {
			ensurePersonalDatabaseSchema(db);
			const insert = db.prepare(`INSERT INTO papers(paper_id,title,normalized_title,record_json,created_at,updated_at)
				VALUES ('invalid','Invalid','invalid',?,'2026-10-22','2026-10-22')`);
			expect(() => insert.run(JSON.stringify({ curation: { detailFields: { schemaVersion: 0 } } }))).toThrow("Outdated research card format");
			expect(db.prepare("SELECT count(*) n FROM papers").get()?.n).toBe(0);
		} finally {
			db.close();
		}
	});
});
