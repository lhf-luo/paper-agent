import type { GraphFeatures, GraphRelation } from "../domain/search-graph-relations.ts";
import { DatabaseSync } from "node:sqlite";
import type { SearchRunGraph } from "../domain/search-run-graph.ts";
import { emitCanvasResearchChange } from "./canvas-research-events.ts";

export function ensureSearchRunGraphs(db: DatabaseSync): void {
	db.exec(`CREATE TABLE IF NOT EXISTS canvas_search_graphs (
		canvas_id TEXT NOT NULL, run_id TEXT NOT NULL, value_json TEXT NOT NULL,
		PRIMARY KEY(canvas_id, run_id))`);
	db.exec(
		`CREATE TABLE IF NOT EXISTS canvas_search_graph_features (canvas_id TEXT NOT NULL, run_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(canvas_id,run_id))`,
	);
}

export class SearchRunGraphStore {
	private readonly path: string;
	private readonly canvasId: string;
	constructor(path: string, canvasId: string) {
		this.path = path;
		this.canvasId = canvasId;
	}

	private database<T>(fn: (db: DatabaseSync) => T): T {
		const db = new DatabaseSync(this.path);
		try {
			db.exec("PRAGMA busy_timeout=5000");
			ensureSearchRunGraphs(db);
			if (!db.prepare("SELECT 1 FROM research_canvases WHERE id=?").get(this.canvasId))
				throw new Error("画布不存在");
			return fn(db);
		} finally {
			db.close();
		}
	}

	getResearch(runId: string): {
		features: GraphFeatures;
		fingerprint?: string;
		relations?: GraphRelation[];
		attempts?: number;
	} {
		return this.database((db) => {
			const row = db
				.prepare("SELECT value_json FROM canvas_search_graph_features WHERE canvas_id=? AND run_id=?")
				.get(this.canvasId, runId);
			return row ? JSON.parse(String(row.value_json)) : { features: {} };
		});
	}
	saveResearch(runId: string, value: ReturnType<SearchRunGraphStore["getResearch"]>) {
		this.database((db) =>
			db
				.prepare(
					"INSERT INTO canvas_search_graph_features VALUES (?,?,?) ON CONFLICT(canvas_id,run_id) DO UPDATE SET value_json=excluded.value_json",
				)
				.run(this.canvasId, runId, JSON.stringify(value)),
		);
		emitCanvasResearchChange(this.path, this.canvasId);
	}

	list(): SearchRunGraph[] {
		return this.database((db) =>
			db
				.prepare("SELECT value_json FROM canvas_search_graphs WHERE canvas_id=? ORDER BY rowid")
				.all(this.canvasId)
				.map((r) => JSON.parse(String(r.value_json))),
		);
	}

	get(runId: string): SearchRunGraph | undefined {
		return this.list().find((r) => r.runId === runId);
	}

	save(value: SearchRunGraph, expectedRevision?: number): SearchRunGraph {
		this.database((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const row = db
					.prepare("SELECT value_json FROM canvas_search_graphs WHERE canvas_id=? AND run_id=?")
					.get(this.canvasId, value.runId);
				const previous: SearchRunGraph | undefined = row ? JSON.parse(String(row.value_json)) : undefined;
				if (expectedRevision !== undefined && previous?.state.revision !== expectedRevision)
					throw new Error("搜索图谱视图已更新，请重新打开后重试");
				if (previous)
					value =
						expectedRevision === undefined
							? { ...value, state: previous.state }
							: { ...previous, state: value.state };
				db.prepare(
					"INSERT INTO canvas_search_graphs VALUES (?,?,?) ON CONFLICT(canvas_id,run_id) DO UPDATE SET value_json=excluded.value_json",
				).run(this.canvasId, value.runId, JSON.stringify(value));
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
		emitCanvasResearchChange(this.path, this.canvasId);
		return value;
	}
}
