import { describe, expect, it, vi } from "vitest";
import {
	createCanvasResearchRuntime,
	registerCanvasResearchTools,
} from "../src/canvas/presentation/canvas-research-tools.ts";
import paperAgentExtension from "../src/index.ts";
import { collectRegisteredTools } from "../src/shared/presentation/agent-tool-catalog.ts";
import { researchFixture } from "./canvas-research-fixture.ts";

describe("canvas-bound tools and human decisions", () => {
	it("registers only in canvas runtimes and binds each message to the current scope", async () => {
		const f = await researchFixture(),
			runtime = createCanvasResearchRuntime(f.service);
		const base = collectRegisteredTools(paperAgentExtension);
		expect(base.some((t) => t.name === "apply_canvas_changes")).toBe(false);
		const tools = collectRegisteredTools((pi) => registerCanvasResearchTools(pi, f.service));
		expect(tools).toHaveLength(7);
		const header = await runtime.prepare({ agentNodeId: "agent-a" });
		expect(header).toContain(f.service.canvasId);
		expect(header).toContain("canvas-research/SKILL.md");
		expect(header).not.toContain("Method family");
		f.service.saveContext({ scope: "selected", selectedNodeIds: ["node-p0"] });
		expect(await runtime.prepare()).toContain('"uniquePapers":1');
		await expect(runtime.prepare({ selectedNodeIds: ["other-canvas-node"] })).rejects.toThrow("已删除");
	});
	it("waits for explicit preview application and returns compact data; abort preserves a proposal", async () => {
		const f = await researchFixture(),
			s = f.service;
		const tools = collectRegisteredTools((pi) => registerCanvasResearchTools(pi, s));
		const apply = tools.find((t) => t.name === "apply_canvas_changes")!;
		const p = await s.preview({
			reason: "Arrange",
			operations: [{ id: "move", kind: "move_node", nodeId: "node-p0", x: 100, y: 100 }],
		});
		const update = vi.fn();
		const waiting = apply.execute("tool", { proposal_id: p.id }, undefined, update, {} as never);
		expect(update).toHaveBeenCalled();
		expect(s.board().nodes[0].x).toBe(0);
		await s.apply(p.id, ["move"], s.board().revision);
		expect((await waiting).details).toMatchObject({ id: p.id, status: "applied" });
		expect((await waiting).details).not.toHaveProperty("before");
		const next = await s.preview({
			reason: "Next",
			operations: [{ id: "next", kind: "move_node", nodeId: "node-p0", x: 150, y: 100 }],
		});
		const abort = new AbortController();
		const cancelled = apply.execute("cancel", { proposal_id: next.id }, abort.signal, undefined, {} as never);
		abort.abort();
		await expect(cancelled).rejects.toThrow("停止等待");
		expect(s.records.get("proposal", next.id)?.value).toMatchObject({ status: "pending" });
	});
	it("exposes only the current analysis checkpoint parameters", async () => {
		const f = await researchFixture();
		const tools = collectRegisteredTools((pi) => registerCanvasResearchTools(pi, f.service));
		const schema = tools.find((t) => t.name === "save_canvas_analysis")!.parameters as {
			properties: Record<string, unknown>;
			additionalProperties?: boolean;
		};
		expect(Object.keys(schema.properties).sort()).toEqual(["analysis_id", "content", "expected_revision"]);
		expect(schema.additionalProperties).toBe(false);
		expect(f.service.records.list("analysis")).toHaveLength(0);
	});
});
