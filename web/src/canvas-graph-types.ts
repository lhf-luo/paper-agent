import type { GraphRelation } from "../../src/canvas/domain/search-graph-relations.ts";
import type { CanvasGraphState } from "../../src/canvas/domain/canvas-graph.ts";
import type { CanvasEdge } from "../../src/canvas/domain/research-canvas.ts";
import type { PaperRecord } from "./types.ts";
export type { CanvasGraphState };
export interface GraphNode {
	id: string;
	isSeed?: boolean;
	kind: "paper" | "author";
	title: string;
	authors?: string[];
	year?: number;
	citationCount?: number;
	libraryPaperId?: string;
	runIds?: string[];
	pinned?: boolean;
	available?: boolean;
	x: number;
	y: number;
}
export type GraphEdge = CanvasEdge & Partial<Omit<GraphRelation, "id" | "from" | "to" | "label">>;
export interface GraphData {
	algorithmVersion?: string;
	inputFingerprint?: string;
	allRelations?: GraphEdge[];
	relationCoverage?: Record<string, { references: string; citations: string }>;
	failures?: Array<{ provider: string; message: string }>;
	citationExpansion?: { limitReached: boolean };
	canvasId: string;
	revision: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
	state: CanvasGraphState;
}
export interface GraphDetail {
	nodeId: string;
	paper?: PaperRecord;
	libraryPaperId?: string;
	missingRelations: boolean;
}
export function citationCap(nodes: GraphNode[]) {
	const counts = nodes
		.flatMap((n) => (n.citationCount === undefined ? [] : [Math.max(0, n.citationCount)]))
		.sort((a, b) => a - b);
	return counts[Math.max(0, Math.ceil(counts.length * 0.95) - 1)] ?? 1;
}
export function graphRadius(count?: number, cap = 1000): number {
	return count === undefined
		? 6
		: 6 + (14 * Math.log1p(Math.min(Math.max(0, count), Math.max(1, cap)))) / Math.log1p(Math.max(1, cap));
}
export function graphYearColor(year?: number, years: number[] = []): string {
	if (year === undefined) return "#87938f";
	const min = Math.min(...years),
		max = Math.max(...years);
	const ratio = max === min ? 0.5 : (year - min) / (max - min);
	return `rgb(${Math.round(212 - ratio * 204)}, ${Math.round(225 - ratio * 146)}, ${Math.round(225 - ratio * 148)})`;
}

export function fitGraphPositions(
	positions: CanvasGraphState["positions"],
	width = 1200,
	height = 800,
): CanvasGraphState["viewport"] {
	const values = Object.values(positions);
	if (!values.length) return { x: 0, y: 0, scale: 1 };
	const left = Math.min(...values.map((p) => p.x)),
		right = Math.max(...values.map((p) => p.x));
	const top = Math.min(...values.map((p) => p.y)),
		bottom = Math.max(...values.map((p) => p.y));
	const scale = Math.min(
		1.4,
		Math.max(40, width - 80) / (right - left + 40),
		Math.max(40, height - 80) / (bottom - top + 40),
	);
	return { x: (-(left + right) / 2) * scale, y: (-(top + bottom) / 2) * scale, scale };
}
