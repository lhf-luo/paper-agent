import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ResearchCanvas, ResearchCanvasSummary } from "../domain/research-canvas.ts";
import { validateCanvasDocument } from "../domain/research-canvas.ts";

interface CanvasRow {
	id: string;
	title: string;
	revision: number;
	created_at: string;
	updated_at: string;
	document_json: string;
}

export class CanvasRevisionConflict extends Error {}

/** Personal namespaces share one SQLite file, so every query includes namespace_id. */
export class ResearchCanvasStore {
	private readonly databasePath: string;
	private readonly namespace: string;

	constructor(databasePath: string, namespace: string) {
		this.databasePath = databasePath;
		this.namespace = namespace;
	}

	private withDatabase<T>(operation: (database: DatabaseSync) => T): T {
		const database = new DatabaseSync(this.databasePath);
		try {
			database.exec(`CREATE TABLE IF NOT EXISTS research_canvases (
				namespace_id TEXT NOT NULL,
				id TEXT NOT NULL,
				title TEXT NOT NULL,
				revision INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				document_json TEXT NOT NULL,
				PRIMARY KEY(namespace_id, id)
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
				"INSERT INTO research_canvases(namespace_id, id, title, revision, created_at, updated_at, document_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(this.namespace, canvas.id, canvas.title, canvas.revision, now, now, JSON.stringify(document));
		return canvas;
	}

	list(): ResearchCanvasSummary[] {
		return this.withDatabase((database) => {
			const rows = database
				.prepare("SELECT * FROM research_canvases WHERE namespace_id = ? ORDER BY updated_at DESC")
				.all(this.namespace) as unknown as CanvasRow[];
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
			const row = database
				.prepare("SELECT * FROM research_canvases WHERE namespace_id = ? AND id = ?")
				.get(this.namespace, id) as CanvasRow | undefined;
			return row ? this.canvasFrom(row) : undefined;
		});
	}

	create(title: string): ResearchCanvas {
		const document = validateCanvasDocument({ title, nodes: [], edges: [], viewport: { x: 0, y: 0, scale: 1 } });
		return this.withDatabase((database) => this.insert(database, document));
	}

	duplicate(id: string, expectedRevision: number): ResearchCanvas | undefined {
		return this.withDatabase((database) => {
			const row = database
				.prepare("SELECT * FROM research_canvases WHERE namespace_id = ? AND id = ?")
				.get(this.namespace, id) as CanvasRow | undefined;
			if (!row) return undefined;
			if (row.revision !== expectedRevision)
				throw new CanvasRevisionConflict("画布已在其他页面修改，请刷新后再创建副本。");
			const source = this.canvasFrom(row);
			const document = validateCanvasDocument({
				title: `${source.title.slice(0, 117)} 副本`,
				nodes: source.nodes,
				edges: source.edges,
				viewport: source.viewport,
			});
			return this.insert(database, document);
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
		return this.withDatabase((database) => {
			const result = database
				.prepare(
					"UPDATE research_canvases SET title = ?, revision = revision + 1, updated_at = ?, document_json = ? WHERE namespace_id = ? AND id = ? AND revision = ?",
				)
				.run(document.title, now, JSON.stringify(document), this.namespace, id, expectedRevision);
			if (result.changes === 0) {
				const exists = database
					.prepare("SELECT 1 FROM research_canvases WHERE namespace_id = ? AND id = ?")
					.get(this.namespace, id);
				if (exists) throw new CanvasRevisionConflict("画布已在其他页面修改。当前草稿仍保留，请刷新后核对。");
				return undefined;
			}
			const row = database
				.prepare("SELECT * FROM research_canvases WHERE namespace_id = ? AND id = ?")
				.get(this.namespace, id) as unknown as CanvasRow;
			return this.canvasFrom(row);
		});
	}

	delete(id: string, expectedRevision: number): boolean {
		return this.withDatabase((database) => {
			// A canvas owns its nodes, edges, rich text, and viewport in this single JSON row.
			// Removing the row leaves no canvas child records to accumulate.
			const result = database
				.prepare("DELETE FROM research_canvases WHERE namespace_id = ? AND id = ? AND revision = ?")
				.run(this.namespace, id, expectedRevision);
			if (result.changes > 0) return true;
			const exists = database
				.prepare("SELECT 1 FROM research_canvases WHERE namespace_id = ? AND id = ?")
				.get(this.namespace, id);
			if (exists) throw new CanvasRevisionConflict("画布已在其他页面修改，请刷新后再删除。");
			return false;
		});
	}
}
