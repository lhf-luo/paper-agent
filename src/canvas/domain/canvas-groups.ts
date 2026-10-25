import { object, text } from "./canvas-research-validation.ts";
import type { CanvasGroup, CanvasNode } from "./canvas-document.ts";

export function parseCanvasGroups(input: unknown, nodes: CanvasNode[]): CanvasGroup[] | undefined {
	if (input === undefined) {
		if (nodes.some((node) => node.groupId)) throw new Error("节点关联的分组不存在");
		return undefined;
	}
	if (!Array.isArray(input) || input.length > 100) throw new Error("最多支持 100 个分组");
	const ids = new Set<string>();
	const groups = input.map((raw): CanvasGroup => {
		const v = object(raw);
		const id = text(v.id, 80);
		if (!/^[\w-]+$/.test(id) || ids.has(id)) throw new Error("分组 ID 无效或重复");
		ids.add(id);
		for (const key of ["x", "y", "width", "height"] as const) {
			if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || Math.abs(v[key]) > 100000)
				throw new Error("分组尺寸无效");
		}
		if (Number(v.width) < 160 || Number(v.height) < 80) throw new Error("分组尺寸过小");
		return {
			id,
			title: text(v.title, 300),
			x: Number(v.x),
			y: Number(v.y),
			width: Number(v.width),
			height: Number(v.height),
		};
	});
	if (nodes.some((node) => node.groupId && !ids.has(node.groupId))) throw new Error("节点关联的分组不存在");
	return groups;
}

export function parseNodeResearchFields(
	input: Record<string, unknown>,
): Pick<CanvasNode, "groupId" | "pinned" | "generatedFrom"> {
	if (input.pinned !== undefined && typeof input.pinned !== "boolean") throw new Error("固定位置设置无效");
	let generatedFrom: CanvasNode["generatedFrom"];
	if (input.generatedFrom !== undefined) {
		const value = object(input.generatedFrom);
		generatedFrom = {
			analysisId: text(value.analysisId, 80),
			...(value.snapshot === true ? { snapshot: true } : {}),
		};
	}
	return {
		...(input.groupId !== undefined ? { groupId: text(input.groupId, 80) } : {}),
		...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}),
		...(generatedFrom ? { generatedFrom } : {}),
	};
}
