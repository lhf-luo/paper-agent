import { useCallback, useMemo, useRef, useState } from "react";
import { CanvasGraphNetwork } from "./canvas-graph-network";
import { CanvasGraphDetail } from "./canvas-graph-detail";
import { GraphSidebar, GraphNavigation, type GraphFilters } from "./canvas-graph-sidebar";
import { useGraphFocus, useGraphSelection } from "./canvas-graph-focus";
import { fitGraphPositions, type GraphData } from "./canvas-graph-types";
import { useCanvasGraph } from "./use-canvas-graph";
import "./canvas-graph.css";
function filterNodes(data: GraphData | undefined, filters: GraphFilters, focus?: string) {
	if (!data) return [];
	const { query, year, batch, status } = filters;
	const neighborhood = new Set([
		focus,
		...data.edges.flatMap((e) => (e.from === focus ? [e.to] : e.to === focus ? [e.from] : [])),
	]);
	return data.nodes.filter(
		(n) =>
			n.isSeed ||
			((!focus || neighborhood.has(n.id)) &&
				(!query || `${n.title} ${n.authors?.join(" ")}`.toLowerCase().includes(query.toLowerCase())) &&
				(!year || String(n.year) === year) &&
				(!batch || n.runIds?.includes(batch)) &&
				(!status || (status === "library" ? !!n.libraryPaperId : n.kind === "paper" && !n.libraryPaperId))),
	);
}
interface GraphProps {
	canvasId: string;
	runId?: string;
	refreshKey?: string;
	revision: number;
	initialFocus?: string;
	initialSelection?: string;
	onRead: (id: string) => void;
}
function useGraphView({ canvasId, runId, refreshKey, revision, initialFocus, initialSelection, onRead }: GraphProps) {
	const [refresh, setRefresh] = useState(0),
		graph = useCanvasGraph(canvasId, revision, refresh, runId, refreshKey),
		{ data, state, change } = graph;
	const filters: GraphFilters = state?.filters ?? { query: "", year: "", batch: "", status: "" };
	const [drawer, setDrawer] = useState<"list" | "detail" | undefined>();
	const list = useRef<HTMLDivElement>(null),
		[focus, setFocus] = useGraphFocus(initialFocus, state, change);
	const [selected, setSelected] = useGraphSelection(
		initialSelection ??
			(!Object.keys(state?.positions ?? {}).length ? data?.nodes.find((n) => n.isSeed)?.id : undefined),
		initialFocus,
		state,
		change,
		list,
	);
	const onImported = useCallback(() => setRefresh((v) => v + 1), []),
		visible = useMemo(() => filterNodes(data, filters, focus), [data, focus, filters]);

	const selectedNode = data?.nodes.find((n) => n.id === selected);
	const actions = {
		list: () => setDrawer(drawer === "list" ? undefined : "list"),
		detail: () => setDrawer(drawer === "detail" ? undefined : "detail"),
		showAll: () => {
			setFocus(undefined);
			if (state) change({ ...state, focusId: undefined, viewport: fitGraphPositions(state.positions) });
		},
	};
	return {
		canvasId,
		runId,
		data,
		state,
		graph,
		change,
		filters,
		setFilters: (update: (s: GraphFilters) => GraphFilters) => {
			if (state) change({ ...state, filters: update(filters) });
		},
		drawer,
		setDrawer,
		list,
		focus,
		selected,
		setSelected,
		onImported,
		visible,
		selectedNode,
		actions,
		refresh,
		onRead,
	};
}
type ViewModel = ReturnType<typeof useGraphView> & {
	data: GraphData;
	state: import("./canvas-graph-types").CanvasGraphState;
};
function GraphCenter({ model: m }: { model: ViewModel }) {
	const years = m.data.nodes.flatMap((n) => (n.year === undefined ? [] : [n.year])).sort((a, b) => a - b);
	return (
		<div className="canvas-graph-center">
			<CanvasGraphNetwork
				nodes={m.visible}
				allNodes={m.data.nodes}
				allRelations={m.data.allRelations}
				edges={m.data.edges}
				state={m.state}
				selected={m.selected}
				onSelect={(id) => {
					m.setSelected(id);
					m.setDrawer("detail");
				}}
				onChange={m.change}
			/>
			{m.runId && (
				<details className="graph-information">
					<summary aria-label="关系与覆盖说明">i</summary>
					<p>细线表示真实引用或已观测的引文关联；聚簇和距离不代表方法相似。</p>
					<p>文献耦合：共享参考文献；共被引：共享施引论文。紫环表示起点论文。</p>
					<p>
						{m.visible.filter((n) => !n.isSeed).length} 篇结果 + {m.visible.filter((n) => n.isSeed).length}{" "}
						篇起点；完整图谱 {m.data.nodes.length} 篇。
					</p>
					<p>
						完整引文集合：
						{
							Object.values(m.data.relationCoverage ?? {})
								.flatMap((c) => [c.references, c.citations])
								.filter((s) => s === "complete").length
						}{" "}
						/ {m.data.nodes.length * 2}。缺失或部分覆盖不代表没有引用。
					</p>
					<p>需要更多关系时，可在图谱管理中主动补全。算法：{m.data.algorithmVersion}</p>
				</details>
			)}
			{!m.data.nodes.length && <p className="graph-empty">{m.runId ? "本次搜索没有结果" : "暂无论文"}</p>}
			<div className="canvas-graph-legend">
				<span className="graph-year-gradient">
					年份：{years[0] ?? "未知"} — {years.at(-1) ?? "未知"}
				</span>
				{!m.runId && <span>→ 引用　┄ 研究　— 人工</span>}
			</div>
		</div>
	);
}
function GraphDetailSlot({ model: m }: { model: ViewModel }) {
	if (!m.selectedNode) return <aside className="canvas-graph-detail graph-detail-empty">选择论文查看摘要与来源</aside>;
	return (
		<CanvasGraphDetail
			key={`${m.selectedNode.id}:${m.refresh}`}
			canvasId={m.canvasId}
			runId={m.runId}
			node={m.selectedNode}
			relations={m.data.allRelations}
			onRead={m.onRead}
			onImported={m.onImported}
			onClose={() => {
				m.setSelected(undefined);
				m.setDrawer(undefined);
			}}
		/>
	);
}
function GraphContent({ model: m }: { model: ViewModel }) {
	return (
		<section className={`canvas-graph-view ${m.drawer ? `drawer-${m.drawer}` : ""}`}>
			<div className="canvas-graph-toolbar">
				<GraphNavigation focused={!!m.focus} selected={!!m.selectedNode} actions={m.actions} />
				{m.runId && (!!m.data.failures?.length || m.data.citationExpansion?.limitReached) && (
					<output className="search-graph-status">
						{[...new Map(m.data.failures?.map((f) => [`${f.provider}:${f.message}`, f])).values()].map((f) => (
							<span key={`${f.provider}:${f.message}`}>
								{f.provider}：{f.message}
							</span>
						))}
						{m.data.citationExpansion?.limitReached && <span>已达到本次检索上限</span>}
					</output>
				)}
			</div>
			<GraphSidebar
				all={m.data.nodes}
				visible={m.visible}
				selected={m.selected}
				list={m.list}
				filters={m.filters}
				onChange={(key, value) => m.setFilters((s) => ({ ...s, [key]: value }))}
				onSelect={(id) => {
					m.setSelected(id);
					m.setDrawer(undefined);
				}}
			/>
			<GraphCenter model={m} />
			<GraphDetailSlot model={m} />
			{m.graph.error && (
				<p className="canvas-graph-error" role="alert">
					{m.graph.error}
				</p>
			)}
		</section>
	);
}
export function CanvasGraphView(props: GraphProps) {
	const model = useGraphView(props);
	if (!model.data || !model.state)
		return <div className="canvas-graph-loading">{model.graph.error || "正在加载图谱…"}</div>;
	return <GraphContent model={{ ...model, data: model.data, state: model.state }} />;
}
