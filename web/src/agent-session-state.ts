import type { AgentSessionSummary } from "./types.ts";

/** A delayed response must not turn a completed run back into a running one. */
export function isNewerAgentSessionState(current: AgentSessionSummary | undefined, next: AgentSessionSummary): boolean {
	if (!current || current.id !== next.id) return true;
	if (next.updatedAt < current.updatedAt) return false;
	if (next.updatedAt > current.updatedAt) return true;
	if (next.status === current.status) return false;
	const currentFinished = current.status === "idle" || current.status === "error";
	return !(currentFinished && (next.status === "running" || next.status === "stopping"));
}
