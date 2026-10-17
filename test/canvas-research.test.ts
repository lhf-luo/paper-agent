import { describe, expect, it, vi } from "vitest";
import { researchLayout } from "../src/canvas/application/canvas-research-layout.ts";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import {
	parseEvidence,
	parseRelation,
	parseResearchSettings,
} from "../src/canvas/domain/canvas-research-validation.ts";
import { abstractCard, methodCard, paperNode, researchFixture } from "./canvas-research-fixture.ts";

describe("canvas research scope and reuse", () => {
	it("deduplicates all-card inventory, binds neighbors to the session, and pages 100 papers without bodies", async () => {
		const f = await researchFixture(100),
			s = f.service;
		const board = s.board();
		s.canvases.update(board.id, board.revision, {
			...board,
			nodes: [...board.nodes, { ...f.nodes[0], id: "duplicate" }],
			edges: [
				{ id: "a", from: "agent-a", to: f.nodes[0].id, label: "" },
				{ id: "b", from: f.nodes[0].id, to: "agent-a", label: "" },
			],
		});
		const materialBody = vi.spyOn(f.library, "getResearchNote");
		expect((await s.overview()).uniquePapers).toBe(100);
		const first = await s.nodes(0, 50),
			second = await s.nodes(50, 50),
			last = await s.nodes(100, 50);
		expect([first.nodes.length, second.nodes.length, last.nodes.length]).toEqual([50, 50, 2]);
		expect(materialBody).not.toHaveBeenCalled();
		s.saveContext({ scope: "neighbors", agentNodeId: "agent-a" });
		expect((await s.nodes()).nodes.map((n) => n.id)).toEqual([f.nodes[0].id]);
		const other = new CanvasResearchService(f.library, "research", s.canvasId, "session-b");
		expect(() => other.saveContext({ scope: "neighbors", agentNodeId: "agent-a" })).toThrow("当前画布会话");
		expect(() => s.saveContext({ scope: "selected", selectedNodeIds: [] })).toThrow("请选择");
		expect(new CanvasResearchService(f.library, "other", s.canvasId).canvases.get(s.canvasId)).toBeUndefined();
	});
	it("reuses versioned cards across sessions; aliases and layout do not invalidate, new papers do", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveSettings({ question: "如何合成检查器？" }, -1);
		const first = await s.saveAnalysis({ cards: [abstractCard("p0")], status: "completed" });
		expect(first.value.status).toBe("partial");
		const checkpoint = await s.saveAnalysis(
			{ summary: "Updated synthesis", nextSteps: ["Read boundary work"] },
			first.id,
			first.revision,
		);
		expect(checkpoint.value.summary).toBe("Updated synthesis");
		expect(checkpoint.value.nextSteps).toEqual(["Read boundary work"]);
		const board = s.board();
		s.canvases.update(board.id, board.revision, {
			...board,
			viewport: { x: 99, y: 55, scale: 0.7 },
			nodes: board.nodes.map((n) => ({ ...n, alias: "自定义名字", x: n.x + 15 })),
		});
		expect((await s.analysis(first.id)).freshness).toBe("current");
		const other = new CanvasResearchService(f.library, "research", s.canvasId, "session-b");
		const reused = await other.saveAnalysis({});
		expect(reused.value.reusedPaperIds).toEqual(["p0"]);
		await expect(other.saveAnalysis({}, first.id, first.revision)).rejects.toThrow("自己的会话");
		const current = s.board();
		s.canvases.update(current.id, current.revision, { ...current, nodes: [...current.nodes, paperNode("missing")] });
		expect(await s.analysis(first.id)).toMatchObject({ freshness: "stale", pendingPaperIds: ["missing"] });
		expect(first.value.paperIds).toEqual(["p0", "p1", "p2"]);
	});
	it("enforces confirmed goals, deep-reading budgets and source evidence versions", async () => {
		const f = await researchFixture(),
			s = f.service;
		const c0 = await methodCard(f, "p0"),
			c1 = await methodCard(f, "p1");
		await expect(s.saveAnalysis({ cards: [c0] })).rejects.toThrow("研究问题");
		s.saveSettings({ question: "Research", readingBudget: 1 }, -1);
		await expect(s.saveAnalysis({ cards: [c0, c1] })).rejects.toThrow("预算");
		const run = await s.saveAnalysis({ cards: [c0] });
		await expect(s.saveAnalysis({ cards: [c1] }, run.id, run.revision)).rejects.toThrow("预算");
		const note = await f.library.getResearchNote(c0.evidence[0].noteId!);
		await f.library.updateResearchNote(note!.id, {
			title: note!.title,
			markdown: "new evidence",
			expectedRevision: note!.revision,
			expectedContentHash: note!.contentHash,
		});
		expect((await s.analysis(run.id)).freshness).toBe("stale");
		await expect(s.saveAnalysis({ cards: [c0] })).rejects.toThrow("笔记版本");
		expect(() => parseEvidence({ paperId: "p0", level: "pdf", page: 3 })).toThrow("版本");
		expect(() =>
			parseRelation({ type: "extends", explanation: "improves", evidenceStatus: "supported", evidence: [] }),
		).toThrow("正文证据");
		expect(() => parseResearchSettings({ resultsPerProvider: 101 })).toThrow();
	});
	it("keeps historical selected scopes readable and resumes interrupted checkpoints", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveContext({ scope: "selected", selectedNodeIds: ["node-p0"] });
		const run = await s.saveAnalysis({ cards: [abstractCard("p0")] });
		s.records.interrupt("session-a");
		expect(s.records.get("analysis", run.id)?.value).toMatchObject({ status: "interrupted" });
		const board = s.board();
		s.canvases.update(board.id, board.revision, { ...board, nodes: board.nodes.filter((n) => n.id !== "node-p0") });
		expect(await s.analysis(run.id)).toMatchObject({ freshness: "stale", totalCards: 1 });
	});
	it("generates three layouts using actual sizes and never moves pinned papers", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveSettings({ question: "Research" }, -1);
		const run = await s.saveAnalysis({ cards: f.papers.map((p) => abstractCard(p.id)) });
		const board = s.board();
		board.nodes[0].pinned = true;
		board.nodes[1].width = 550;
		for (const mode of ["methods", "timeline", "evidence"] as const) {
			const ops = researchLayout(board, run.value, run.id, mode, new Map(f.papers.map((p) => [p.id, p.year])));
			expect(ops.some((op) => op.kind === "move_node" && op.nodeId === "node-p0")).toBe(false);
			expect(ops.some((op) => op.kind === "upsert_group")).toBe(true);
			expect(ops.some((op) => op.kind === "add_node" && op.node.generatedFrom?.analysisId === run.id)).toBe(true);
		}
	});
});
