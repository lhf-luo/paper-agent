import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import type { CanvasNode, ResearchCanvas } from "../domain/canvas-document.ts";
import type { CanvasResearchContext, CanvasResearchSettings } from "../domain/canvas-research.ts";
import type { CanvasResearchStore } from "../infrastructure/canvas-research-store.ts";

export interface CanvasResearchInventory {
	board: ResearchCanvas;
	nodes: CanvasNode[];
	paperIds: string[];
	sources: Record<string, string>;
	settings: CanvasResearchSettings;
	inputHash: string;
}

/** Shared input contract for analysis writing and projection; neither depends on the service implementation. */
export interface CanvasResearchHost {
	library: LiteratureStore;
	records: CanvasResearchStore;
	sessionId: string;
	currentRoundId?: string;
	board(): ResearchCanvas;
	context(): CanvasResearchContext;
	inventory(scope?: CanvasResearchContext, validateOwner?: boolean): Promise<CanvasResearchInventory>;
}
