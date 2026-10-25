import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface CanvasResearchRuntime {
	extension: ExtensionFactory;
	prepare(input?: unknown, options?: { continueRound?: boolean }): Promise<string>;
	finish(status: "stopped" | "failed" | "interrupted" | "partial"): void;
}
