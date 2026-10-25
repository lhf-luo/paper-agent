import type { CanvasRichContent } from "./canvas-rich-content.ts";

export type CanvasNodeKind = "paper" | "note" | "text" | "author" | "team" | "agent" | "search_graph";

export interface CanvasNode {
	id: string;
	kind: CanvasNodeKind;
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	alias?: string;
	content?: string;
	richContent?: CanvasRichContent;
	authorDetails?: { researchArea: string; organization: string; profileUrl?: string };
	teamDetails?: {
		institution: string;
		leaderName: string;
		researchAreas: string;
		homepageUrl?: string;
		members?: string[];
	};
	entityId?: string;
	groupId?: string;
	pinned?: boolean;
	generatedFrom?: { analysisId: string; snapshot?: boolean };
}

export interface CanvasGroup {
	id: string;
	title: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CanvasEdge {
	id: string;
	from: string;
	to: string;
	fromSide?: "left" | "right";
	toSide?: "left" | "right";
	label: string;
	evidence?: string;
	research?: CanvasResearchRelation;
}

export interface CanvasViewport {
	x: number;
	y: number;
	scale: number;
}

export interface ResearchCanvas {
	id: string;
	title: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	viewport: CanvasViewport;
	groups?: CanvasGroup[];
}

export interface ResearchCanvasSummary {
	id: string;
	title: string;
	revision: number;
	updatedAt: string;
	nodeCount: number;
}


export interface CanvasEvidence {
	paperId: string;
	sourceSha256?: string;
	page?: number;
	section?: string;
	quote?: string;
	noteId?: string;
	noteRevision?: number;
	level: "abstract" | "text" | "pdf" | "inference";
}
export interface CanvasResearchRelation {
	type: "cites" | "adopts" | "extends" | "similar" | "complements" | "disagrees";
	explanation: string;
	conditions: string;
	evidence: CanvasEvidence[];
	evidenceStatus: "candidate" | "supported" | "needs_review";
	reviewStatus: "pending" | "accepted" | "rejected";
	createdBy: string;
	analysisId?: string;
}
