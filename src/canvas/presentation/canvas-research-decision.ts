import type { CanvasResearchService } from "../application/canvas-research-service.ts";
import type { CanvasChangeProposal } from "../domain/canvas-research.ts";
import { subscribeCanvasResearch } from "../infrastructure/canvas-research-events.ts";

/** This waiter only observes human decisions; it has no write capability. */
export function waitForResearchDecision(
	service: CanvasResearchService,
	kind: "proposal",
	id: string,
	signal?: AbortSignal,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {};
		let finished = false;
		const finish = (value: unknown, error?: unknown) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", abort);
			error ? reject(error) : resolve(value);
		};
		const check = () => {
			try {
				const r = service.records.get<CanvasChangeProposal>(kind, id);
				if (r?.value.status === "pending") return;
				const value = r?.value;
				finish({
					id,
					status: value?.status ?? "deleted",
					...(value && "operations" in value
						? { selectedIds: value.selectedIds, appliedRevision: value.appliedRevision }
						: {}),
				});
			} catch (e) {
				finish(undefined, e);
			}
		};
		const abort = () => finish(undefined, new Error("已停止等待，待确认记录保留"));
		const timer = setTimeout(() => finish({ id, status: "pending", message: "尚未确认，可稍后继续" }), 300000);
		unsubscribe = subscribeCanvasResearch(service.library.databasePath, service.canvasId, check);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else check();
	});
}
