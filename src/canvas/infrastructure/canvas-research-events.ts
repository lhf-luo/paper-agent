import { EventEmitter } from "node:events";

const events = new EventEmitter();
events.setMaxListeners(0);
const key = (databasePath: string, canvasId: string) => JSON.stringify([databasePath, canvasId]);
export function emitCanvasResearchChange(databasePath: string, canvasId: string): void {
	// Notify after the database connection/transaction has finished; a disconnected
	// SSE consumer must never roll back a successful write or block another listener.
	queueMicrotask(() => {
		for (const listener of events.listeners(key(databasePath, canvasId))) {
			try {
				listener();
			} catch {
				/* A stale subscriber cannot invalidate a commit. */
			}
		}
	});
}
export function subscribeCanvasResearch(
	databasePath: string,

	canvasId: string,
	listener: () => void,
): () => void {
	const channel = key(databasePath, canvasId);
	events.on(channel, listener);
	return () => events.off(channel, listener);
}
