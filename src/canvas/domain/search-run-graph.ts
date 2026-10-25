import type { CanvasGraphState } from "./canvas-graph.ts";

/** A search result view is independent of the relationship canvas document. */
export interface SearchRunGraph {
	runId: string;
	title: string;
	sessionId: string;
	filterResultId?: string;
	openedAt: string;
	closed: boolean;
	state: CanvasGraphState;
}
