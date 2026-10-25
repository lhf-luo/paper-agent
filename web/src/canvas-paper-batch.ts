import type { CanvasEdge, CanvasNode, ResearchCanvas } from "../../src/canvas/domain/canvas-document.ts";
import type { PaperRecord } from "./types.ts";

export interface SelectedCanvasPaper {
	id: string;
	title: string;
}

export async function loadCanvasCollectionPapers(
	collectionId: string,
	loadPage: (path: string) => Promise<{ hits: Array<{ record: PaperRecord }>; total: number }>,
): Promise<PaperRecord[]> {
	const papers = new Map<string, PaperRecord>();
	let offset = 0;
	while (true) {
		const params = new URLSearchParams({ limit: "300", offset: String(offset) });
		if (collectionId !== "all") params.set("collection", collectionId);
		const page = await loadPage(`/api/library?${params.toString()}`);
		for (const hit of page.hits) papers.set(hit.record.id, hit.record);
		offset += page.hits.length;
		if (offset >= page.total) return [...papers.values()];
		if (!page.hits.length) throw new Error("分类论文未能完整加载，请重试");
	}
}

/** Build one edit so a paper selection is saved and undone as a batch. */
export function canvasPaperBatch(
	canvas: Pick<ResearchCanvas, "nodes" | "edges">,
	papers: SelectedCanvasPaper[],
	center: { x: number; y: number },
	origin?: { id: string; side: "left" | "right" },
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
	const unique = [...new Map(papers.map((paper) => [paper.id, paper])).values()];
	if (!unique.length) throw new Error("请先选择论文");
	if (canvas.nodes.length + unique.length > 500) {
		throw new Error(`画布最多支持 500 个节点，目前还可添加 ${Math.max(0, 500 - canvas.nodes.length)} 篇论文`);
	}
	const from = origin && canvas.nodes.find((node) => node.id === origin.id);
	if (from && canvas.edges.length + unique.length > 1000)
		throw new Error("添加后的连线超过画布 1000 条上限，请减少选择");
	const columns = Math.min(3, unique.length);
	const rows = Math.ceil(unique.length / columns);
	const nodes: CanvasNode[] = unique.map((paper, index) => ({
		id: crypto.randomUUID(),
		kind: "paper",
		entityId: paper.id,
		title: paper.title.slice(0, 300),
		width: 260,
		height: 145,
		x: center.x - (columns * 284 - 24) / 2 + (index % columns) * 284,
		y: center.y - (rows * 169 - 24) / 2 + Math.floor(index / columns) * 169,
	}));
	const edges: CanvasEdge[] = from
		? nodes.map((node) => ({
				id: crypto.randomUUID(),
				from: from.id,
				to: node.id,
				fromSide: origin!.side,
				label: from.kind === "team" ? "研究成果" : "",
			}))
		: [];
	return { nodes, edges };
}
