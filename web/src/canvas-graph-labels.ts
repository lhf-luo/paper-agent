import { graphRadius, citationCap, type GraphNode, type GraphEdge, type CanvasGraphState } from "./canvas-graph-types.ts";
export interface GraphLabel {
	id: string;
	text: string;
	x: number;
	y: number;
	width: number;
	priority: number;
}
export function graphLabels(
	nodes: GraphNode[],
	edges: GraphEdge[],
	state: CanvasGraphState,
	width: number,
	height: number,
	selected?: string,
	hovered?: string,
): GraphLabel[] {
	const candidates = labelCandidates(nodes, edges, selected, hovered);
	const labels: GraphLabel[] = [];
	const cap = citationCap(nodes),
		maxLabels = Math.max(8, Math.min(80, Math.floor((width * height) / 8000) * Math.min(1, state.viewport.scale)));
	const circles = nodes.flatMap((n) => {
		const p = state.positions[n.id];
		return p
			? [
					{
						id: n.id,
						x: p.x * state.viewport.scale + state.viewport.x,
						y: p.y * state.viewport.scale + state.viewport.y,
						r: graphRadius(n.citationCount, cap) * state.viewport.scale + 2,
					},
				]
			: [];
	});
	for (const { n, text, priority } of candidates) {
		if (labels.length >= maxLabels && priority < 80000) continue;
		const p = state.positions[n.id];
		if (!p || (state.viewport.scale < 0.4 && priority < 80000 && labels.length > 12)) continue;
		const x = p.x * state.viewport.scale + state.viewport.x,
			y = p.y * state.viewport.scale + state.viewport.y;
		if (Math.abs(x) > width / 2 + 20 || Math.abs(y) > height / 2 + 20) continue;
		const w = [...text].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 11 : 6), 0) + 6;
		const radius = graphRadius(n.citationCount, cap) * state.viewport.scale;
		for (const [dx, dy] of [
			[-w / 2, -radius - 6],
			[-w / 2, radius + 15],
			[radius + 6, 4],
			[-w - radius - 6, 4],
			[-w / 2, -42],
			[-w / 2, 48],
		]) {
			const candidate = { id: n.id, text, x: x + dx, y: y + dy, width: w, priority };
			if (
				candidate.x < -width / 2 + 6 ||
				candidate.x + w > width / 2 - 6 ||
				candidate.y < -height / 2 + 15 ||
				candidate.y > height / 2 - 25
			)
				continue;
			if (
				priority < 80000 &&
				circles.some(
					(c) =>
						candidate.x < c.x + c.r &&
						candidate.x + w > c.x - c.r &&
						candidate.y - 11 < c.y + c.r &&
						candidate.y + 3 > c.y - c.r,
				)
			)
				continue;
			if (
				labels.some(
					(l) =>
						candidate.x < l.x + l.width + 3 &&
						candidate.x + w + 3 > l.x &&
						candidate.y - 12 < l.y + 5 &&
						candidate.y + 5 > l.y - 12,
				)
			)
				continue;
			labels.push(candidate);
			break;
		}
	}
	return labels;
}

function labelCandidates(nodes: GraphNode[], edges: GraphEdge[], selected?: string, hovered?: string) {
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	return nodes
		.map((n) => {
			const author = n.authors?.[0];
			const name = author?.includes(",") ? author.split(",")[0] : author?.trim().split(/\s+/).at(-1);
			const text = `${name ?? n.title.slice(0, 16)}, ${n.year ?? "?"}`;
			return {
				n,
				text,
				priority:
					n.id === selected ? 100000 : n.id === hovered ? 90000 : n.isSeed ? 80000 : (degree.get(n.id) ?? 0),
			};
		})
		.sort((a, b) => b.priority - a.priority || a.n.id.localeCompare(b.n.id));
}
