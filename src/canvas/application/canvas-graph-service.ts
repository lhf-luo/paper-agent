import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import type { CanvasNode } from "../domain/research-canvas.ts";
import { CanvasGraphStore } from "../infrastructure/canvas-graph-store.ts";
import { ResearchCanvasStore } from "../infrastructure/research-canvas-store.ts";

export async function resolveCanvasPaper(library: LiteratureStore, node: CanvasNode) {
	const personal = node.entityId ? await library.getPaper(node.entityId) : undefined;
	return { paper: personal, personal };
}

export async function canvasGraph(library: LiteratureStore, canvasId: string, detailId?: string) {
	const board = new ResearchCanvasStore(library.databasePath).get(canvasId);
	if (!board) throw new Error("画布不存在");
	if (detailId) {
		const node = board.nodes.find((n) => n.id === detailId && n.kind === "paper");
		if (!node) throw new Error("论文节点不存在");
		const result = await resolveCanvasPaper(library, node);
		return {
			...result,
			nodeId: node.id,
			libraryPaperId: result.personal?.id,
			missingRelations: !board.edges.some((e) => e.from === node.id || e.to === node.id),
		};
	}
	const nodes = await Promise.all(
		board.nodes
			.filter((n) => n.kind === "paper" || n.kind === "author")
			.map(async (n) => {
				if (n.kind === "author")
					return { id: n.id, kind: n.kind, title: n.title, pinned: n.pinned, x: n.x, y: n.y };
				const { paper, personal } = await resolveCanvasPaper(library, n);
				return {
					id: n.id,
					kind: n.kind,
					title: n.alias || paper?.title || n.title,
					authors: paper?.authors ?? [],
					year: paper?.year,
					citationCount: paper?.citationCount,
					libraryPaperId: personal?.id,
					pinned: n.pinned,
					available: !!paper,
					x: n.x,
					y: n.y,
				};
			}),
	);
	const ids = new Set(nodes.map((n) => n.id));
	return {
		canvasId,
		revision: board.revision,
		nodes,
		edges: board.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
		state: new CanvasGraphStore(library.databasePath, canvasId).state(),
	};
}
