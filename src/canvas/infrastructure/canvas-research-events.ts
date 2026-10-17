import { EventEmitter } from "node:events";

const events = new EventEmitter();
events.setMaxListeners(0);
const key = (databasePath: string, namespace: string, canvasId: string) =>
	JSON.stringify([databasePath, namespace, canvasId]);
export function emitCanvasResearchChange(databasePath: string, namespace: string, canvasId: string): void {
	// Notify after the database connection/transaction has finished; a disconnected
	// SSE consumer must never roll back a successful write or block another listener.
	queueMicrotask(() => {
		for (const listener of events.listeners(key(databasePath, namespace, canvasId))) {
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
	namespace: string,
	canvasId: string,
	listener: () => void,
): () => void {
	const channel = key(databasePath, namespace, canvasId);
	events.on(channel, listener);
	return () => events.off(channel, listener);
}
