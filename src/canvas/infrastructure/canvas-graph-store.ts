import { DatabaseSync } from "node:sqlite";
import { ensureSearchRunGraphs } from "./search-run-graph-store.ts";
import type { CanvasGraphState } from "../domain/canvas-graph.ts";

export function ensureCanvasGraph(db: DatabaseSync): void {
	db.exec(`CREATE TABLE IF NOT EXISTS canvas_graph_state (
		canvas_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL)`);
}
export function copyCanvasGraph(db: DatabaseSync, from: string, to: string): void {
	ensureCanvasGraph(db);
	ensureSearchRunGraphs(db);
	db.prepare(
		"INSERT INTO canvas_search_graph_features SELECT ?,run_id,value_json FROM canvas_search_graph_features WHERE canvas_id=?",
	).run(to, from);
	db.prepare(
		"INSERT INTO canvas_search_graphs SELECT ?,run_id,value_json FROM canvas_search_graphs WHERE canvas_id=?",
	).run(to, from);
	db.prepare(
		"INSERT INTO canvas_graph_state SELECT ?,revision,value_json FROM canvas_graph_state WHERE canvas_id=?",
	).run(to, from);
}
export function deleteCanvasGraph(db: DatabaseSync, id: string): void {
	ensureCanvasGraph(db);
	ensureSearchRunGraphs(db);
	db.prepare("DELETE FROM canvas_search_graph_features WHERE canvas_id=?").run(id);
	db.prepare("DELETE FROM canvas_search_graphs WHERE canvas_id=?").run(id);
	db.prepare("DELETE FROM canvas_graph_state WHERE canvas_id=?").run(id);
}
export class CanvasGraphStore {
	readonly path: string;
	readonly canvasId: string;
	constructor(path: string, canvasId: string) {
		this.path = path;
		this.canvasId = canvasId;
	}
	private database<T>(fn: (db: DatabaseSync) => T): T {
		const db = new DatabaseSync(this.path);
		try {
			db.exec("PRAGMA busy_timeout=5000");
			ensureCanvasGraph(db);
			return fn(db);
		} finally {
			db.close();
		}
	}
	state(): CanvasGraphState {
		return this.database((db) => {
			const row = db.prepare("SELECT value_json FROM canvas_graph_state WHERE canvas_id=?").get(this.canvasId) as
				| { value_json: string }
				| undefined;
			return row ? JSON.parse(row.value_json) : { revision: 0, positions: {}, viewport: { x: 0, y: 0, scale: 1 } };
		});
	}
	saveState(input: CanvasGraphState): CanvasGraphState {
		const { positions, viewport, revision, focusId } = input;
		if (
			!Number.isSafeInteger(revision) ||
			revision < 0 ||
			(focusId !== undefined && (typeof focusId !== "string" || !/^[\w-]{1,80}$/.test(focusId))) ||
			!positions ||
			Object.keys(positions).length > 500 ||
			!viewport ||
			![viewport.x, viewport.y, viewport.scale].every(Number.isFinite) ||
			viewport.scale < 0.1 ||
			viewport.scale > 5 ||
			Object.entries(positions).some(
				([id, p]) =>
					!/^[\w-]{1,80}$/.test(id) || !p || ![p.x, p.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000),
			)
		)
			throw new Error("图谱视图状态无效");
		const value = { revision: revision + 1, positions, viewport, ...(focusId ? { focusId } : {}) };
		return this.database((db) => {
			if (revision !== 0 && !db.prepare("SELECT 1 FROM canvas_graph_state WHERE canvas_id=?").get(this.canvasId))
				throw new Error("图谱状态不存在，请重新读取");
			const result = db
				.prepare(
					`INSERT INTO canvas_graph_state VALUES (?,?,?) ON CONFLICT(canvas_id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json WHERE canvas_graph_state.revision=?`,
				)
				.run(this.canvasId, value.revision, JSON.stringify(value), revision);
			if (!result.changes) throw new Error("图谱位置已在另一页面更新，请刷新图谱");
			return value;
		});
	}
}
