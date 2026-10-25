import { editableNodeKinds } from "./canvas-editing.ts";
import type { CanvasChangeOperation } from "./canvas-research.ts";
import { array, object, strings, text } from "./canvas-research-validation.ts";
import { type ResearchCanvas, validateCanvasDocument } from "./research-canvas.ts";

export function parseChangeOperations(input: unknown): CanvasChangeOperation[] {
	const ids = new Set<string>();
	return array(
		input,
		(raw) => {
			const v = object(raw);
			const id = text(v.id, 80);
			if (!/^[\w-]+$/.test(id) || ids.has(id)) throw new Error("变更 ID 无效或重复");
			ids.add(id);
			const dependsOn = strings(v.dependsOn ?? [], 1000);
			if (v.kind === "add_node")
				return { id, kind: v.kind, node: object(v.node), dependsOn } as unknown as CanvasChangeOperation;
			if (v.kind === "add_edge")
				return { id, kind: v.kind, edge: object(v.edge), dependsOn } as unknown as CanvasChangeOperation;
			if (v.kind === "upsert_group")
				return { id, kind: v.kind, group: object(v.group), dependsOn } as unknown as CanvasChangeOperation;
			if (v.kind === "move_node") {
				if (![v.x, v.y].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100000))
					throw new Error("位置无效");
				return {
					id,
					kind: v.kind,
					nodeId: text(v.nodeId, 80),
					x: Number(v.x),
					y: Number(v.y),
					...(v.groupId !== undefined ? { groupId: text(v.groupId, 80) } : {}),
					dependsOn,
				};
			}
			throw new Error("不支持的画布变更");
		},
		1000,
	);
}

export function selectedChangeIds(operations: CanvasChangeOperation[], selectedIds: string[]): string[] {
	const byId = new Map(operations.map((op) => [op.id, op]));
	const result = new Set<string>();
	const add = (id: string) => {
		if (result.has(id)) return;
		const op = byId.get(id);
		if (!op) throw new Error(`变更或依赖不存在：${id}`);
		result.add(id);
		for (const dependency of op.dependsOn ?? []) add(dependency);
	};
	for (const id of selectedIds) add(id);
	if (!result.size) throw new Error("请先选择变更");
	return [...result].sort();
}

export function applyCanvasOperations(board: ResearchCanvas, operations: CanvasChangeOperation[], selection: string[]) {
	const selected = new Set(selectedChangeIds(operations, selection));
	const next = structuredClone(board);
	const pending = operations.filter((op) => selected.has(op.id));
	const applied = new Set<string>();
	while (pending.length) {
		const index = pending.findIndex((op) => (op.dependsOn ?? []).every((id) => applied.has(id)));
		if (index < 0) throw new Error("变更依赖存在循环");
		const [op] = pending.splice(index, 1);
		applyOperation(next, op);
		applied.add(op.id);
	}
	return validateCanvasDocument(next);
}

function applyOperation(board: ResearchCanvas, op: CanvasChangeOperation): void {
	if (op.kind === "add_node") {
		if (!(editableNodeKinds as readonly string[]).includes(op.node.kind))
			throw new Error("节点提案仅支持论文、作者、团队和文本卡");
		if (board.nodes.some((n) => n.id === op.node.id)) throw new Error("节点 ID 已存在");
		board.nodes.push(structuredClone(op.node));
	} else if (op.kind === "move_node") {
		const node = board.nodes.find((n) => n.id === op.nodeId);
		if (!node) throw new Error("移动节点不存在");
		if (node.pinned) throw new Error("固定节点不能自动移动");
		if (node.kind !== "paper" && !(node.kind === "text" && node.generatedFrom))
			throw new Error("自动布局只能移动论文和研究总结卡");
		Object.assign(node, { x: op.x, y: op.y }, op.groupId !== undefined ? { groupId: op.groupId } : {});
	} else if (op.kind === "upsert_group") {
		board.groups = [...(board.groups ?? []).filter((g) => g.id !== op.group.id), structuredClone(op.group)];
	} else {
		if (board.edges.some((e) => e.id === op.edge.id)) throw new Error("连线 ID 已存在");
		const type = op.edge.research?.type;
		const symmetric = type && ["similar", "complements", "disagrees"].includes(type);
		const duplicate = board.edges.some(
			(e) =>
				e.research?.type === type &&
				type &&
				((e.from === op.edge.from && e.to === op.edge.to) ||
					(symmetric && e.from === op.edge.to && e.to === op.edge.from)),
		);
		if (duplicate) throw new Error("同类型研究关系已存在");
		const edge = structuredClone(op.edge);
		if (edge.research) edge.research.reviewStatus = "accepted";
		board.edges.push(edge);
	}
}

/** Invert only affected objects; unrelated subsequent edits and the viewport survive undo. */
export function undoCanvasChanges(current: ResearchCanvas, before: ResearchCanvas, after: ResearchCanvas) {
	const next = structuredClone(current);
	for (const field of ["nodes", "edges", "groups"] as const) {
		const original = new Map((before[field] ?? []).map((item) => [item.id, item]));
		const changed = new Map((after[field] ?? []).map((item) => [item.id, item]));
		const ids = new Set([...original.keys(), ...changed.keys()]);
		for (const id of ids) {
			if (JSON.stringify(original.get(id)) === JSON.stringify(changed.get(id))) continue;
			const actual = (next[field] ?? []).find((item) => item.id === id);
			if (JSON.stringify(actual) !== JSON.stringify(changed.get(id)))
				throw new Error(`撤销冲突：${id} 已有后续修改`);
			const index = (next[field] ?? []).findIndex((item) => item.id === id);
			const items = (next[field] ?? []).filter((item) => item.id !== id);
			const old = original.get(id);
			if (old) {
				const position = index >= 0 ? index : [...original.keys()].indexOf(id);
				items.splice(Math.min(position, items.length), 0, old);
			}
			Object.assign(next, { [field]: items });
		}
	}
	return validateCanvasDocument(next);
}
