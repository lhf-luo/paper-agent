import { randomUUID } from "node:crypto";
import type { CanvasResearchAnalysis } from "../domain/canvas-research.ts";
import { relationLabels } from "../domain/canvas-research.ts";
import type { CanvasResearchService } from "./canvas-research-service.ts";

export async function previewPaperSelection(service: CanvasResearchService, paperIds: string[], reason: string) {
	const loaded = await Promise.all(paperIds.map((id) => service.library.getPaper(id)));
	if (loaded.some((p) => !p)) throw new Error("论文尚未成功入库，请等待入库完成后重试");
	const papers = [...new Map(loaded.map((p) => [p!.id, p!])).values()];
	const board = service.board();
	const bottom =
		Math.max(0, ...board.nodes.map((n) => n.y + n.height), ...(board.groups ?? []).map((g) => g.y + g.height)) + 100;
	const operations = papers.map((p, index) => ({
		id: randomUUID(),
		kind: "add_node",
		node: {
			id: randomUUID(),
			kind: "paper",
			entityId: p.id,
			title: p.title.slice(0, 300),
			x: 100 + (index % 4) * 320,
			y: bottom + Math.floor(index / 4) * 220,
			width: 260,
			height: 145,
		},
	}));
	return service.preview({ reason, operations });
}
export async function previewResearchRelations(service: CanvasResearchService, analysisId: string, reason: string) {
	const run = service.records.get<CanvasResearchAnalysis>("analysis", analysisId);
	if (!run || (await service.analysis(run.id)).freshness !== "current") throw new Error("请选择来源匹配的分析");
	const existing = service.board().edges;
	const suggestions = run.value.relations.filter(
		(r) =>
			!existing.some(
				(e) =>
					e.research?.type === r.relation.type &&
					((e.from === r.from && e.to === r.to) ||
						(["similar", "complements", "disagrees"].includes(r.relation.type) &&
							e.from === r.to &&
							e.to === r.from)),
			),
	);
	if (!suggestions.length) throw new Error("这些研究关系已在画布中，或本轮尚无关系建议");
	const operations = suggestions.map((r) => ({
		id: randomUUID(),
		kind: "add_edge",
		edge: { id: randomUUID(), from: r.from, to: r.to, label: relationLabels[r.relation.type], research: r.relation },
	}));
	return service.preview({ reason, analysisId, operations });
}
