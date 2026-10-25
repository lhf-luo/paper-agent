import type { AgentEvent, AgentSessionSnapshot, AgentSessionSummary } from "./types.ts";

export function applyAgentQueueEvent(
	current: AgentSessionSnapshot | undefined,
	event: Extract<AgentEvent, { type: "queue" }>,
): AgentSessionSnapshot | undefined {
	if (current?.id !== event.sessionId || current.updatedAt > event.updatedAt) return current;
	return {
		...current,
		pendingInputs: event.pendingInputs,
		queuePaused: event.queuePaused,
		// Queue events carry no run status. Advancing the session clock here would
		// discard the running event emitted immediately afterwards at the same time.
	};
}

/** A delayed response must not turn a completed run back into a running one. */
export function isNewerAgentSessionState(current: AgentSessionSummary | undefined, next: AgentSessionSummary): boolean {
	if (!current || current.id !== next.id) return true;
	if (next.updatedAt < current.updatedAt) return false;
	if (next.updatedAt > current.updatedAt) return true;
	if (next.status === current.status) return false;
	const currentFinished = current.status === "idle" || current.status === "error";
	return !(currentFinished && (next.status === "running" || next.status === "stopping"));
}
