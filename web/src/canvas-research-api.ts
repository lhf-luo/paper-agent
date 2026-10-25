import type { CanvasResearchAnalysis, CanvasResearchRecord } from "../../src/canvas/domain/canvas-research";
import { api } from "./api";

export type AnalysisView = CanvasResearchRecord<CanvasResearchAnalysis> & {
	freshness: "current" | "stale";
	pendingPaperIds: string[];
	totalCards: number;
	coverage: Record<string, number>;
	nextOffset?: number;
};
export interface ResearchNode {
	id: string;
	title: string;
	alias?: string;
	kind: string;
	entityId?: string;
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface ResearchClient {
	get<T>(path: string, query?: Record<string, string | number>): Promise<T>;
	post<T>(path: string, body: Record<string, unknown>): Promise<T>;
	events(): EventSource;
}
export function researchClient(canvasId: string, sessionId?: string): ResearchClient {
	const base = `/api/canvases/${encodeURIComponent(canvasId)}/research/`;
	const params = new URLSearchParams({ ...(sessionId ? { sessionId } : {}) });
	return {
		get: (path, query = {}) =>
			api(`${base}${path}?${params}&${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`),
		post: (path, body) =>
			api(`${base}${path}`, {
				method: path === "settings" ? "PATCH" : "POST",
				body: JSON.stringify({ ...body, ...(sessionId ? { sessionId } : {}) }),
			}),
		events: () => new EventSource(`${base}events?${params}`),
	};
}
export const researchStatus: Record<string, string> = {
	running: "研究中",
	completed: "已完成",
	partial: "部分覆盖",
	stopped: "已停止",
	failed: "失败",
	interrupted: "已中断",
	pending: "待接受",
	approved: "已接受",
	rejected: "已拒绝",
	applied: "已应用",
	undone: "已撤销",
	unread: "未读",
	abstract: "摘要初筛",
	method: "方法取证",
	full: "全文研究",
	candidate: "候选／推断",
	supported: "正文支持",
	needs_review: "需要复核",
	accepted: "已接受",
};
