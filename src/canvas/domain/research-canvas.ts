import { parseCanvasGroups, parseNodeResearchFields } from "./canvas-groups.ts";
import type { CanvasResearchRelation } from "./canvas-research.ts";
import { parseRelation } from "./canvas-research-validation.ts";
import { type CanvasRichContent, parseCanvasRichContent, validCanvasUrl } from "./canvas-rich-content.ts";

export type CanvasNodeKind = "paper" | "note" | "text" | "author" | "team" | "agent";

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

export class CanvasDocumentError extends Error {}

export function validateCanvasDocument(
	value: unknown,
): Pick<ResearchCanvas, "title" | "nodes" | "edges" | "viewport" | "groups"> {
	try {
		return parseCanvasDocument(value);
	} catch (error) {
		throw new CanvasDocumentError(error instanceof Error ? error.message : String(error));
	}
}

function parseCanvasDocument(
	value: unknown,
): Pick<ResearchCanvas, "title" | "nodes" | "edges" | "viewport" | "groups"> {
	if (!value || typeof value !== "object") throw new Error("Invalid canvas document");
	const input = value as Record<string, unknown>;
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (!title || title.length > 120) throw new Error("Canvas title must be 1–120 characters");
	if (!Array.isArray(input.nodes) || input.nodes.length > 500) throw new Error("Canvas supports at most 500 nodes");
	if (!Array.isArray(input.edges) || input.edges.length > 1000)
		throw new Error("Canvas supports at most 1000 connections");
	const kinds: CanvasNodeKind[] = ["paper", "note", "text", "author", "team", "agent"];
	const ids = new Set<string>();
	const nodes: CanvasNode[] = input.nodes.map((raw) => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid canvas node");
		const node = raw as Record<string, unknown>;
		if (typeof node.id !== "string" || !/^[\w-]{1,80}$/.test(node.id) || ids.has(node.id))
			throw new Error("Invalid or duplicate node ID");
		ids.add(node.id);
		if (!kinds.includes(node.kind as CanvasNodeKind)) throw new Error("Invalid node kind");
		for (const key of ["x", "y", "width", "height"] as const) {
			if (typeof node[key] !== "number" || !Number.isFinite(node[key]) || Math.abs(node[key]) > 100000)
				throw new Error(`Invalid node ${key}`);
		}
		if (
			(node.width as number) < 160 ||
			(node.width as number) > 1000 ||
			(node.height as number) < 80 ||
			(node.height as number) > 1000
		)
			throw new Error("Invalid node size");
		if (typeof node.title !== "string" || node.title.length > 300) throw new Error("Invalid node title");
		if (node.alias !== undefined && (typeof node.alias !== "string" || node.alias.length > 300))
			throw new Error("Invalid node alias");
		if (node.content !== undefined && (typeof node.content !== "string" || node.content.length > 20000))
			throw new Error("Invalid node content");
		if (node.richContent !== undefined && node.kind !== "text")
			throw new Error("Only text nodes support rich content");
		const richContent = node.richContent === undefined ? undefined : parseCanvasRichContent(node.richContent);
		let authorDetails: CanvasNode["authorDetails"];
		if (node.authorDetails !== undefined) {
			if (node.kind !== "author" || !node.authorDetails || typeof node.authorDetails !== "object")
				throw new Error("Invalid author details");
			const details = node.authorDetails as Record<string, unknown>;
			if (
				typeof details.researchArea !== "string" ||
				details.researchArea.length > 300 ||
				typeof details.organization !== "string" ||
				details.organization.length > 300 ||
				(details.profileUrl !== undefined &&
					(typeof details.profileUrl !== "string" || !validCanvasUrl(details.profileUrl)))
			)
				throw new Error("Invalid author details");
			authorDetails = {
				researchArea: details.researchArea,
				organization: details.organization,
				...(typeof details.profileUrl === "string" ? { profileUrl: details.profileUrl } : {}),
			};
		}
		let teamDetails: CanvasNode["teamDetails"];
		if (node.teamDetails !== undefined) {
			if (node.kind !== "team" || !node.teamDetails || typeof node.teamDetails !== "object")
				throw new Error("Invalid team details");
			const details = node.teamDetails as Record<string, unknown>;
			if (
				typeof details.institution !== "string" ||
				details.institution.length > 300 ||
				typeof details.leaderName !== "string" ||
				details.leaderName.length > 300 ||
				typeof details.researchAreas !== "string" ||
				details.researchAreas.length > 500 ||
				(details.members !== undefined &&
					(!Array.isArray(details.members) ||
						details.members.length > 100 ||
						details.members.some(
							(member: unknown) =>
								typeof member !== "string" || member !== member.trim() || !member || member.length > 120,
						) ||
						new Set(details.members.map((member: string) => member.toLocaleLowerCase())).size !==
							details.members.length)) ||
				(details.homepageUrl !== undefined &&
					(typeof details.homepageUrl !== "string" || !validCanvasUrl(details.homepageUrl)))
			)
				throw new Error("Invalid team details");
			teamDetails = {
				institution: details.institution,
				leaderName: details.leaderName,
				researchAreas: details.researchAreas,
				...(typeof details.homepageUrl === "string" ? { homepageUrl: details.homepageUrl } : {}),
				...(Array.isArray(details.members) ? { members: details.members as string[] } : {}),
			};
		}
		if (node.kind === "paper" || node.kind === "note" || node.kind === "agent") {
			if (typeof node.entityId !== "string" || !node.entityId || node.entityId.length > 200)
				throw new Error("Linked node requires an entity ID");
		}
		return {
			...parseNodeResearchFields(node),
			id: node.id,
			kind: node.kind as CanvasNodeKind,
			x: node.x as number,
			y: node.y as number,
			width: node.width as number,
			height: node.height as number,
			title: node.title,
			...(typeof node.alias === "string" ? { alias: node.alias } : {}),
			...(typeof node.content === "string" ? { content: node.content } : {}),
			...(richContent ? { richContent } : {}),
			...(authorDetails ? { authorDetails } : {}),
			...(teamDetails ? { teamDetails } : {}),
			...(typeof node.entityId === "string" ? { entityId: node.entityId } : {}),
		};
	});
	const edgeIds = new Set<string>();
	const edges: CanvasEdge[] = input.edges.map((raw) => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid canvas connection");
		const edge = raw as Record<string, unknown>;
		if (typeof edge.id !== "string" || !/^[\w-]{1,80}$/.test(edge.id) || edgeIds.has(edge.id))
			throw new Error("Invalid or duplicate connection ID");
		edgeIds.add(edge.id);
		if (
			typeof edge.from !== "string" ||
			typeof edge.to !== "string" ||
			!ids.has(edge.from) ||
			!ids.has(edge.to) ||
			edge.from === edge.to
		)
			throw new Error("Connection endpoints must be distinct nodes on this canvas");
		if (typeof edge.label !== "string" || edge.label.length > 120) throw new Error("Invalid connection label");
		for (const side of ["fromSide", "toSide"] as const) {
			if (edge[side] !== undefined && edge[side] !== "left" && edge[side] !== "right")
				throw new Error(`Invalid connection ${side}`);
		}
		if (edge.evidence !== undefined && (typeof edge.evidence !== "string" || edge.evidence.length > 4000))
			throw new Error("Invalid connection evidence");
		return {
			id: edge.id,
			from: edge.from,
			to: edge.to,
			...(typeof edge.fromSide === "string" ? { fromSide: edge.fromSide as "left" | "right" } : {}),
			...(typeof edge.toSide === "string" ? { toSide: edge.toSide as "left" | "right" } : {}),
			label: edge.label,
			...(typeof edge.evidence === "string" ? { evidence: edge.evidence } : {}),
			...(edge.research !== undefined ? { research: parseRelation(edge.research) } : {}),
		};
	});
	if (!input.viewport || typeof input.viewport !== "object") throw new Error("Invalid canvas viewport");
	const viewport = input.viewport as Record<string, unknown>;
	if (
		typeof viewport.x !== "number" ||
		!Number.isFinite(viewport.x) ||
		Math.abs(viewport.x) > 100000 ||
		typeof viewport.y !== "number" ||
		!Number.isFinite(viewport.y) ||
		Math.abs(viewport.y) > 100000 ||
		typeof viewport.scale !== "number" ||
		!Number.isFinite(viewport.scale) ||
		viewport.scale < 0.2 ||
		viewport.scale > 3
	)
		throw new Error("Invalid canvas viewport");
	const groups = parseCanvasGroups(input.groups, nodes);
	return {
		title,
		nodes,
		edges,
		...(groups ? { groups } : {}),
		viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale },
	};
}
