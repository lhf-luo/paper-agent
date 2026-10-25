import { createHash, randomUUID } from "node:crypto";
import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import { applyCanvasOperations, selectedChangeIds } from "../domain/canvas-changes.ts";
import {
	type CanvasNodeDraft,
	type CanvasNodeProposalInput,
	type CanvasNodeReference,
	placeCanvasNode,
} from "../domain/canvas-editing.ts";
import type {
	CanvasChangeOperation,
	CanvasChangeProposal,
	CanvasResearchContext,
	CanvasResearchRecord,
} from "../domain/canvas-research.ts";
import type { CanvasNode, ResearchCanvas } from "../domain/research-canvas.ts";
import type { CanvasResearchStore } from "../infrastructure/canvas-research-store.ts";
import { CanvasRevisionConflict } from "../infrastructure/research-canvas-store.ts";
import { scopedNodes } from "./canvas-research-materials.ts";

interface CanvasEditor {
	sessionId: string;
	library: Pick<LiteratureStore, "getPaper">;
	records: Pick<CanvasResearchStore, "get" | "save">;
	board(): ResearchCanvas;
	context(): CanvasResearchContext;
}
const hash = (value: unknown) =>
	createHash("sha256")
		.update(
			JSON.stringify(value, (_key, item) =>
				item && typeof item === "object" && !Array.isArray(item)
					? Object.fromEntries(
							Object.keys(item)
								.sort()
								.map((key) => [key, item[key]]),
						)
					: item,
			),
		)
		.digest("hex");

function editScope(editor: CanvasEditor, scope = editor.context(), owner = editor.sessionId) {
	const board = editor.board();
	if (owner !== "user" && !board.nodes.some((node) => node.kind === "agent" && node.entityId === owner))
		throw new Error("当前 Agent 会话未绑定此画布的节点");
	return { board, nodes: scopedNodes(board, scope, owner === "user" ? undefined : owner) };
}

async function makeNode(editor: CanvasEditor, draft: CanvasNodeDraft): Promise<Omit<CanvasNode, "x" | "y">> {
	const base = { id: randomUUID(), width: 260, height: 180 };
	if (draft.kind !== "paper" && !draft.title?.trim()) throw new Error("节点名称不能为空");
	if (draft.kind === "paper") {
		const paper = await editor.library.getPaper(draft.paper_id);
		if (!paper) throw new Error(`新增论文必须已在当前个人库：${draft.paper_id}`);
		return { ...base, kind: "paper", height: 145, entityId: paper.id, title: paper.title };
	}
	if (draft.kind === "text")
		return { ...base, kind: "text", width: 300, height: 200, title: draft.title.trim(), content: draft.content };
	if (draft.kind === "author")
		return {
			...base,
			kind: "author",
			title: draft.title.trim(),
			authorDetails: {
				researchArea: draft.research_area ?? "",
				organization: draft.organization ?? "",
				...(draft.profile_url ? { profileUrl: draft.profile_url } : {}),
			},
		};
	if (draft.kind === "team")
		return {
			...base,
			kind: "team",
			width: 300,
			height: 220,
			title: draft.title.trim(),
			teamDetails: {
				institution: draft.institution ?? "",
				leaderName: draft.leader_name ?? "",
				researchAreas: draft.research_areas ?? "",
				...(draft.homepage_url ? { homepageUrl: draft.homepage_url } : {}),
				...(draft.members ? { members: draft.members } : {}),
			},
		};
	throw new Error("节点编辑仅支持论文、作者、团队和文本卡");
}

function endpoint(ref: CanvasNodeReference, nodeIds: Record<string, string>, visible: Set<string>): string {
	if ("new_node" in ref) {
		const id = nodeIds[ref.new_node];
		if (!id) throw new Error(`未找到本批新节点：${ref.new_node}`);
		return id;
	}
	if (!visible.has(ref.node_id)) throw new Error(`连线端点不在当前工作范围：${ref.node_id}`);
	return ref.node_id;
}

function appendEdges(
	input: CanvasNodeProposalInput,
	operations: CanvasChangeOperation[],
	ids: Record<string, string>,
	visible: Set<string>,
	board: ResearchCanvas,
) {
	const seen = new Set(board.edges.map((edge) => hash([edge.from, edge.to, edge.label])));
	for (const draft of input.edges ?? []) {
		if (!draft.label.trim()) throw new Error("连线标签不能为空");
		const edge = {
			id: randomUUID(),
			from: endpoint(draft.from, ids, visible),
			to: endpoint(draft.to, ids, visible),
			label: draft.label.trim(),
			evidence: draft.evidence,
		};
		const signature = hash([edge.from, edge.to, edge.label]);
		if (seen.has(signature)) throw new Error("已有相同方向、标签的连线，请移除重复连线");
		seen.add(signature);
		const dependsOn = [draft.from, draft.to].flatMap((ref) => ("new_node" in ref ? [`node-${ref.new_node}`] : []));
		operations.push({ id: `edge-${edge.id}`, kind: "add_edge", edge, dependsOn: [...new Set(dependsOn)] });
	}
}

async function buildOperations(
	editor: CanvasEditor,
	input: CanvasNodeProposalInput,
	board: ResearchCanvas,
	visibleNodes: CanvasNode[],
) {
	const anchor = input.anchor_node_id
		? visibleNodes.find((node) => node.id === input.anchor_node_id)
		: (visibleNodes.find((node) => node.kind === "paper") ?? visibleNodes[0]);
	if (input.anchor_node_id && !anchor) throw new Error("定位节点不在当前工作范围");
	const operations: CanvasChangeOperation[] = [],
		occupied = [...board.nodes],
		warnings: string[] = [];
	const nodeIds: Record<string, string> = Object.create(null);
	for (const draft of input.nodes) {
		if (!/^[A-Za-z0-9_-]{1,75}$/.test(draft.key) || Object.hasOwn(nodeIds, draft.key))
			throw new Error("本批节点 key 无效或重复");
		const data = await makeNode(editor, draft);
		const node = { ...data, ...placeCanvasNode(occupied, anchor, data.width, data.height) };
		if (
			occupied.some(
				(existing) =>
					existing.kind === node.kind &&
					(node.kind === "paper"
						? existing.entityId === node.entityId
						: existing.title.trim().toLocaleLowerCase() === node.title.toLocaleLowerCase()),
			)
		)
			warnings.push(`已有相同类型和名称或论文来源的节点：${node.title}；请核对，未自动认定为同一对象。`);
		nodeIds[draft.key] = node.id;
		occupied.push(node);
		operations.push({ id: `node-${draft.key}`, kind: "add_node", node });
	}
	appendEdges(input, operations, nodeIds, new Set(visibleNodes.map((node) => node.id)), board);
	return { operations, warnings, nodeIds };
}

export async function proposeCanvasNodes(editor: CanvasEditor, input: CanvasNodeProposalInput) {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.request_id) || !input.reason.trim())
		throw new Error("请提供有效的 request_id 和变更理由");
	if (input.nodes.length > 50 || (input.edges?.length ?? 0) > 100 || (!input.nodes.length && !input.edges?.length))
		throw new Error("每批需要至少一项变更，最多 50 个节点和 100 条连线");
	const scope = editor.context();
	const { board, nodes } = editScope(editor, scope);
	const proposalId = `edit-${hash([editor.sessionId, input.request_id]).slice(0, 40)}`;
	const fingerprint = hash({ ...input, expected_revision: undefined });
	const prior = editor.records.get<CanvasChangeProposal>("proposal", proposalId);
	if (prior) return replayProposal(prior, fingerprint);
	if (board.revision !== input.expected_revision)
		throw new CanvasRevisionConflict("画布已变化，请重新读取概况并生成预览");
	const { operations, warnings, nodeIds } = await buildOperations(editor, input, board, nodes);
	applyCanvasOperations(
		board,
		operations,
		operations.map((op) => op.id),
	);
	if (editor.board().revision !== board.revision) throw new CanvasRevisionConflict("生成期间画布已变化，请重新预览");
	const value: CanvasChangeProposal = {
		purpose: "editing",
		reason: input.reason,
		baseRevision: board.revision,
		scope,
		operations,
		status: "pending",
		warnings,
		editRequest: { requestId: input.request_id, fingerprint, nodeIds },
	};
	try {
		return editor.records.save("proposal", value, editor.sessionId, proposalId);
	} catch (error) {
		const concurrent = editor.records.get<CanvasChangeProposal>("proposal", proposalId);
		if (concurrent) return replayProposal(concurrent, fingerprint);
		throw error;
	}
}

function replayProposal(record: CanvasResearchRecord<CanvasChangeProposal>, fingerprint: string) {
	if (record.value.editRequest?.fingerprint !== fingerprint)
		throw new Error("request_id 已用于其他内容；请为修改后的批次使用新标识");
	return record;
}

/** Recheck only selected sources. Ordinary editing is independent of research goals/PDF versions. */
export async function validateCanvasNodeProposal(
	editor: CanvasEditor,
	proposal: CanvasChangeProposal,
	selectedIds: string[],
	owner: string,
) {
	const { nodes } = editScope(editor, proposal.scope, owner);
	const visible = new Set(nodes.map((node) => node.id));
	const selected = new Set(selectedChangeIds(proposal.operations, selectedIds));
	const additions = new Set(
		proposal.operations.flatMap((op) => (selected.has(op.id) && op.kind === "add_node" ? [op.node.id] : [])),
	);
	for (const op of proposal.operations) {
		if (!selected.has(op.id)) continue;
		if (op.kind === "add_node" && op.node.kind === "paper" && !(await editor.library.getPaper(op.node.entityId!)))
			throw new Error("新增论文来源已删除，请重新生成预览");
		if (op.kind === "add_edge" && [op.edge.from, op.edge.to].some((id) => !visible.has(id) && !additions.has(id)))
			throw new Error("连线端点已离开本次工作范围，请重新预览");
	}
}
