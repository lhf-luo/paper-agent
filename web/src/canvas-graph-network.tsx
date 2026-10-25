import { useId, useMemo, useRef, useState } from "react";
import {
	graphRadius,
	graphYearColor,
	citationCap,
	type GraphNode,
	type GraphEdge,
	type CanvasGraphState,
} from "./canvas-graph-types";
import { useNetworkInteraction } from "./canvas-graph-interaction";
import { graphLabels } from "./canvas-graph-labels";
interface NetworkProps {
	nodes: GraphNode[];
	allNodes?: GraphNode[];
	edges: GraphEdge[];
	allRelations?: GraphEdge[];
	state: CanvasGraphState;
	selected?: string;
	onSelect: (id: string) => void;
	onChange: (state: CanvasGraphState) => void;
}
function GraphEdges({
	edges,
	state,
	active,
	marker,
	cap,
	nodes,
}: {
	edges: GraphEdge[];
	state: CanvasGraphState;
	active?: string;
	marker: string;
	cap: number;
	nodes: GraphNode[];
}) {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	return edges.map((e) => {
		const a = state.positions[e.from],
			b = state.positions[e.to];
		if (!a || !b) return null;
		const adjacent = e.from === active || e.to === active,
			d = Math.hypot(b.x - a.x, b.y - a.y) || 1,
			r = graphRadius(byId.get(e.to)?.citationCount, cap) + 3;
		return (
			<line
				key={e.id}
				x1={a.x}
				y1={a.y}
				x2={b.x - ((b.x - a.x) / d) * r}
				y2={b.y - ((b.y - a.y) / d) * r}
				className={`graph-edge ${e.kind ? "discovery" : e.research ? "research" : "manual"}`}
				vectorEffect="non-scaling-stroke"
				opacity={active ? (adjacent ? 0.7 : 0.06) : 0.2}
				markerEnd={
					adjacent && e.kind === "citation" ? `url(#${marker})` : undefined
				}
			>
				<title>
					{e.label}
					{e.score !== undefined ? ` · ${e.score.toFixed(3)}` : ""}
				</title>
			</line>
		);
	});
}
function GraphNodes({
	nodes,
	state,
	active,
	selected,
	neighbors,
	years,
	cap,
	onSelect,
	onHover,
}: {
	nodes: GraphNode[];
	state: CanvasGraphState;
	active?: string;
	selected?: string;
	neighbors: Set<string>;
	years: number[];
	cap: number;
	onSelect: NetworkProps["onSelect"];
	onHover: (id?: string) => void;
}) {
	return nodes.map((n) => {
		const p = state.positions[n.id];
		if (!p) return null;
		const r = graphRadius(n.citationCount, cap);
		return (
			// biome-ignore lint/a11y/useSemanticElements: SVG node supports keyboard activation.
			<g
				key={n.id}
				data-node={n.id}
				role="button"
				tabIndex={0}
				aria-label={n.title}
				aria-pressed={n.id === selected}
				transform={`translate(${p.x} ${p.y})`}
				opacity={active && neighbors.size && n.id !== active && !neighbors.has(n.id) ? 0.2 : 1}
				onPointerEnter={() => onHover(n.id)}
				onPointerLeave={() => onHover(undefined)}
				onKeyDown={(e) => activateNode(e, () => onSelect(n.id))}
			>
				<title>
					{n.isSeed ? "起点论文 · " : ""}
					{n.title}
				</title>
				{n.isSeed && (
					<circle r={r + 4} fill="none" stroke="#975393" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
				)}
				<circle
					r={r}
					fill={n.kind === "author" ? "#eee3cc" : graphYearColor(n.year, years)}
					stroke={n.id === selected ? "#132f29" : "#ffffff"}
					strokeWidth={n.id === selected ? 2 : 0.5}
					vectorEffect="non-scaling-stroke"
				/>
			</g>
		);
	});
}
export function CanvasGraphNetwork(props: NetworkProps) {
	const { nodes, allNodes = nodes, state, selected, onSelect, onChange } = props,
		svg = useRef<SVGSVGElement>(null),
		marker = useId();
	const [hovered, setHovered] = useState<string>();
	const { size, events } = useNetworkInteraction(svg, state, onChange, onSelect);
	const active = hovered ?? selected;
	const edges = useDisplayedEdges(nodes, props.edges, props.allRelations, active);
	const neighbors = new Set(edges.flatMap((e) => (e.from === active ? [e.to] : e.to === active ? [e.from] : [])));
	const years = allNodes.flatMap((n) => (n.year === undefined ? [] : [n.year])),
		cap = citationCap(allNodes);
	const labels = graphLabels(nodes, edges, state, size.width, size.height, selected, hovered);
	return (
		<svg
			ref={svg}
			className="canvas-graph-network"
			viewBox={`${-size.width / 2} ${-size.height / 2} ${size.width || 1} ${size.height || 1}`}
			role="img"
			aria-label="论文引文关系图谱"
			{...events}
		>
			<title>论文引文关系；距离不代表方法或语义相似度</title>
			<defs>
				<marker
					id={marker}
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="#728c84" />
				</marker>
			</defs>
			<g transform={`translate(${state.viewport.x} ${state.viewport.y}) scale(${state.viewport.scale})`}>
				<GraphEdges
					edges={edges}
					nodes={nodes}
					state={state}
					active={neighbors.size ? active : undefined}
					marker={marker}
					cap={cap}
				/>
				<GraphNodes
					nodes={nodes}
					state={state}
					active={active}
					selected={selected}
					neighbors={neighbors}
					years={years}
					cap={cap}
					onSelect={onSelect}
					onHover={setHovered}
				/>
			</g>
			<g className="graph-screen-labels">
				{labels.map((l) => (
					<text key={l.id} x={l.x} y={l.y} style={{ fontSize: 11 }}>
						{l.text}
					</text>
				))}
			</g>
		</svg>
	);
}

function useDisplayedEdges(nodes: GraphNode[], initial: GraphEdge[], all: GraphEdge[] | undefined, active?: string) {
	return useMemo(() => {
		const ids = new Set(nodes.map((n) => n.id)),
			merged = new Map(initial.map((e) => [e.id, e]));
		if (active) for (const e of all ?? []) if (e.from === active || e.to === active) merged.set(e.id, e);
		return [...merged.values()].filter((e) => ids.has(e.from) && ids.has(e.to));
	}, [nodes, initial, all, active]);
}

function activateNode(e: React.KeyboardEvent, select: () => void) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		select();
	}
}
