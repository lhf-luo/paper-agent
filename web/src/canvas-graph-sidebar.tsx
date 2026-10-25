import type { RefObject } from "react";
import type { GraphNode } from "./canvas-graph-types";
export interface GraphFilters {
	query: string;
	year: string;
	batch: string;
	status: string;
}
function Filters({
	nodes,
	filters,
	onChange,
}: {
	nodes: GraphNode[];
	filters: GraphFilters;
	onChange: (key: keyof GraphFilters, value: string) => void;
}) {
	const years = [...new Set(nodes.flatMap((n) => (n.year === undefined ? [] : [n.year])))].sort((a, b) => b - a);
	const batches = [...new Set(nodes.flatMap((n) => n.runIds ?? []))];
	return (
		<div className="canvas-graph-filters">
			<select aria-label="年份" value={filters.year} onChange={(e) => onChange("year", e.target.value)}>
				<option value="">全部年份</option>
				{years.map((y) => (
					<option key={y}>{y}</option>
				))}
			</select>
			<select aria-label="入库状态" value={filters.status} onChange={(e) => onChange("status", e.target.value)}>
				<option value="">全部状态</option>
				<option value="library">已入库</option>
				<option value="candidate">候选</option>
			</select>
			{batches.length > 1 && (
				<select aria-label="来源批次" value={filters.batch} onChange={(e) => onChange("batch", e.target.value)}>
					<option value="">全部来源批次</option>
					{batches.map((b) => (
						<option key={b} value={b}>
							{b}
						</option>
					))}
				</select>
			)}
		</div>
	);
}
export function GraphSidebar({
	all,
	visible,
	selected,
	list,
	filters,
	onChange,
	onSelect,
}: {
	all: GraphNode[];
	visible: GraphNode[];
	selected?: string;
	list: RefObject<HTMLDivElement | null>;
	filters: GraphFilters;
	onChange: (key: keyof GraphFilters, value: string) => void;
	onSelect: (id: string) => void;
}) {
	return (
		<aside className="canvas-graph-list" aria-label="图谱论文列表">
			<input
				aria-label="搜索图谱论文"
				placeholder="搜索标题或作者"
				value={filters.query}
				onChange={(e) => onChange("query", e.target.value)}
			/>
			<Filters nodes={all} filters={filters} onChange={onChange} />
			<div ref={list} className="canvas-graph-paper-list">
				{visible
					.filter((n) => n.kind === "paper")
					.map((n) => (
						<button
							type="button"
							key={n.id}
							data-paper={n.id}
							aria-pressed={n.id === selected}
							onClick={() => onSelect(n.id)}
						>
							{n.isSeed && <small className="graph-seed-badge">起点论文</small>}
							<strong>{n.title}</strong>
							<small>{n.authors?.join("、")}</small>
							<small>
								{n.year ?? "年份未知"} · {n.libraryPaperId ? "已入库" : "候选"}
							</small>
						</button>
					))}
			</div>
		</aside>
	);
}
export function GraphNavigation({
	focused,
	selected,
	actions,
}: {
	focused: boolean;
	selected: boolean;
	actions: { list: () => void; detail: () => void; showAll: () => void };
}) {
	return (
		<nav className={`canvas-graph-navigation${focused ? " is-focused" : ""}`} aria-label="图谱浏览">
			<button type="button" className="graph-drawer-toggle" onClick={actions.list}>
				论文列表
			</button>
			{focused && (
				<button type="button" onClick={actions.showAll}>
					显示全部
				</button>
			)}
			{selected && (
				<button type="button" className="graph-drawer-toggle" onClick={actions.detail}>
					详情
				</button>
			)}
		</nav>
	);
}
