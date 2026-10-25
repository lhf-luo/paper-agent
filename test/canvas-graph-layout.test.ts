import { expect, it } from "vitest";
import { staticGraphLayout, type LayoutInput } from "../web/src/canvas-graph-layout.ts";

it("statically lays out 300 papers and 1000 edges without mutating inputs, preserving existing positions on incremental additions", () => {
	const input: LayoutInput = {
		reset: true,
		nodes: Array.from({ length: 300 }, (_, i) => ({
			id: `n${i}`,
			radius: 12,
			...(i === 0 ? { x: 0, y: 0, pinned: true } : {}),
		})),
		edges: Array.from({ length: 1000 }, (_, i) => ({ from: `n${i % 300}`, to: `n${(i * 7 + 1) % 300}` })),
	};
	const before = structuredClone(input),
		start = performance.now(),
		positions = staticGraphLayout(input);
	expect(performance.now() - start).toBeLessThan(5000);
	expect(input).toEqual(before);
	expect(Object.keys(positions)).toHaveLength(300);
	expect(Object.values(positions).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
	expect(positions.n0).toEqual({ x: 0, y: 0 });
	const next = staticGraphLayout({
		...input,
		reset: false,
		nodes: [...input.nodes.map((n) => ({ ...n, ...positions[n.id] })), { id: "new", radius: 12 }],
	});
	for (const [id, p] of Object.entries(positions)) expect(next[id]).toEqual(p);
});

it.each([20, 60, 300])(
	"produces reproducible component layouts for %i nodes, retaining isolates and the first seed",
	(count) => {
		const input: LayoutInput = {
			reset: true,
			nodes: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, radius: 6 + (i % 15), isSeed: i === 0 })),
			edges: Array.from({ length: count - 3 }, (_, i) => ({
				from: `p${i}`,
				to: `p${i + 1}`,
				score: 0.5,
				kind: "association",
			})),
		};
		const first = staticGraphLayout(input),
			second = staticGraphLayout({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
		expect(first).toEqual(second);
		expect(first.p0).toEqual({ x: 0, y: 0 });
		expect(Object.keys(first)).toHaveLength(count);
		for (const n of input.nodes)
			for (const other of input.nodes)
				if (n.id < other.id)
					expect(Math.hypot(first[n.id].x - first[other.id].x, first[n.id].y - first[other.id].y)).toBeGreaterThan(
						n.radius + other.radius - 1,
					);
	},
);
