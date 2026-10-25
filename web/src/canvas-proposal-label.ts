import type { CanvasChangeOperation } from "../../src/canvas/domain/canvas-research.ts";

export function operationLabel(op: CanvasChangeOperation, nodes: Array<{ id: string; title: string }>) {
	if (op.kind === "upsert_group") return `分组：${op.group.title}`;
	if (op.kind === "add_node") {
		const label = {
			paper: "论文",
			text: op.node.generatedFrom ? "总结卡" : "文本",
			author: "作者",
			team: "团队",
			note: "笔记",
			agent: "Agent",
			search_graph: "搜索图谱",
		}[op.node.kind];
		return `新增${label}：${op.node.title}`;
	}
	if (op.kind === "add_edge") return `关系：${op.edge.label || op.edge.research?.explanation || "连线"}`;
	return `移动：${nodes.find((node) => node.id === op.nodeId)?.title || op.nodeId}`;
}
