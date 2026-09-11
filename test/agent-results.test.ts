import { describe, expect, it } from "vitest";
import {
	agentResultQueryLabel,
	collectAgentResultDocuments,
	parseAgentResultOutput,
} from "../web/src/agent-results.ts";
import type { AgentMessageView, AgentToolView } from "../web/src/types.ts";

function message(
	id: string,
	role: AgentMessageView["role"],
	createdAt: string,
	content = "",
): AgentMessageView {
	return { id, role, content, createdAt, status: "complete" };
}

function resultTool(
	id: string,
	startedAt: string,
	url: string,
	options: { status?: AgentToolView["status"]; rowCount?: number; truncated?: boolean } = {},
): AgentToolView {
	const details = `"mdUrl":"${url}","rowCount":${options.rowCount ?? 0}`;
	return {
		id,
		name: "update_literature_sidebar",
		status: options.status ?? "succeeded",
		startedAt,
		finishedAt: startedAt,
		output: options.truncated ? `{"details":{${details},"metadata":` : `{"details":{${details}}}`,
	};
}

describe("agent result documents", () => {
	it("indexes every successful result and anchors it to the matching assistant turn", () => {
		const messages = [
			message("u1", "user", "2026-08-27T10:00:00.000Z", "/skill:literature-corpus-manager 搜索二进制漏洞论文"),
			message("a1", "assistant", "2026-08-27T10:00:01.000Z"),
			message("u2", "user", "2026-08-27T11:00:00.000Z", "搜索 UAF 漏洞论文"),
			message("a2", "assistant", "2026-08-27T11:00:01.000Z"),
		];
		const tools: AgentToolView[] = [
			resultTool("t2", "2026-08-27T11:00:02.000Z", "/api/agent/results/uaf.md", { rowCount: 18 }),
			resultTool("t1", "2026-08-27T10:00:02.000Z", "/api/agent/results/binary.md", { rowCount: 26 }),
		];

		expect(collectAgentResultDocuments(messages, tools)).toEqual([
			expect.objectContaining({
				id: "t1",
				url: "/api/agent/results/binary.md",
				anchorMessageId: "a1",
				query: "搜索二进制漏洞论文",
				sequence: 1,
				rowCount: 26,
			}),
			expect.objectContaining({
				id: "t2",
				url: "/api/agent/results/uaf.md",
				anchorMessageId: "a2",
				query: "搜索 UAF 漏洞论文",
				sequence: 2,
				rowCount: 18,
			}),
		]);
	});

	it("deduplicates URLs and ignores failed or malformed result tools", () => {
		const messages = [message("u1", "user", "2026-08-27T10:00:00.000Z", "搜索论文")];
		const tools: AgentToolView[] = [
			resultTool("first", "2026-08-27T10:00:01.000Z", "/api/agent/results/one.md"),
			resultTool("duplicate", "2026-08-27T10:00:02.000Z", "/api/agent/results/one.md"),
			resultTool("failed", "2026-08-27T10:00:03.000Z", "/api/agent/results/two.md", { status: "failed" }),
			{
				id: "malformed",
				name: "update_literature_sidebar",
				status: "succeeded",
				startedAt: "2026-08-27T10:00:04.000Z",
				output: "no document",
			},
		];

		expect(collectAgentResultDocuments(messages, tools).map((document) => document.id)).toEqual(["first"]);
	});

	it("keeps one result card when an in-place edit reports the same URL", () => {
		const messages = [message("u1", "user", "2026-08-27T10:00:00.000Z", "搜索并补充 DOI")];
		const created = resultTool("created", "2026-08-27T10:00:01.000Z", "/api/agent/results/list.md", {
			rowCount: 4,
		});
		const edited: AgentToolView = {
			id: "edited",
			name: "edit_literature_sidebar",
			status: "succeeded",
			startedAt: "2026-08-27T10:00:02.000Z",
			output: '{"details":{"mdUrl":"/api/agent/results/list.md","rowCount":4,"revision":2}}',
		};

		expect(collectAgentResultDocuments(messages, [created, edited])).toEqual([
			expect.objectContaining({ id: "created", url: "/api/agent/results/list.md", rowCount: 4 }),
		]);
	});

	it("recovers the URL and row count from truncated output", () => {
		const output = resultTool("t1", "2026-08-27T10:00:00.000Z", "/api/agent/results/truncated.md", {
			rowCount: 37,
			truncated: true,
		}).output ?? "";

		expect(parseAgentResultOutput(output)).toEqual({
			url: "/api/agent/results/truncated.md",
			rowCount: 37,
		});
	});

	it("normalizes skill prompts and truncates long labels", () => {
		expect(agentResultQueryLabel("/skill:literature-corpus-manager   搜索 UAF\n相关论文")).toBe("搜索 UAF 相关论文");
		expect(agentResultQueryLabel("x".repeat(80))).toBe(`${"x".repeat(53)}...`);
		expect(agentResultQueryLabel("   ")).toBe("本轮搜索");
	});
});
