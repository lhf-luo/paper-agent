import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyCanvasOperations, selectedChangeIds, undoCanvasChanges } from "../domain/canvas-changes.ts";
import type { CanvasChangeProposal, CanvasResearchAnalysis, CanvasResearchRecord } from "../domain/canvas-research.ts";
import { type ResearchCanvas, validateCanvasDocument } from "../domain/research-canvas.ts";
import { emitCanvasResearchChange } from "./canvas-research-events.ts";
import { CanvasRevisionConflict } from "./research-canvas-store.ts";

export type ResearchRecordKind = "settings" | "scope" | "analysis" | "proposal";
interface RecordRow {
	id: string;
	revision: number;
	session_id: string;
	created_at: string;
	updated_at: string;
	value_json: string;
}
interface BoardRow {
	id: string;
	title: string;
	revision: number;
	created_at: string;
	updated_at: string;
	document_json: string;
}
export class CanvasResearchStore {
	readonly databasePath: string;

	readonly canvasId: string;
	constructor(databasePath: string, canvasId: string) {
		this.databasePath = databasePath;

		this.canvasId = canvasId;
	}
	private database<T>(fn: (db: DatabaseSync) => T): T {
		const db = new DatabaseSync(this.databasePath);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec(`CREATE TABLE IF NOT EXISTS canvas_research_records (
				 canvas_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
				revision INTEGER NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				value_json TEXT NOT NULL, PRIMARY KEY(canvas_id, kind, id))`);
			return fn(db);
		} finally {
			db.close();
		}
	}
	private decode<T>(row: RecordRow): CanvasResearchRecord<T> {
		return {
			id: row.id,
			revision: row.revision,
			sessionId: row.session_id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			value: JSON.parse(row.value_json) as T,
		};
	}
	private read<T>(db: DatabaseSync, kind: ResearchRecordKind, id: string): CanvasResearchRecord<T> | undefined {
		const row = db
			.prepare("SELECT * FROM canvas_research_records WHERE canvas_id=? AND kind=? AND id=?")
			.get(this.canvasId, kind, id) as RecordRow | undefined;
		return row ? this.decode<T>(row) : undefined;
	}
	get<T>(kind: ResearchRecordKind, id: string): CanvasResearchRecord<T> | undefined {
		return this.database((db) => this.read<T>(db, kind, id));
	}
	list<T>(kind: ResearchRecordKind): CanvasResearchRecord<T>[] {
		return this.database((db) =>
			(
				db
					.prepare(
						"SELECT * FROM canvas_research_records WHERE canvas_id=? AND kind=? ORDER BY updated_at DESC,id",
					)
					.all(this.canvasId, kind) as unknown as RecordRow[]
			).map((r) => this.decode<T>(r)),
		);
	}
	private write<T>(
		db: DatabaseSync,
		kind: ResearchRecordKind,
		value: T,
		sessionId: string,
		id: string,
		expectedRevision?: number,
	): CanvasResearchRecord<T> {
		const previous = this.read<T>(db, kind, id);
		if (previous && previous.revision !== expectedRevision)
			throw new CanvasRevisionConflict("研究记录已更新，请重新读取后重试。");
		if (!previous && expectedRevision !== undefined && expectedRevision !== -1)
			throw new CanvasRevisionConflict("研究记录不存在或已删除。");
		const now = new Date().toISOString();
		const record = {
			id,
			revision: (previous?.revision ?? -1) + 1,
			sessionId,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			value,
		};
		db.prepare(
			`INSERT INTO canvas_research_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(canvas_id,kind,id) DO UPDATE SET revision=excluded.revision, session_id=excluded.session_id, updated_at=excluded.updated_at, value_json=excluded.value_json`,
		).run(this.canvasId, kind, id, record.revision, sessionId, record.createdAt, now, JSON.stringify(value));
		return record;
	}
	save<T>(
		kind: ResearchRecordKind,
		value: T,
		sessionId: string,
		id: string = randomUUID(),
		expectedRevision?: number,
	): CanvasResearchRecord<T> {
		return this.database((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				this.board(db);
				const result = this.write(db, kind, value, sessionId, id, expectedRevision);
				db.exec("COMMIT");
				emitCanvasResearchChange(this.databasePath, this.canvasId);
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}
	private board(db: DatabaseSync): ResearchCanvas {
		const row = db.prepare("SELECT * FROM research_canvases WHERE id=?").get(this.canvasId) as BoardRow | undefined;
		if (!row) throw new Error("画布不存在");
		return {
			id: row.id,
			revision: row.revision,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			...validateCanvasDocument(JSON.parse(row.document_json)),
		};
	}
	commitProposal(id: string, selectedIds: string[], expectedRevision: number, undo = false) {
		return this.database((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = this.change(db, id, selectedIds, expectedRevision, undo);
				db.exec("COMMIT");
				emitCanvasResearchChange(this.databasePath, this.canvasId);
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}
	private change(db: DatabaseSync, id: string, selection: string[], revision: number, undo: boolean) {
		const record = this.read<CanvasChangeProposal>(db, "proposal", id);
		if (!record) throw new Error("提案不存在");
		const current = this.board(db);
		const p = record.value;
		const selectedIds = undo ? (p.selectedIds ?? []) : selectedChangeIds(p.operations, selection);
		if (
			(!undo && p.status === "applied" && JSON.stringify(p.selectedIds) === JSON.stringify(selectedIds)) ||
			(undo && p.status === "undone")
		)
			return { canvas: current, proposal: record, replayed: true };
		if (current.revision !== revision || (!undo && current.revision !== p.baseRevision))
			throw new CanvasRevisionConflict("画布已变化，请保留草稿并重新生成预览。");
		if ((undo && p.status !== "applied") || (!undo && p.status !== "pending"))
			throw new Error("提案状态不允许此操作");
		const document = undo
			? undoCanvasChanges(current, p.before as ResearchCanvas, p.after as ResearchCanvas)
			: applyCanvasOperations(current, p.operations, selectedIds);
		const now = new Date().toISOString();
		const canvas = { ...current, ...document, revision: revision + 1, updatedAt: now };
		db.prepare(
			"UPDATE research_canvases SET document_json=?,title=?,revision=?,updated_at=? WHERE id=? AND revision=?",
		).run(JSON.stringify(document), document.title, canvas.revision, now, this.canvasId, revision);
		const value: CanvasChangeProposal = undo
			? { ...p, status: "undone" }
			: {
					...p,
					status: "applied",
					selectedIds,
					before: current,
					after: canvas,
					appliedRevision: canvas.revision,
				};
		const proposal = this.write(db, "proposal", value, record.sessionId, record.id, record.revision);
		return { canvas, proposal, replayed: false };
	}
	interrupt(sessionId: string): void {
		for (const record of this.list<CanvasResearchAnalysis>("analysis")) {
			if (record.sessionId === sessionId && record.value.status === "running")
				this.save("analysis", { ...record.value, status: "interrupted" }, sessionId, record.id, record.revision);
		}
	}
	signature(): string {
		return this.database((db) => {
			const row = db
				.prepare(
					"SELECT MAX(updated_at) AS stamp, SUM(revision) AS revisions, COUNT(*) AS count FROM canvas_research_records WHERE canvas_id=?",
				)
				.get(this.canvasId);
			return JSON.stringify([row, this.board(db).revision]);
		});
	}
}
