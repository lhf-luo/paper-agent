import { GRAPH_ALGORITHM } from "../../src/canvas/domain/search-graph-relations.ts";
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceX,
	forceY,
	forceCollide,
	type SimulationNodeDatum,
} from "d3-force";
export interface LayoutNode extends SimulationNodeDatum {
	id: string;
	radius: number;
	pinned?: boolean;
	isSeed?: boolean;
}
export interface LayoutInput {
	nodes: LayoutNode[];
	edges: Array<{ from: string; to: string; score?: number; kind?: string }>;
	reset: boolean;
}
function components(input: LayoutInput): LayoutNode[][] {
	const byId = new Map(input.nodes.map((n) => [n.id, n])),
		adjacency = new Map(input.nodes.map((n) => [n.id, [] as string[]]));
	for (const e of input.edges)
		if (byId.has(e.from) && byId.has(e.to)) {
			adjacency.get(e.from)!.push(e.to);
			adjacency.get(e.to)!.push(e.from);
		}
	const seen = new Set<string>(),
		groups: LayoutNode[][] = [];
	for (const id of [...byId.keys()].sort()) {
		if (seen.has(id)) continue;
		const queue = [id],
			group: LayoutNode[] = [];
		seen.add(id);
		while (queue.length) {
			const next = queue.shift()!;
			group.push(byId.get(next)!);
			for (const other of adjacency.get(next)!)
				if (!seen.has(other)) {
					seen.add(other);
					queue.push(other);
				}
		}
		groups.push(group.sort((a, b) => a.id.localeCompare(b.id)));
	}
	const firstSeed = input.nodes.find((n) => n.isSeed)?.id;
	return groups.sort(
		(a, b) =>
			Number(b.some((n) => n.id === firstSeed)) - Number(a.some((n) => n.id === firstSeed)) ||
			b.length - a.length ||
			a[0].id.localeCompare(b[0].id),
	);
}
function simulate(group: LayoutNode[], input: LayoutInput) {
	const nodes = group.map((n) => ({
		...n,
		...((!input.reset && Number.isFinite(n.x)) || n.pinned
			? { fx: n.x, fy: n.y }
			: { x: undefined, y: undefined, fx: undefined, fy: undefined }),
	}));
	const ids = new Set(nodes.map((n) => n.id));
	const links = input.edges
		.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
		.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`))
		.map((e) => ({
			source: e.from,
			target: e.to,
			weight: Math.max(e.score ?? 0.35, e.kind === "citation" ? 0.35 : 0),
		}));
	let seed = 1729;
	const simulation = forceSimulation(nodes)
		.stop()
		.randomSource(() => {
			seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
			return seed / 4294967296;
		})
		.force("charge", forceManyBody().strength(-120))
		.force(
			"links",
			forceLink<LayoutNode, (typeof links)[number]>(links)
				.id((n) => n.id)
				.distance((e) => 160 - 100 * e.weight)
				.strength((e) => 0.08 + 0.42 * e.weight),
		)
		.force("x", forceX(0).strength(0.025))
		.force("y", forceY(0).strength(0.025))
		.force("collision", forceCollide<LayoutNode>((n) => n.radius + 8).iterations(2));
	simulation.tick(GRAPH_ALGORITHM.ticks);
	simulation.stop();
	return nodes;
}
interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}
function bounds(nodes: LayoutNode[]): Box {
	return {
		left: Math.min(...nodes.map((n) => n.x! - n.radius - 16)),
		right: Math.max(...nodes.map((n) => n.x! + n.radius + 16)),
		top: Math.min(...nodes.map((n) => n.y! - n.radius - 16)),
		bottom: Math.max(...nodes.map((n) => n.y! + n.radius + 16)),
	};
}
function overlaps(a: Box, b: Box) {
	return a.left < b.right + 16 && a.right > b.left - 16 && a.top < b.bottom + 16 && a.bottom > b.top - 16;
}
/** Worker-only, deterministic and bounded. Existing/manual positions are immutable anchors. */
export function staticGraphLayout(input: LayoutInput) {
	const groups = components(input).map((g) => simulate(g, input));
	const fixed = (nodes: LayoutNode[]) => nodes.some((n) => n.fx !== undefined && n.fx !== null);
	const occupied = groups.filter(fixed).map(bounds);
	const result: Record<string, { x: number; y: number }> = {};
	for (const nodes of groups) {
		if (!fixed(nodes)) {
			const box = bounds(nodes),
				seed = nodes.find((n) => n.id === input.nodes.find((n) => n.isSeed)?.id) ?? nodes.find((n) => n.isSeed);
			const cx = seed?.x ?? (box.left + box.right) / 2,
				cy = seed?.y ?? (box.top + box.bottom) / 2;
			let x = 0,
				y = 0;
			for (let i = 0; i < 10000; i++) {
				const radius = 14 * Math.sqrt(i),
					angle = i * 2.399963229728653;
				x = Math.cos(angle) * radius - cx;
				y = Math.sin(angle) * radius - cy;
				if (
					!occupied.some((b) =>
						overlaps(b, { left: box.left + x, right: box.right + x, top: box.top + y, bottom: box.bottom + y }),
					)
				)
					break;
			}
			for (const n of nodes) {
				n.x! += x;
				n.y! += y;
			}
			occupied.push(bounds(nodes));
		}
		for (const n of nodes) result[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
	}
	return result;
}
