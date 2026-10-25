import { copyCanvasGraph, deleteCanvasGraph, ensureCanvasGraph } from "./canvas-graph-store.ts";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ResearchCanvas, ResearchCanvasSummary } from "../domain/research-canvas.ts";
import { validateCanvasDocument } from "../domain/research-canvas.ts";
import { emitCanvasResearchChange } from "./canvas-research-events.ts";
import { syncResearchHistory } from "./canvas-research-history.ts";

interface CanvasRow {
	id: string;
	title: string;
	revision: number;
	created_at: string;
	updated_at: string;
	document_json: string;
}

export class CanvasRevisionConflict extends Error {}

/** One personal workspace stores its canvases in the shared SQLite database. */
export class ResearchCanvasStore {
	private readonly databasePath: string;

	constructor(databasePath: string) {
		this.databasePath = databasePath;
	}

	private withDatabase<T>(operation: (database: DatabaseSync) => T): T {
		const database = new DatabaseSync(this.databasePath);
		try {
			database.exec("PRAGMA busy_timeout = 5000");
			database.exec(`CREATE TABLE IF NOT EXISTS research_canvases (

				id TEXT NOT NULL,
				title TEXT NOT NULL,
				revision INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				document_json TEXT NOT NULL,
				PRIMARY KEY(id)
			)`);
			return operation(database);
		} finally {
			database.close();
		}
	}

	private canvasFrom(row: CanvasRow): ResearchCanvas {
		const document = validateCanvasDocument(JSON.parse(row.document_json));
		return {
			id: row.id,
			revision: row.revision,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			...document,
		};
	}

	private insert(database: DatabaseSync, document: ReturnType<typeof validateCanvasDocument>): ResearchCanvas {
		const now = new Date().toISOString();
		const canvas: ResearchCanvas = { id: randomUUID(), revision: 0, createdAt: now, updatedAt: now, ...document };
		database
			.prepare(
				"INSERT INTO research_canvases( id, title, revision, created_at, updated_at, document_json) VALUES ( ?, ?, ?, ?, ?, ?)",
			)
			.run(canvas.id, canvas.title, canvas.revision, now, now, JSON.stringify(document));
		return canvas;
	}

	list(): ResearchCanvasSummary[] {
		return this.withDatabase((database) => {
			const rows = database
				.prepare("SELECT * FROM research_canvases ORDER BY updated_at DESC")
				.all() as unknown as CanvasRow[];
			return rows.map((row) => ({
				id: row.id,
				title: row.title,
				revision: row.revision,
				updatedAt: row.updated_at,
				nodeCount: this.canvasFrom(row).nodes.length,
			}));
		});
	}

	get(id: string): ResearchCanvas | undefined {
		return this.withDatabase((database) => {
			const row = database.prepare("SELECT * FROM research_canvases WHERE id = ?").get(id) as CanvasRow | undefined;
			return row ? this.canvasFrom(row) : undefined;
		});
	}

	create(title: string): ResearchCanvas {
		const document = validateCanvasDocument({ title, nodes: [], edges: [], viewport: { x: 0, y: 0, scale: 1 } });
		return this.withDatabase((database) => this.insert(database, document));
	}

	duplicate(id: string, expectedRevision: number): ResearchCanvas | undefined {
		return this.withTransaction((database) => {
			const row = database.prepare("SELECT * FROM research_canvases WHERE id = ?").get(id) as CanvasRow | undefined;
			if (!row) return undefined;
			if (row.revision !== expectedRevision)
				throw new CanvasRevisionConflict("画布已在其他页面修改，请刷新后再创建副本。");
			const source = this.canvasFrom(row);
			const document = validateCanvasDocument({
				title: `${source.title.slice(0, 117)} 副本`,
				nodes: source.nodes.map((node) =>
					node.generatedFrom ? { ...node, generatedFrom: { ...node.generatedFrom, snapshot: true } } : node,
				),
				edges: source.edges.map((edge) =>
					edge.research ? { ...edge, research: { ...edge.research, evidenceStatus: "needs_review" } } : edge,
				),
				groups: source.groups,
				viewport: source.viewport,
			});
			const copied = this.insert(database, document);
			copyCanvasGraph(database, source.id, copied.id);
			if (
				database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_research_records'").get()
			) {
				database
					.prepare(
						"INSERT INTO canvas_research_records SELECT ?, kind, id, 0, session_id, created_at, updated_at, value_json FROM canvas_research_records WHERE canvas_id=? AND kind='settings'",
					)
					.run(copied.id, source.id);
			}
			return copied;
		});
	}

	rename(id: string, expectedRevision: number, title: string): ResearchCanvas | undefined {
		const source = this.get(id);
		if (!source) return undefined;
		return this.update(id, expectedRevision, { ...source, title });
	}

	update(id: string, expectedRevision: number, input: unknown): ResearchCanvas | undefined {
		const document = validateCanvasDocument(input);
		const now = new Date().toISOString();
		return this.withTransaction((database) => {
			ensureCanvasGraph(database);
			const previous = database.prepare("SELECT document_json FROM research_canvases WHERE id=?").get(id) as
				| { document_json: string }
				| undefined;
			const result = database
				.prepare(
					"UPDATE research_canvases SET title = ?, revision = revision + 1, updated_at = ?, document_json = ? WHERE id = ? AND revision = ?",
				)
				.run(document.title, now, JSON.stringify(document), id, expectedRevision);
			if (result.changes === 0) {
				const exists = database.prepare("SELECT 1 FROM research_canvases WHERE id = ?").get(id);
				if (exists) throw new CanvasRevisionConflict("画布已在其他页面修改。当前草稿仍保留，请刷新后核对。");
				return undefined;
			}
			const row = database.prepare("SELECT * FROM research_canvases WHERE id = ?").get(id) as unknown as CanvasRow;
			const saved = this.canvasFrom(row);
			if (previous)
				syncResearchHistory(
					database,

					id,
					validateCanvasDocument(JSON.parse(previous.document_json)),
					document,
					saved.revision,
				);
			emitCanvasResearchChange(this.databasePath, id);
			return saved;
		});
	}

	delete(id: string, expectedRevision: number): boolean {
		return this.withTransaction((database) => {
			const result = database
				.prepare("DELETE FROM research_canvases WHERE id = ? AND revision = ?")
				.run(id, expectedRevision);
			if (result.changes > 0) {
				deleteCanvasGraph(database, id);
				if (
					database
						.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_research_records'")
						.get()
				)
					database.prepare("DELETE FROM canvas_research_records WHERE canvas_id=?").run(id);
				emitCanvasResearchChange(this.databasePath, id);
				return true;
			}
			const exists = database.prepare("SELECT 1 FROM research_canvases WHERE id = ?").get(id);
			if (exists) throw new CanvasRevisionConflict("画布已在其他页面修改，请刷新后再删除。");
			return false;
		});
	}
	private withTransaction<T>(fn: (database: DatabaseSync) => T): T {
		return this.withDatabase((database) => {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(database);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		});
	}
}
