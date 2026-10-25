import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { proposeCanvasNodes } from "../src/canvas/application/canvas-node-proposals.ts";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import type { CanvasNodeProposalInput } from "../src/canvas/domain/canvas-editing.ts";
import type { CanvasNode } from "../src/canvas/domain/research-canvas.ts";
import { canvasNodeProposalSchema } from "../src/canvas/presentation/canvas-editing-schema.ts";
import { operationLabel } from "../web/src/canvas-proposal-label.ts";
import { researchFixture } from "./canvas-research-fixture.ts";

const batch = (revision: number): CanvasNodeProposalInput => ({
	request_id: "paper-authors",
	expected_revision: revision,
	reason: "为论文创建作者节点",
	anchor_node_id: "node-p0",
	nodes: [
		{ key: "author", kind: "author", title: "Author 0" },
		{ key: "text", kind: "text", title: "研究想法", content: "还未核验的个人想法" },
	],
	edges: [{ from: { new_node: "author" }, to: { node_id: "node-p0" }, label: "作者" }],
});
const overlap = (a: CanvasNode, b: CanvasNode) =>
	a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("canvas-only node proposals", () => {
	it("shares an ordinary edit preview with HTTP selection and durable undo without an analysis", async () => {
		const f = await researchFixture();
		const before = f.service.board();
		const proposed = await proposeCanvasNodes(f.service, batch(before.revision));
		const server = await startLocalWebServer(f.app, { staticRoot: "dist/web" });
		const base = `${server.url}/api/canvases/${f.service.canvasId}/research/proposals`;
		try {
			const listed = await (await fetch(base)).json();
			expect(listed.proposals[0]).toMatchObject({
				id: proposed.id,
				value: { purpose: "editing", status: "pending" },
			});
			const apply = await fetch(`${base}/${proposed.id}/apply`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					selectedIds: proposed.value.operations.map((op) => op.id),
					expectedRevision: before.revision,
				}),
			});
			expect(apply.status).toBe(200);
			const result = await apply.json();
			expect(result.canvas.nodes.some((node: CanvasNode) => node.kind === "author")).toBe(true);
			const undo = await fetch(`${base}/${proposed.id}/undo`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: result.canvas.revision }),
			});
			expect(undo.status).toBe(200);
			expect((await undo.json()).canvas.nodes).toEqual(before.nodes);
			expect(f.service.records.list("analysis")).toEqual([]);
		} finally {
			await server.close();
		}
	});
	it("previews ordinary authors/text without analysis, auto-places cards and partially applies with dependencies and undo", async () => {
		const f = await researchFixture(),
			original = f.service.board();
		const proposed = await proposeCanvasNodes(f.service, batch(original.revision));
		expect(f.service.board()).toEqual(original);
		expect(f.service.records.list("analysis")).toEqual([]);
		expect(proposed.value.purpose).toBe("editing");
		const added = proposed.value.operations.flatMap((op) => (op.kind === "add_node" ? [op.node] : []));
		expect(added[0].authorDetails).toEqual({ researchArea: "", organization: "" });
		expect(added[1].generatedFrom).toBeUndefined();
		for (const node of added)
			for (const existing of [...original.nodes, ...added.filter((other) => other.id !== node.id)])
				expect(overlap(node, existing)).toBe(false);
		const edge = proposed.value.operations.find((op) => op.kind === "add_edge")!;
		const applied = await f.service.apply(proposed.id, [edge.id], original.revision);
		expect(applied.canvas.nodes).toHaveLength(original.nodes.length + 1);
		expect(applied.canvas.nodes.find((node) => node.id === added[1].id)).toBeUndefined();
		expect(applied.canvas.edges[0]).toMatchObject({ label: "作者", from: added[0].id, to: "node-p0" });
		expect(applied.canvas.viewport).toEqual(original.viewport);
		expect((await f.service.apply(proposed.id, [edge.id], original.revision)).replayed).toBe(true);
		const undone = await f.service.apply(proposed.id, [], applied.canvas.revision, true);
		expect(undone.canvas.nodes).toEqual(original.nodes);
		expect(undone.canvas.edges).toEqual(original.edges);
	});
	it("supports team fields, paper IDs and same-name warnings without merging author identities", async () => {
		const f = await researchFixture(),
			revision = f.service.board().revision;
		const input = batch(revision);
		input.nodes.push(
			{ key: "same-author", kind: "author", title: "Author 0", organization: "Known institution" },
			{
				key: "team",
				kind: "team",
				title: "研究团队",
				members: ["Author 0"],
				homepage_url: "https://example.org/team",
			},
			{ key: "paper", kind: "paper", paper_id: "p0" },
		);
		const proposed = await proposeCanvasNodes(f.service, input);
		expect(proposed.value.warnings).toHaveLength(2);
		const applied = await f.service.apply(
			proposed.id,
			proposed.value.operations.map((op) => op.id),
			revision,
		);
		expect(applied.canvas.nodes.filter((node) => node.kind === "author")).toHaveLength(2);
		expect(applied.canvas.nodes.find((node) => node.kind === "team")?.teamDetails).toMatchObject({
			institution: "",
			members: ["Author 0"],
			homepageUrl: "https://example.org/team",
		});
		expect(applied.canvas.nodes.filter((node) => node.kind === "paper" && node.entityId === "p0")).toHaveLength(2);
		expect(applied.canvas.nodes.at(-1)?.title).toBe(f.papers[0].title);
	});
	it("reuses retry IDs across property ordering and concurrent calls, rejects changed payloads", async () => {
		const f = await researchFixture(),
			input = batch(f.service.board().revision);
		const [first, second] = await Promise.all([
			proposeCanvasNodes(f.service, input),
			proposeCanvasNodes(f.service, input),
		]);
		expect(first.id).toBe(second.id);
		expect(first.value.editRequest?.nodeIds).toEqual(second.value.editRequest?.nodeIds);
		const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as CanvasNodeProposalInput;
		expect((await proposeCanvasNodes(f.service, reordered)).id).toBe(first.id);
		expect(f.service.records.list("proposal")).toHaveLength(1);
		await expect(proposeCanvasNodes(f.service, { ...input, reason: "其他内容" })).rejects.toThrow("request_id");
		const applied = await f.service.apply(
			first.id,
			first.value.operations.map((op) => op.id),
			input.expected_revision,
		);
		expect(
			(await proposeCanvasNodes(f.service, { ...input, expected_revision: applied.canvas.revision })).value.status,
		).toBe("applied");
	});
	it("keeps editing independent of research settings and material updates; rejects deleted paper sources", async () => {
		const f = await researchFixture();
		const proposed = await proposeCanvasNodes(f.service, batch(f.service.board().revision));
		f.service.saveSettings({ question: "Changed research question" }, -1);
		await f.library.upsertPaper({ ...f.papers[0], abstract: "A changed abstract" });
		await f.service.apply(
			proposed.id,
			proposed.value.operations.map((op) => op.id),
			f.service.board().revision,
		);
		const paper = await proposeCanvasNodes(f.service, {
			request_id: "deleted-source",
			expected_revision: f.service.board().revision,
			reason: "Existing paper",
			nodes: [{ key: "paper", kind: "paper", paper_id: "p1" }],
		});
		await f.library.deletePapers(["p1"]);
		await expect(f.service.apply(paper.id, ["node-paper"], f.service.board().revision)).rejects.toThrow("来源已删除");
		expect(f.service.records.get("proposal", paper.id)?.value).toMatchObject({ status: "pending" });
	});
	it("enforces revisions, scope and ownership; cannot target another canvas or excluded node", async () => {
		const f = await researchFixture(),
			input = batch(f.service.board().revision);
		await expect(
			proposeCanvasNodes(f.service, { ...input, expected_revision: input.expected_revision - 1 }),
		).rejects.toThrow("画布已变化");
		f.service.saveContext({ scope: "selected", selectedNodeIds: ["node-p0"], agentNodeId: "agent-a" });
		await expect(
			proposeCanvasNodes(f.service, {
				...input,
				edges: [{ from: { new_node: "author" }, to: { node_id: "node-p1" }, label: "作者" }],
			}),
		).rejects.toThrow("工作范围");
		const other = f.service.canvases.create("Other canvas");
		await expect(
			proposeCanvasNodes(new CanvasResearchService(f.library, other.id, "session-a"), {
				...input,
				expected_revision: other.revision,
			}),
		).rejects.toThrow("未绑定");
		const proposed = await proposeCanvasNodes(f.service, input);
		const current = f.service.board();
		f.service.canvases.update(current.id, current.revision, { ...current, viewport: { x: 10, y: 20, scale: 1 } });
		await expect(f.service.apply(proposed.id, ["node-author"], f.service.board().revision)).rejects.toThrow(
			"画布已变化",
		);
		expect(f.service.board().nodes).toHaveLength(current.nodes.length);
	});
	it("rejects bad cards, endpoints and URLs without saving a partial proposal", async () => {
		const f = await researchFixture(),
			input = batch(f.service.board().revision);
		await expect(
			proposeCanvasNodes(f.service, { ...input, nodes: [...input.nodes, input.nodes[0]] }),
		).rejects.toThrow("key");
		await expect(
			proposeCanvasNodes(f.service, {
				...input,
				nodes: [{ key: "bad", kind: "author", title: "A", profile_url: "javascript:alert(1)" }],
			}),
		).rejects.toThrow();
		await expect(
			proposeCanvasNodes(f.service, { ...input, nodes: [{ key: "bad", kind: "agent", title: "New agent" }] } as any),
		).rejects.toThrow("仅支持");
		await expect(
			proposeCanvasNodes(f.service, {
				...input,
				edges: [{ from: { new_node: "missing" }, to: { node_id: "node-p0" }, label: "作者" }],
			}),
		).rejects.toThrow("未找到");
		expect(f.service.records.list("proposal")).toEqual([]);
		expect(Check(canvasNodeProposalSchema, { ...input, canvas_id: "other" })).toBe(false);
		expect(
			Check(canvasNodeProposalSchema, { ...input, nodes: [{ key: "agent", kind: "agent", title: "Other" }] }),
		).toBe(false);
		expect(Check(canvasNodeProposalSchema, input)).toBe(true);
	});
	it("supports edges-only edits, rejects duplicate edges, and labels each node kind accurately", async () => {
		const f = await researchFixture();
		const input: CanvasNodeProposalInput = {
			request_id: "edges",
			expected_revision: f.service.board().revision,
			reason: "关联已有节点",
			nodes: [],
			edges: [{ from: { node_id: "node-p0" }, to: { node_id: "node-p1" }, label: "待比较" }],
		};
		const proposed = await proposeCanvasNodes(f.service, input);
		await f.service.apply(
			proposed.id,
			proposed.value.operations.map((op) => op.id),
			input.expected_revision,
		);
		await expect(
			proposeCanvasNodes(f.service, {
				...input,
				request_id: "duplicate",
				expected_revision: f.service.board().revision,
			}),
		).rejects.toThrow("重复连线");
		for (const [kind, label] of [
			["author", "作者"],
			["team", "团队"],
			["text", "文本"],
		] as const)
			expect(
				operationLabel(
					{
						id: "new",
						kind: "add_node",
						node: { id: "n", kind, title: "示例", x: 0, y: 0, width: 260, height: 180 },
					},
					[],
				),
			).toBe(`新增${label}：示例`);
	});
});
