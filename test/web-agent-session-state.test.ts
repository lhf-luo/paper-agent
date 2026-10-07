import { describe, expect, it } from "vitest";
import { isNewerAgentSessionState } from "../web/src/agent-session-state.ts";
import type { AgentSessionSummary } from "../web/src/types.ts";

const session = (status: AgentSessionSummary["status"], updatedAt: string): AgentSessionSummary => ({
	id: "session-one",
	title: "Research",
	mode: "persistent",
	status,
	createdAt: "2026-10-05T10:00:00.000Z",
	updatedAt,
	pendingUIRequests: 0,
});

describe("Web Agent session reconciliation", () => {
	it("accepts a completed server snapshot after a running event was missed", () => {
		expect(
			isNewerAgentSessionState(
				session("running", "2026-10-05T10:00:00.000Z"),
				session("idle", "2026-10-05T10:00:05.000Z"),
			),
		).toBe(true);
	});

	it("does not regress a completed run from a delayed response", () => {
		const idle = session("idle", "2026-10-05T10:00:05.000Z");
		expect(isNewerAgentSessionState(idle, session("running", "2026-10-05T10:00:04.000Z"))).toBe(false);
		expect(isNewerAgentSessionState(idle, session("running", idle.updatedAt))).toBe(false);
	});

	it("accepts a newly started run after an earlier completed run", () => {
		expect(
			isNewerAgentSessionState(
				session("idle", "2026-10-05T10:00:05.000Z"),
				session("running", "2026-10-05T10:00:06.000Z"),
			),
		).toBe(true);
	});

	it("avoids replacing an unchanged snapshot on each reconciliation interval", () => {
		expect(
			isNewerAgentSessionState(
				session("running", "2026-10-05T10:00:05.000Z"),
				session("running", "2026-10-05T10:00:05.000Z"),
			),
		).toBe(false);
	});
});
