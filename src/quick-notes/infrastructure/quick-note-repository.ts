import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ensurePersonalDatabaseSchema } from "../../literature/infrastructure/personal-database-schema.ts";
import {
	type CreateQuickNoteInput,
	type QuickNote,
	QuickNoteError,
	type QuickNoteList,
	type QuickNoteLocator,
	type QuickNotePaper,
	type QuickNoteQuery,
	type QuickNoteRepository,
} from "../domain/quick-note.ts";

interface NoteRow {
	id: string;
	content: string;
	request_hash: string;
	source_paper_id: string;
	source_snapshot_json: string;
	locator_json: string | null;
	revision: number;
	created_at: string;
	updated_at: string;
	live_paper_json: string | null;
	location_available: number;
}

const projection = `SELECT q.*, p.record_json AS live_paper_json,
	EXISTS(SELECT 1 FROM paper_versions v JOIN stored_files f ON f.id = v.file_id
		WHERE v.paper_row_id = q.paper_row_id
		AND f.sha256 = json_extract(q.locator_json, '$.pdfSha256')) AS location_available
	FROM quick_notes q LEFT JOIN papers p ON p.row_id = q.paper_row_id`;

function paperSnapshot(paper: QuickNotePaper): QuickNotePaper {
	return { id: paper.id, title: paper.title, authors: paper.authors, ...(paper.year ? { year: paper.year } : {}) };
}

function hydrate(row: NoteRow): QuickNote {
	const snapshot = JSON.parse(row.source_snapshot_json) as QuickNotePaper;
	return {
		id: row.id,
		content: row.content,
		paper: row.live_paper_json ? paperSnapshot(JSON.parse(row.live_paper_json)) : snapshot,
		sourceSnapshot: snapshot,
		paperAvailable: row.live_paper_json !== null,
		...(row.locator_json ? { locator: JSON.parse(row.locator_json) as QuickNoteLocator } : {}),
		locationAvailable: Boolean(row.location_available),
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteQuickNoteRepository implements QuickNoteRepository {
	private readonly databasePath: string;
	private readonly initialize: () => Promise<void>;
	constructor(databasePath: string, initialize: () => Promise<void>) {
		this.databasePath = databasePath;
		this.initialize = initialize;
	}

	private async access<T>(write: boolean, operation: (db: DatabaseSync) => T): Promise<T> {
		await this.initialize();
		const db = new DatabaseSync(this.databasePath);
		try {
			ensurePersonalDatabaseSchema(db);
			db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
			const result = operation(db);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			throw error;
		} finally {
			db.close();
		}
	}

	private getRow(db: DatabaseSync, id: string): QuickNote {
		const row = db.prepare(`${projection} WHERE q.id = ?`).get(id) as unknown as NoteRow | undefined;
		if (!row) throw new QuickNoteError(404, "这条随手记已不存在，请刷新列表");
		return hydrate(row);
	}

	get(id: string): Promise<QuickNote> {
		return this.access(false, (db) => this.getRow(db, id));
	}

	async list(query: Required<QuickNoteQuery>): Promise<QuickNoteList> {
		return this.access(false, (db) => {
			const where: string[] = [];
			const args: SQLInputValue[] = [];
			if (query.paperId) {
				where.push("(p.paper_id = ? OR (q.paper_row_id IS NULL AND q.source_paper_id = ?))");
				args.push(query.paperId, query.paperId);
			}
			if (query.query) {
				where.push(
					"(instr(lower(q.content), lower(?)) > 0 OR instr(lower(COALESCE(p.title, json_extract(q.source_snapshot_json, '$.title'))), lower(?)) > 0)",
				);
				args.push(query.query, query.query);
			}
			const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
			const total = (
				db
					.prepare(
						`SELECT COUNT(*) AS n FROM quick_notes q LEFT JOIN papers p ON p.row_id = q.paper_row_id${clause}`,
					)
					.get(...args) as { n: number }
			).n;
			const rows = db
				.prepare(`${projection}${clause} ORDER BY q.created_at DESC, q.id DESC LIMIT ? OFFSET ?`)
				.all(...args, query.pageSize, (query.page - 1) * query.pageSize) as unknown as NoteRow[];
			const sources = this.sources(db);
			return { notes: rows.map(hydrate), total, page: query.page, pageSize: query.pageSize, sources };
		});
	}

	private sources(db: DatabaseSync): QuickNoteList["sources"] {
		const rows = db
			.prepare(`SELECT DISTINCT q.source_snapshot_json, p.record_json AS live_paper_json
			FROM quick_notes q LEFT JOIN papers p ON p.row_id = q.paper_row_id`)
			.all() as unknown as Array<{
			source_snapshot_json: string;
			live_paper_json: string | null;
		}>;
		const sources = new Map<string, QuickNoteList["sources"][number]>();
		for (const row of rows) {
			const paper = paperSnapshot(JSON.parse(row.live_paper_json ?? row.source_snapshot_json));
			const available = row.live_paper_json !== null;
			const key = `${paper.id}:${available}`;
			sources.set(key, { ...paper, available });
		}
		return [...sources.values()].sort((a, b) => a.title.localeCompare(b.title));
	}

	async create(input: CreateQuickNoteInput): Promise<QuickNote> {
		return this.access(true, (db) => {
			const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const existing = db
				.prepare("SELECT id, request_hash FROM quick_notes WHERE client_request_id = ?")
				.get(input.clientRequestId) as { id: string; request_hash: string } | undefined;
			if (existing) {
				if (existing.request_hash !== hash) throw new QuickNoteError(409, "此请求已保存其他内容，请重新提交");
				return this.getRow(db, existing.id);
			}
			const paper = db.prepare("SELECT row_id, record_json FROM papers WHERE paper_id = ?").get(input.paperId) as
				| { row_id: number; record_json: string }
				| undefined;
			if (!paper) throw new QuickNoteError(404, "来源论文不在个人库中，请先入库或重新选择");
			const locator = this.resolveLocator(db, paper.row_id, input.locator);
			const now = new Date().toISOString();
			const id = randomUUID();
			db.prepare(`INSERT INTO quick_notes (id, client_request_id, request_hash, content, paper_row_id,
				source_paper_id, source_snapshot_json, locator_json, revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
				id,
				input.clientRequestId,
				hash,
				input.content,
				paper.row_id,
				input.paperId,
				JSON.stringify(paperSnapshot(JSON.parse(paper.record_json))),
				locator ? JSON.stringify(locator) : null,
				now,
				now,
			);
			return this.getRow(db, id);
		});
	}

	private resolveLocator(db: DatabaseSync, rowId: number, locator?: QuickNoteLocator): QuickNoteLocator | undefined {
		if (!locator) return undefined;
		const version = db
			.prepare(`SELECT v.version_kind, v.version_label FROM paper_versions v
			JOIN stored_files f ON f.id = v.file_id WHERE v.paper_row_id = ? AND f.sha256 = ?`)
			.get(rowId, locator.pdfSha256) as { version_kind: string | null; version_label: string | null } | undefined;
		if (!version) throw new QuickNoteError(400, "该 PDF 版本不属于来源论文，请重新打开论文后记录");
		return { ...locator, versionLabel: version.version_label || version.version_kind || "PDF" };
	}

	async update(id: string, content: string, expectedRevision: number): Promise<QuickNote> {
		return this.access(true, (db) => {
			this.getRow(db, id);
			const result = db
				.prepare(`UPDATE quick_notes SET content = ?, revision = revision + 1, updated_at = ?
				WHERE id = ? AND revision = ?`)
				.run(content, new Date().toISOString(), id, expectedRevision);
			if (!result.changes)
				throw new QuickNoteError(409, "这条记录已在其他页面修改。草稿已保留，请重新加载最新记录后再保存。");
			return this.getRow(db, id);
		});
	}

	async delete(id: string): Promise<void> {
		await this.access(true, (db) => {
			db.prepare("DELETE FROM quick_notes WHERE id = ?").run(id);
		});
	}

	async countForPapers(paperIds: string[]): Promise<number> {
		if (!paperIds.length) return 0;
		return this.access(
			false,
			(db) =>
				(
					db
						.prepare(`SELECT COUNT(*) AS n FROM quick_notes q
			JOIN papers p ON p.row_id = q.paper_row_id WHERE p.paper_id IN (${paperIds.map(() => "?").join(",")})`)
						.get(...paperIds) as { n: number }
				).n,
		);
	}
}
