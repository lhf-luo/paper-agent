import type { CanvasEdge, CanvasGroup, CanvasNode } from "./research-canvas.ts";

export type CanvasResearchScope = "canvas" | "selected" | "neighbors";
export interface CanvasResearchContext {
	scope: CanvasResearchScope;
	agentNodeId?: string;
	selectedNodeIds: string[];
}
export interface CanvasResearchSettings {
	question: string;
	scenario: string;
	include: string;
	exclude: string;
	dateFrom: string;
	dateTo: string;
	dimensions: string[];
	readingDepth: "layered" | "method" | "full";
	readingBudget: number;
	queryBudget: number;
	searchCallBudget: number;
	resultsPerProvider: number;
}
export const defaultResearchSettings: CanvasResearchSettings = {
	question: "",
	scenario: "",
	include: "",
	exclude: "",
	dateFrom: "",
	dateTo: "",
	dimensions: ["研究问题", "输入", "中间表示", "LLM 作用", "输出", "执行与验证", "实验条件", "局限"],
	readingDepth: "layered",
	readingBudget: 12,
	queryBudget: 4,
	searchCallBudget: 4,
	resultsPerProvider: 100,
};
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
export interface CanvasMethodCard {
	paperId: string;
	family: string;
	fields: Record<string, string>;
	coverage: "unread" | "abstract" | "method" | "full";
	evidence: CanvasEvidence[];
	unknowns: string[];
	pagesRead: number[];
	sectionsRead: string[];
}
export interface CanvasResearchGap {
	kind: "unread" | "unavailable" | "coverage" | "evidence";
	description: string;
	paperIds: string[];
}
export interface CanvasResearchAnalysis {
	roundId?: string;
	newlyReadPaperIds?: string[];
	status: "running" | "completed" | "partial" | "stopped" | "failed" | "interrupted";
	questionDraft?: string;
	scope: CanvasResearchContext;
	settings: CanvasResearchSettings;
	nodeIds: string[];
	paperIds: string[];
	inputHash: string;
	sources: Record<string, string>;
	cards: CanvasMethodCard[];
	summary: string;
	gaps: CanvasResearchGap[];
	nextSteps: string[];
	relations: Array<{ from: string; to: string; relation: CanvasResearchRelation }>;
	searchRunIds: string[];
	reusedPaperIds: string[];
	reusedDeepPaperIds?: string[];
	candidates?: Array<{ searchRunId: string; paperId: string; dimensions: string[]; reason: string }>;
}
export interface CanvasSearchPlan {
	analysisId: string;
	gap: string;
	reason: string;
	queries: string[];
	providers: string[];
	strategy: "keywords" | "citations" | "author";
	dateFrom: string;
	dateTo: string;
	callBudget: number;
	resultsPerProvider: number;
	status: "pending" | "approved" | "rejected";
	callsUsed: number;
	searchRunIds: string[];
}
export type CanvasChangeOperation =
	| { id: string; kind: "add_node"; node: CanvasNode; dependsOn?: string[] }
	| { id: string; kind: "move_node"; nodeId: string; x: number; y: number; groupId?: string; dependsOn?: string[] }
	| { id: string; kind: "add_edge"; edge: CanvasEdge; dependsOn?: string[] }
	| { id: string; kind: "upsert_group"; group: CanvasGroup; dependsOn?: string[] };
export interface CanvasChangeProposal {
	baseRevision: number;
	analysisId?: string;
	reason: string;
	operations: CanvasChangeOperation[];
	status: "pending" | "applied" | "undone";
	selectedIds?: string[];
	before?: unknown;
	after?: unknown;
	appliedRevision?: number;
	warnings: string[];
	sourceHash?: string;
	scope?: CanvasResearchContext;
}
export interface CanvasResearchRecord<T> {
	id: string;
	revision: number;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	value: T;
}
export const relationLabels: Record<CanvasResearchRelation["type"], string> = {
	cites: "引用",
	adopts: "采用",
	extends: "改进／扩展",
	similar: "方法相似",
	complements: "能力互补",
	disagrees: "结论分歧",
};
