import { describe, expect, it } from "vitest";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import { applyCanvasOperations } from "../src/canvas/domain/canvas-changes.ts";
import type { CanvasChangeOperation } from "../src/canvas/domain/canvas-research.ts";
import { CanvasRevisionConflict } from "../src/canvas/infrastructure/research-canvas-store.ts";
import { abstractCard, researchFixture } from "./canvas-research-fixture.ts";

const operations: CanvasChangeOperation[] = [
	{ id: "group", kind: "upsert_group", group: { id: "g1", title: "方法", x: 0, y: 200, width: 700, height: 500 } },
	{ id: "move", kind: "move_node", nodeId: "node-p0", x: 50, y: 300, groupId: "g1", dependsOn: ["group"] },
	{
		id: "summary",
		kind: "add_node",
		node: {
			id: "summary1",
			kind: "text",
			title: "总结",
			content: "Evidence",
			x: 400,
			y: 300,
			width: 260,
			height: 145,
			generatedFrom: { analysisId: "test" },
		},
	},
];
describe("research preview transactions and undo", () => {
	it("synchronizes normal canvas undo and redo with durable research batch status", async () => {
		const f = await researchFixture(),
			s = f.service,
			original = s.board();
		const p = await s.preview({ reason: "Batch", operations: operations.slice(0, 2) });
		const applied = await s.apply(p.id, ["move"], original.revision);
		const restored = s.canvases.update(s.canvasId, applied.canvas.revision, original)!;
		expect(s.records.get("proposal", p.id)?.value).toMatchObject({ status: "undone" });
		const redone = s.canvases.update(s.canvasId, restored.revision, applied.canvas)!;
		expect(s.records.get("proposal", p.id)?.value).toMatchObject({ status: "applied" });
		const undone = await s.apply(p.id, [], redone.revision, true);
		expect(undone.canvas.nodes).toEqual(original.nodes);
	});
	it("applies selected dependency closures once; durable undo preserves unrelated edits and viewport", async () => {
		const f = await researchFixture(),
			s = f.service;
		const original = s.board();
		const p = await s.preview({ reason: "organize", analysisId: (await s.saveAnalysis({})).id, operations });
		expect(s.board()).toEqual(original);
		const result = await s.apply(p.id, ["move"], original.revision);
		expect(result.proposal.value.selectedIds).toEqual(["group", "move"]);
		expect(result.canvas.nodes.find((n) => n.id === "node-p0")).toMatchObject({ x: 50, y: 300, groupId: "g1" });
		expect(result.canvas.nodes.some((n) => n.id === "summary1")).toBe(false);
		const replay = await s.apply(p.id, ["move"], original.revision);
		expect(replay.replayed).toBe(true);
		expect(replay.canvas.revision).toBe(result.canvas.revision);
		const edited = s.canvases.update(s.canvasId, result.canvas.revision, {
			...result.canvas,
			viewport: { x: 500, y: 50, scale: 0.8 },
			nodes: result.canvas.nodes.map((n) => (n.id === "node-p1" ? { ...n, alias: "manual" } : n)),
		})!;
		const undone = await s.apply(p.id, [], edited.revision, true);
		expect(undone.canvas.nodes.find((n) => n.id === "node-p0")).toEqual(original.nodes[0]);
		expect(undone.canvas.nodes.find((n) => n.id === "node-p1")?.alias).toBe("manual");
		expect(undone.canvas.viewport).toEqual(edited.viewport);
		expect(undone.proposal.value.status).toBe("undone");
	});
	it("rejects affected-object undo conflicts without losing the user's edits", async () => {
		const f = await researchFixture(),
			s = f.service;
		const p = await s.preview({ reason: "organize", analysisId: (await s.saveAnalysis({})).id, operations });
		const applied = await s.apply(p.id, ["move"], s.board().revision);
		const edited = s.canvases.update(s.canvasId, applied.canvas.revision, {
			...applied.canvas,
			nodes: applied.canvas.nodes.map((n) => (n.id === "node-p0" ? { ...n, x: 123 } : n)),
		})!;
		await expect(s.apply(p.id, [], edited.revision, true)).rejects.toThrow("撤销冲突");
		expect(s.board()).toEqual(edited);
		expect(s.records.get("proposal", p.id)?.value).toMatchObject({ status: "applied" });
	});
	it("rejects stale previews, pinned movement, cycles and failed commits atomically", async () => {
		const f = await researchFixture(),
			s = f.service;
		const p = await s.preview({ reason: "organize", analysisId: (await s.saveAnalysis({})).id, operations });
		const board = s.board();
		s.canvases.update(board.id, board.revision, { ...board, title: "Manual edit" });
		await expect(s.apply(p.id, ["move"], s.board().revision)).rejects.toBeInstanceOf(CanvasRevisionConflict);
		const current = s.board();
		current.nodes[0].pinned = true;
		expect(() => applyCanvasOperations(current, operations, ["move"])).toThrow("固定");
		expect(() =>
			applyCanvasOperations(
				current,
				[
					{ ...operations[0], dependsOn: ["summary"] },
					{ ...operations[2], dependsOn: ["group"] },
				],
				["group"],
			),
		).toThrow("循环");
		const malicious = s.records.save(
			"proposal",
			{
				...p.value,
				baseRevision: s.board().revision,
				operations: [
					...operations,
					{ id: "broken", kind: "add_edge", edge: { id: "e", from: "node-p0", to: "missing", label: "" } },
				],
			},
			s.sessionId,
		);
		const before = s.board();
		await expect(s.apply(malicious.id, ["move", "broken"], before.revision)).rejects.toThrow();
		expect(s.board()).toEqual(before);
		expect(s.records.get("proposal", malicious.id)?.value).toMatchObject({ status: "pending" });
	});
	it("separates accepted edges from evidence support; deduplicates symmetric relations", async () => {
		const f = await researchFixture(),
			s = f.service;
		const edge = {
			id: "edge1",
			from: "node-p0",
			to: "node-p1",
			label: "相似",
			research: {
				type: "similar" as const,
				explanation: "Same representation",
				conditions: "",
				evidence: [{ paperId: "p0", level: "abstract" as const }],
				evidenceStatus: "candidate" as const,
				reviewStatus: "pending" as const,
				createdBy: "agent",
			},
		};
		const p = await s.preview({ reason: "relation", operations: [{ id: "edgeop", kind: "add_edge", edge }] });
		expect(p.value.operations[0]).toMatchObject({ edge: { research: { reviewStatus: "pending" } } });
		const result = await s.apply(p.id, ["edgeop"], s.board().revision);
		expect(result.canvas.edges[0].research).toMatchObject({ reviewStatus: "accepted", evidenceStatus: "candidate" });
		await expect(
			s.preview({
				reason: "duplicate",
				operations: [
					{ id: "reverse", kind: "add_edge", edge: { ...edge, id: "edge2", from: edge.to, to: edge.from } },
				],
			}),
		).rejects.toThrow("已存在");
	});
	it("copies settings and generated snapshots but no live analyses or proposals; deletion cleans research only", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveSettings({ question: "Research" }, -1);
		await s.saveAnalysis({ cards: [abstractCard("p0")] });
		const p = await s.preview({ reason: "summary", analysisId: (await s.saveAnalysis({})).id, operations });
		await s.apply(p.id, ["summary"], s.board().revision);
		const board = s.board(),
			copy = s.canvases.duplicate(s.canvasId, board.revision)!;
		const copied = new CanvasResearchService(f.library, copy.id);
		expect(copied.settings().value.question).toBe("Research");
		expect(copied.records.list("analysis")).toHaveLength(0);
		expect(copied.records.list("proposal")).toHaveLength(0);
		expect(copy.nodes.find((n) => n.id === "summary1")?.generatedFrom?.snapshot).toBe(true);
		s.canvases.delete(s.canvasId, board.revision);
		expect(s.records.list("analysis")).toHaveLength(0);
		expect(await f.library.getPaper("p0")).toBeDefined();
	});
});
