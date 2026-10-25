import type { DatabaseSync } from "node:sqlite";
import type { CanvasChangeProposal } from "../domain/canvas-research.ts";
import type { ResearchCanvas } from "../domain/research-canvas.ts";

type Document = Pick<ResearchCanvas, "title" | "nodes" | "edges" | "groups" | "viewport">;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function restored(from: Document, to: Document, previous: Document, next: Document) {
	let changed = false;
	for (const key of ["nodes", "edges", "groups"] as const) {
		const old = new Map((from[key] ?? []).map((item) => [item.id, item]));
		const target = new Map((to[key] ?? []).map((item) => [item.id, item]));
		const before = new Map((previous[key] ?? []).map((item) => [item.id, item]));
		const after = new Map((next[key] ?? []).map((item) => [item.id, item]));
		for (const id of new Set([...old.keys(), ...target.keys()])) {
			if (equal(old.get(id), target.get(id))) continue;
			changed = true;
			if (!equal(before.get(id), old.get(id)) || !equal(after.get(id), target.get(id))) return false;
		}
	}
	if (from.title !== to.title) {
		changed = true;
		if (previous.title !== from.title || next.title !== to.title) return false;
	}
	return changed;
}
/** Keep durable batch history consistent when the normal canvas undo/redo restores its affected objects. */
export function syncResearchHistory(
	db: DatabaseSync,

	canvasId: string,
	previous: Document,
	next: Document,
	revision: number,
) {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_research_records'").get()) return;
	const records = db
		.prepare("SELECT id,value_json FROM canvas_research_records WHERE canvas_id=? AND kind='proposal'")
		.all(canvasId) as unknown as Array<{ id: string; value_json: string }>;
	for (const row of records) {
		const p = JSON.parse(row.value_json) as CanvasChangeProposal;
		if (!p.before || !p.after || p.status === "pending") continue;
		const undo = p.status === "applied";
		const from = (undo ? p.after : p.before) as Document,
			to = (undo ? p.before : p.after) as Document;
		if (!restored(from, to, previous, next)) continue;
		const value = { ...p, status: undo ? "undone" : "applied", appliedRevision: revision };
		db.prepare(
			"UPDATE canvas_research_records SET revision=revision+1,updated_at=?,value_json=? WHERE canvas_id=? AND kind='proposal' AND id=?",
		).run(new Date().toISOString(), JSON.stringify(value), canvasId, row.id);
	}
}
