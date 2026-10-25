import type { CanvasNode } from "./research-canvas.ts";

interface DraftBase {
	key: string;
	title: string;
}
export type CanvasNodeDraft =
	| { key: string; kind: "paper"; paper_id: string }
	| (DraftBase & { kind: "text"; content: string })
	| (DraftBase & { kind: "author"; research_area?: string; organization?: string; profile_url?: string })
	| (DraftBase & {
			kind: "team";
			institution?: string;
			leader_name?: string;
			research_areas?: string;
			homepage_url?: string;
			members?: string[];
	  });
export type CanvasNodeReference = { new_node: string } | { node_id: string };
export interface CanvasEdgeDraft {
	from: CanvasNodeReference;
	to: CanvasNodeReference;
	label: string;
	evidence?: string;
}
export interface CanvasNodeProposalInput {
	request_id: string;
	expected_revision: number;
	reason: string;
	anchor_node_id?: string;
	nodes: CanvasNodeDraft[];
	edges?: CanvasEdgeDraft[];
}

export const editableNodeKinds = ["paper", "text", "author", "team"] as const;

function overlaps(a: Pick<CanvasNode, "x" | "y" | "width" | "height">, b: CanvasNode): boolean {
	return (
		a.x < b.x + b.width + 24 && a.x + a.width + 24 > b.x && a.y < b.y + b.height + 24 && a.y + a.height + 24 > b.y
	);
}

/** Deterministic placement preserves all existing positions, including pinned cards. */
export function placeCanvasNode(nodes: CanvasNode[], anchor: CanvasNode | undefined, width: number, height: number) {
	const directionX = (anchor?.x ?? 0) > 90000 ? -1 : 1;
	const directionY = (anchor?.y ?? 0) > 90000 ? -1 : 1;
	const startX = anchor ? anchor.x + (directionX > 0 ? anchor.width + 64 : -width - 64) : 0;
	const startY = anchor?.y ?? 0;
	for (let index = 0; index < 6000; index++) {
		const x = startX + Math.floor(index / 8) * (width + 64) * directionX;
		const y = startY + (index % 8) * (height + 40) * directionY;
		if (Math.abs(x) > 100000 || Math.abs(y) > 100000) continue;
		if (!nodes.some((node) => overlaps({ x, y, width, height }, node))) return { x, y };
	}
	throw new Error("没有找到可用的节点位置，请先整理画布空间");
}
