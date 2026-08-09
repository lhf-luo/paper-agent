import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PaperRecord } from "./literature-types.ts";

interface SearchRow {
	id: string;
	rank: number;
}

function searchable(record: PaperRecord) {
	return {
		id: record.id,
		title: record.title,
		authors: record.authors.join(" "),
		venue: record.venue ?? "",
		abstract: record.abstract ?? "",
		tags: record.curation?.tags.join(" ") ?? "",
		identifiers: [
			record.id,
			record.identifiers.doi,
			record.identifiers.arxivId,
			record.identifiers.openAlexId,
			record.identifiers.semanticScholarId,
			record.identifiers.dblpKey,
			record.identifiers.pmid,
			record.identifiers.coreId,
			record.identifiers.openCitationsId,
		]
			.filter(Boolean)
			.join(" "),
		userNotes: record.curation?.userNotes.map((note) => note.text).join(" ") ?? "",
		publicationType: record.publicationType ?? "",
	};
}

function ftsQuery(value: string): string | undefined {
	const terms = value
		.normalize("NFKC")
		.toLowerCase()
		.match(/[\p{L}\p{N}]+/gu)
		?.filter((term) => term.length > 1);
	if (!terms?.length) return undefined;
	return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

export class LiteratureSearchIndex {
	private readonly databasePath: string;

	constructor(databasePath: string) {
		this.databasePath = databasePath;
	}

	private open(): DatabaseSync {
		const database = new DatabaseSync(this.databasePath);
		database.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS paper_search USING fts5(
				id UNINDEXED,
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
			CREATE TABLE IF NOT EXISTS search_index_state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		return database;
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.databasePath), { recursive: true });
		const database = this.open();
		database.close();
	}

	async ensure(recordsSignature: string, loadRecords: () => Promise<PaperRecord[]>): Promise<boolean> {
		await this.initialize();
		let database = this.open();
		const current = database.prepare("SELECT value FROM search_index_state WHERE key = 'records-signature'").get() as
			| { value: string }
			| undefined;
		if (current?.value === recordsSignature) {
			database.close();
			return false;
		}
		database.close();
		const records = await loadRecords();
		database = this.open();
		try {
			database.exec("BEGIN IMMEDIATE");
			database.exec("DELETE FROM paper_search");
			const insert = database.prepare(
				"INSERT INTO paper_search(id, title, authors, venue, abstract, tags, identifiers, user_notes, publication_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const record of records) {
				const value = searchable(record);
				insert.run(
					value.id,
					value.title,
					value.authors,
					value.venue,
					value.abstract,
					value.tags,
					value.identifiers,
					value.userNotes,
					value.publicationType,
				);
			}
			database
				.prepare("INSERT OR REPLACE INTO search_index_state(key, value) VALUES ('records-signature', ?)")
				.run(recordsSignature);
			database.exec("COMMIT");
			return true;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				/* Preserve the indexing error. */
			}
			throw error;
		} finally {
			database.close();
		}
	}

	async upsert(record: PaperRecord): Promise<void> {
		await this.initialize();
		const database = this.open();
		try {
			const value = searchable(record);
			database.exec("BEGIN IMMEDIATE");
			database.prepare("DELETE FROM paper_search WHERE id = ?").run(record.id);
			database
				.prepare(
					"INSERT INTO paper_search(id, title, authors, venue, abstract, tags, identifiers, user_notes, publication_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.id,
					value.title,
					value.authors,
					value.venue,
					value.abstract,
					value.tags,
					value.identifiers,
					value.userNotes,
					value.publicationType,
				);
			database.exec("COMMIT");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				/* Preserve the indexing error. */
			}
			throw error;
		} finally {
			database.close();
		}
	}

	async remove(id: string): Promise<void> {
		await this.initialize();
		const database = this.open();
		try {
			database.prepare("DELETE FROM paper_search WHERE id = ?").run(id);
		} finally {
			database.close();
		}
	}

	async setRecordsSignature(signature: string): Promise<void> {
		await this.initialize();
		const database = this.open();
		try {
			database
				.prepare("INSERT OR REPLACE INTO search_index_state(key, value) VALUES ('records-signature', ?)")
				.run(signature);
		} finally {
			database.close();
		}
	}

	async search(query: string, limit = 5000): Promise<Array<{ id: string; rank: number }>> {
		const match = ftsQuery(query);
		if (!match) return [];
		await this.initialize();
		const database = this.open();
		try {
			const rows = database
				.prepare(
					`SELECT id, bm25(paper_search, 0, 8, 4, 3, 1, 6, 12, 2, 2) AS rank FROM paper_search WHERE paper_search MATCH ? ORDER BY rank LIMIT ?`,
				)
				.all(match, Math.min(Math.max(limit, 1), 20_000)) as unknown as SearchRow[];
			return rows.map((row) => ({ id: row.id, rank: row.rank }));
		} finally {
			database.close();
		}
	}
}
