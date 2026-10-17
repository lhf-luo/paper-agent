import { useState } from "react";
import type {
	CanvasChangeOperation,
	CanvasChangeProposal,
	CanvasResearchRecord,
} from "../../src/canvas/domain/canvas-research";
import { useResearchAction } from "./canvas-research-action";
import { type AnalysisView, type ResearchClient, type ResearchNode, researchStatus } from "./canvas-research-api";

type Apply = (id: string, selected: string[], undo?: boolean) => Promise<void>;
export function proposalSelection(operations: CanvasChangeOperation[], selected: string[]): string[] {
	const result = new Set(selected);
	let changed = true;
	while (changed) {
		changed = false;
		for (const op of operations)
			if (result.has(op.id))
				for (const id of op.dependsOn ?? [])
					if (!result.has(id)) {
						result.add(id);
						changed = true;
					}
	}
	return [...result];
}
function operationLabel(op: CanvasChangeOperation, nodes: ResearchNode[]) {
	if (op.kind === "upsert_group") return `分组：${op.group.title}`;
	if (op.kind === "add_node") return `新增${op.node.kind === "paper" ? "论文" : "总结卡"}：${op.node.title}`;
	if (op.kind === "add_edge") return `关系：${op.edge.label || op.edge.research?.explanation || "连线"}`;
	return `移动：${nodes.find((n) => n.id === op.nodeId)?.title || op.nodeId}`;
}
function previewNodes(operations: CanvasChangeOperation[], nodes: ResearchNode[]) {
	const items = new Map(nodes.map((n) => [n.id, { ...n }]));
	for (const op of operations) {
		if (op.kind === "add_node") items.set(op.node.id, op.node);
		if (op.kind === "move_node") {
			const n = items.get(op.nodeId);
			if (n) items.set(n.id, { ...n, x: op.x, y: op.y });
		}
	}
	return items;
}
function ProposalMap({ operations, nodes }: { operations: CanvasChangeOperation[]; nodes: ResearchNode[] }) {
	const items = previewNodes(operations, nodes),
		all = [...items.values()];
	if (!all.length) return null;
	const left = Math.min(...all.map((n) => n.x)) - 40,
		top = Math.min(...all.map((n) => n.y)) - 40;
	const width = Math.max(...all.map((n) => n.x + n.width)) - left + 40,
		height = Math.max(...all.map((n) => n.y + n.height)) - top + 40;
	return (
		<svg
			className="canvas-research-map"
			viewBox={`${left} ${top} ${width} ${height}`}
			role="img"
			aria-label="所选变更后的布局预览"
		>
			{operations.map(
				(op) =>
					op.kind === "upsert_group" && (
						<g key={op.id}>
							<rect {...op.group} fill="none" stroke="#6fa99b" strokeDasharray="8 5" />
							<text x={op.group.x + 10} y={op.group.y + 24} fontSize="18">
								{op.group.title}
							</text>
						</g>
					),
			)}
			{operations.map((op) => {
				if (op.kind !== "add_edge") return null;
				const from = items.get(op.edge.from),
					to = items.get(op.edge.to);
				return from && to ? (
					<line
						key={op.id}
						x1={from.x + from.width / 2}
						y1={from.y + from.height / 2}
						x2={to.x + to.width / 2}
						y2={to.y + to.height / 2}
						stroke="#367567"
						strokeWidth="3"
					/>
				) : null;
			})}
			{all.map((n) => (
				<g key={n.id}>
					<rect x={n.x} y={n.y} width={n.width} height={n.height} rx="10" fill="white" stroke="#638b81" />
					<text x={n.x + 12} y={n.y + 28} fontSize="15">
						{n.title.slice(0, 28)}
					</text>
				</g>
			))}
		</svg>
	);
}
function ProposalSelection({
	operations,
	nodes,
	selected,
	setSelected,
}: {
	operations: CanvasChangeOperation[];
	nodes: ResearchNode[];
	selected: string[];
	setSelected: (s: string[]) => void;
}) {
	const required = proposalSelection(operations, selected);
	return (
		<>
			<ProposalMap operations={operations.filter((op) => required.includes(op.id))} nodes={nodes} />
			<label>
				<input
					type="checkbox"
					checked={selected.length === operations.length}
					onChange={(e) => setSelected(e.target.checked ? operations.map((op) => op.id) : [])}
				/>
				全部建议
			</label>
			<div className="canvas-research-node-checks">
				{operations.map((op) => (
					<label key={op.id}>
						<input
							type="checkbox"
							checked={required.includes(op.id)}
							disabled={!selected.includes(op.id) && required.includes(op.id)}
							onChange={(e) =>
								setSelected(e.target.checked ? [...selected, op.id] : selected.filter((id) => id !== op.id))
							}
						/>
						{operationLabel(op, nodes)}
						{!selected.includes(op.id) && required.includes(op.id) ? "（必要依赖）" : ""}
					</label>
				))}
			</div>
		</>
	);
}
function ProposalItem({
	record,
	nodes,
	apply,
}: {
	record: CanvasResearchRecord<CanvasChangeProposal>;
	nodes: ResearchNode[];
	apply: Apply;
}) {
	const p = record.value,
		action = useResearchAction();
	const [selected, setSelected] = useState(p.operations.map((op) => op.id));
	const required = proposalSelection(p.operations, selected);
	return (
		<article className="canvas-research-item">
			<strong>{p.reason}</strong>
			<p>
				{researchStatus[p.status]} · 画布版本 {p.baseRevision} ·{" "}
				{p.operations.filter((op) => op.kind === "move_node").length} 个移动 ·{" "}
				{new Date(record.createdAt).toLocaleString()}
			</p>
			{p.status === "pending" && (
				<>
					<ProposalSelection
						operations={p.operations}
						nodes={nodes}
						selected={selected}
						setSelected={setSelected}
					/>
					<button
						type="button"
						className="button"
						disabled={action.busy || !required.length}
						onClick={() => void action.perform(() => apply(record.id, required))}
					>
						应用所选 {required.length} 项
					</button>
				</>
			)}
			{p.status === "applied" && (
				<button
					type="button"
					disabled={action.busy}
					onClick={() => void action.perform(() => apply(record.id, [], true))}
				>
					撤销这一批变更
				</button>
			)}
			{p.warnings.map((w) => (
				<p key={w}>{w}</p>
			))}
			{action.error && <p role="alert">{action.error}</p>}
		</article>
	);
}
const layouts = [
	["methods", "方法分类"],
	["timeline", "技术演进"],
	["evidence", "问题—方法—证据"],
] as const;
function LayoutActions({ client, run, refresh }: { client: ResearchClient; run?: AnalysisView; refresh: () => void }) {
	const action = useResearchAction();
	const create = (layout?: string) =>
		action.perform(async () => {
			await client.post("proposals", {
				analysisId: run?.id,
				reason: layout ? `研究布局：${layouts.find((l) => l[0] === layout)?.[1]}` : "本轮有证据的关系建议",
				...(layout ? { layout } : { relations: true }),
			});
			refresh();
		});
	const disabled = action.busy || !run || run.freshness !== "current";
	return (
		<>
			<div className="button-row">
				{layouts.map(([layout, label]) => (
					<button type="button" key={layout} disabled={disabled} onClick={() => void create(layout)}>
						预览{label}
					</button>
				))}
				<button type="button" disabled={disabled || !run?.value.relations.length} onClick={() => void create()}>
					预览关系建议
				</button>
			</div>
			{action.error && <p role="alert">{action.error}</p>}
		</>
	);
}
export function ResearchProposals({
	client,
	records,
	nodes,
	run,
	apply,
	refresh,
}: {
	client: ResearchClient;
	records: CanvasResearchRecord<CanvasChangeProposal>[];
	nodes: ResearchNode[];
	run?: AnalysisView;
	apply: Apply;
	refresh: () => void;
}) {
	return (
		<>
			<LayoutActions client={client} run={run} refresh={refresh} />
			{records.map((r) => (
				<ProposalItem key={`${r.id}:${r.revision}`} record={r} nodes={nodes} apply={apply} />
			))}
			{!records.length && <p>暂无变更提案。</p>}
		</>
	);
}
