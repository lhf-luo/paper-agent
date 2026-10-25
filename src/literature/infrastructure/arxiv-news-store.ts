import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_NEWS_FILTER_GROUPS, type NewsFilterGroup } from "../domain/arxiv-news-rules.ts";
import type { ArxivNewsPaper } from "../domain/arxiv-news.ts";

/** A standalone feed scope, separate from the personal library. */

export interface ArxivNewsBatch {
	id: string;
	name: string;
	startDate: string;
	endDate: string;
	categories: string[];
	fetchedAt: string;
	count: number;
}

export interface ArxivNewsState {
	categories: string[];
	filterGroups: NewsFilterGroup[];
	nextStartDate?: string;
	lastEndDate?: string;
	lastSuccessAt?: string;
	batches: ArxivNewsBatch[];
}

type CursorRow = { last_end_date: string | null; last_success_at: string | null; next_start_date: string | null };
type BatchRow = {
	id: string;
	start_date: string;
	end_date: string;
	categories_json: string;
	fetched_at: string;
	count: number;
};

export function arxivNewsScopeKey(categories: string[]): string {
	return [...new Set(categories)].sort().join(",");
}

function batchView(row: BatchRow): ArxivNewsBatch {
	return {
		id: row.id,
		name: row.start_date === row.end_date ? row.start_date : `${row.start_date} 至 ${row.end_date}`,
		startDate: row.start_date,
		endDate: row.end_date,
		categories: JSON.parse(row.categories_json) as string[],
		fetchedAt: row.fetched_at,
		count: row.count,
	};
}

export class ArxivNewsStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async database(): Promise<DatabaseSync> {
		await mkdir(dirname(this.path), { recursive: true });
		const database = new DatabaseSync(this.path);
		database.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 15000;
			CREATE TABLE IF NOT EXISTS arxiv_news_settings (id INTEGER PRIMARY KEY CHECK(id = 1),

				categories_json TEXT NOT NULL CHECK(json_valid(categories_json)),
				filter_groups_json TEXT CHECK(filter_groups_json IS NULL OR json_valid(filter_groups_json))
			);
			CREATE TABLE IF NOT EXISTS arxiv_news_cursors (

				scope_key TEXT NOT NULL,
				last_end_date TEXT,
				last_success_at TEXT,
				next_start_date TEXT,
				PRIMARY KEY(scope_key)
			);
			CREATE TABLE IF NOT EXISTS arxiv_news_batches (
				id TEXT PRIMARY KEY,

				scope_key TEXT NOT NULL,
				categories_json TEXT NOT NULL CHECK(json_valid(categories_json)),
				start_date TEXT NOT NULL,
				end_date TEXT NOT NULL,
				fetched_at TEXT NOT NULL,
				UNIQUE(scope_key, start_date, end_date)
			);
			CREATE INDEX IF NOT EXISTS arxiv_news_batches_date ON arxiv_news_batches(end_date DESC);
			CREATE TABLE IF NOT EXISTS arxiv_news_items (
				arxiv_id TEXT NOT NULL,
				record_json TEXT NOT NULL CHECK(json_valid(record_json)),
				PRIMARY KEY(arxiv_id)
			);
			CREATE TABLE IF NOT EXISTS arxiv_news_batch_items (
				batch_id TEXT NOT NULL REFERENCES arxiv_news_batches(id) ON DELETE CASCADE,

				arxiv_id TEXT NOT NULL,
				PRIMARY KEY(batch_id, arxiv_id),
				FOREIGN KEY(arxiv_id) REFERENCES arxiv_news_items(arxiv_id) ON DELETE CASCADE
			);
		`);
		return database;
	}

	async state(): Promise<ArxivNewsState> {
		const database = await this.database();
		try {
			const setting = database
				.prepare("SELECT categories_json, filter_groups_json FROM arxiv_news_settings")
				.get() as { categories_json: string; filter_groups_json: string | null } | undefined;
			const categories = setting ? (JSON.parse(setting.categories_json) as string[]) : [];
			const cursor = database
				.prepare(
					"SELECT last_end_date, last_success_at, next_start_date FROM arxiv_news_cursors WHERE scope_key = ?",
				)
				.get(arxivNewsScopeKey(categories)) as CursorRow | undefined;
			const rows = database
				.prepare(`SELECT b.*, COUNT(bi.arxiv_id) AS count FROM arxiv_news_batches b
					LEFT JOIN arxiv_news_batch_items bi ON bi.batch_id = b.id GROUP BY b.id ORDER BY b.end_date DESC, b.fetched_at DESC`)
				.all() as unknown as BatchRow[];
			return {
				categories,
				filterGroups: setting?.filter_groups_json
					? (JSON.parse(setting.filter_groups_json) as NewsFilterGroup[])
					: DEFAULT_NEWS_FILTER_GROUPS,
				...(cursor?.next_start_date ? { nextStartDate: cursor.next_start_date } : {}),
				...(cursor?.last_end_date ? { lastEndDate: cursor.last_end_date } : {}),
				...(cursor?.last_success_at ? { lastSuccessAt: cursor.last_success_at } : {}),
				batches: rows.map(batchView),
			};
		} finally {
			database.close();
		}
	}

	async saveSettings(
		categories: string[],
		nextStartDate?: string,
		filterGroups?: NewsFilterGroup[],
	): Promise<ArxivNewsState> {
		const database = await this.database();
		try {
			database.exec("BEGIN IMMEDIATE");
			database
				.prepare(
					"INSERT INTO arxiv_news_settings(id, categories_json, filter_groups_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET categories_json = excluded.categories_json, filter_groups_json = COALESCE(excluded.filter_groups_json, arxiv_news_settings.filter_groups_json)",
				)
				.run(JSON.stringify(categories), filterGroups ? JSON.stringify(filterGroups) : null);
			if (nextStartDate !== undefined) {
				database
					.prepare(`INSERT INTO arxiv_news_cursors( scope_key, next_start_date)
					VALUES ( ?, ?) ON CONFLICT(scope_key) DO UPDATE SET next_start_date = excluded.next_start_date`)
					.run(arxivNewsScopeKey(categories), nextStartDate);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		} finally {
			database.close();
		}
		return this.state();
	}

	async batch(id: string): Promise<{ batch: ArxivNewsBatch; papers: ArxivNewsPaper[] } | undefined> {
		const database = await this.database();
		try {
			const row = database
				.prepare(`SELECT b.*, COUNT(bi.arxiv_id) AS count FROM arxiv_news_batches b
				LEFT JOIN arxiv_news_batch_items bi ON bi.batch_id = b.id
				WHERE b.id = ? GROUP BY b.id`)
				.get(id) as BatchRow | undefined;
			if (!row) return undefined;
			const papers = database
				.prepare(`SELECT i.record_json FROM arxiv_news_batch_items bi
				JOIN arxiv_news_items i ON i.arxiv_id = bi.arxiv_id
				WHERE bi.batch_id = ? ORDER BY i.arxiv_id DESC`)
				.all(id) as unknown as Array<{ record_json: string }>;
			return { batch: batchView(row), papers: papers.map((paper) => JSON.parse(paper.record_json) as ArxivNewsPaper) };
		} finally {
			database.close();
		}
	}

	async savePull(input: { categories: string[]; date: string; papers: ArxivNewsPaper[] }): Promise<ArxivNewsBatch> {
		const database = await this.database();
		const scopeKey = arxivNewsScopeKey(input.categories);
		const now = new Date().toISOString();
		const nextDate = new Date(`${input.date}T00:00:00.000Z`);
		nextDate.setUTCDate(nextDate.getUTCDate() + 1);
		const nextStartDate = nextDate.toISOString().slice(0, 10);
		let id: string;
		try {
			database.exec("BEGIN IMMEDIATE");
			const existing = database
				.prepare(
					`SELECT id, categories_json FROM arxiv_news_batches WHERE start_date = ? AND end_date = ? ORDER BY fetched_at DESC`,
				)
				.all(input.date, input.date) as unknown as Array<{ id: string; categories_json: string }>;
			id = existing[0]?.id ?? `news-${randomUUID()}`;
			const categories = [
				...new Set([
					...input.categories,
					...existing.flatMap((row) => JSON.parse(row.categories_json) as string[]),
				]),
			].sort();
			if (existing.length) {
				database
					.prepare("UPDATE arxiv_news_batches SET categories_json = ?, fetched_at = ? WHERE id = ?")
					.run(JSON.stringify(categories), now, id);
			} else {
				database
					.prepare(`INSERT INTO arxiv_news_batches(id, scope_key, categories_json, start_date, end_date, fetched_at)
					VALUES (?, ?, ?, ?, ?, ?)`)
					.run(id, scopeKey, JSON.stringify(categories), input.date, input.date, now);
			}
			for (const duplicate of existing.slice(1)) {
				database
					.prepare(`INSERT OR IGNORE INTO arxiv_news_batch_items(batch_id, arxiv_id)
					SELECT ?, arxiv_id FROM arxiv_news_batch_items WHERE batch_id = ?`)
					.run(id, duplicate.id);
				database.prepare("DELETE FROM arxiv_news_batches WHERE id = ?").run(duplicate.id);
			}
			const upsert = database.prepare(`INSERT INTO arxiv_news_items(arxiv_id, record_json) VALUES (?, ?)
				ON CONFLICT(arxiv_id) DO UPDATE SET record_json = excluded.record_json`);
			const attach = database.prepare(
				"INSERT OR IGNORE INTO arxiv_news_batch_items(batch_id, arxiv_id) VALUES (?, ?)",
			);
			for (const paper of input.papers) {
				const arxivId = paper.identifiers.arxivId;
				if (!arxivId) throw new Error("arXiv news record has no arXiv ID");
				upsert.run(arxivId, JSON.stringify(paper));
				attach.run(id, arxivId);
			}
			database
				.prepare(`DELETE FROM arxiv_news_items WHERE NOT EXISTS
				(SELECT 1 FROM arxiv_news_batch_items bi WHERE bi.arxiv_id = arxiv_news_items.arxiv_id)`)
				.run();
			const prior = database
				.prepare("SELECT last_end_date FROM arxiv_news_cursors WHERE scope_key = ?")
				.get(scopeKey) as { last_end_date: string | null } | undefined;
			const lastEndDate =
				prior?.last_end_date && prior.last_end_date > nextStartDate ? prior.last_end_date : nextStartDate;
			database
				.prepare(`INSERT INTO arxiv_news_cursors( scope_key, last_end_date, last_success_at, next_start_date)
				VALUES ( ?, ?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET
				last_end_date = excluded.last_end_date, last_success_at = excluded.last_success_at,
				next_start_date = excluded.next_start_date`)
				.run(scopeKey, lastEndDate, now, lastEndDate);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		} finally {
			database.close();
		}
		const saved = await this.batch(id);
		if (!saved) throw new Error("Saved arXiv news day could not be read");
		return saved.batch;
	}

	async deleteBatch(id: string): Promise<boolean> {
		const database = await this.database();
		try {
			database.exec("BEGIN IMMEDIATE");
			const result = database.prepare("DELETE FROM arxiv_news_batches WHERE id = ?").run(id);
			database
				.prepare(`DELETE FROM arxiv_news_items WHERE NOT EXISTS
				(SELECT 1 FROM arxiv_news_batch_items bi WHERE bi.arxiv_id = arxiv_news_items.arxiv_id)`)
				.run();
			database.exec("COMMIT");
			return result.changes > 0;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		} finally {
			database.close();
		}
	}
}
