import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { proposeCanvasNodes } from "../application/canvas-node-proposals.ts";
import type { CanvasResearchService } from "../application/canvas-research-service.ts";
import { canvasNodeProposalSchema } from "./canvas-editing-schema.ts";

/** Registered only by the session-bound canvas extension, never by the global extension. */
export function registerCanvasEditingTools(pi: ExtensionAPI, service: CanvasResearchService): void {
	pi.registerTool({
		name: "propose_canvas_nodes",
		label: "提议创建画布节点与连线",
		description:
			"Propose author, team, ordinary text or existing personal-library paper nodes and labeled edges in this session's bound canvas. Returns a saved preview with generated IDs and free positions; never applies it. Does not require a research question or analysis record. Cannot create note or Agent sessions.",
		promptGuidelines: [
			"Use this for everyday node creation, including authors of a paper. Query the current canvas and verify the paper's actual author metadata first. Use get_canvas_overview/get_canvas_nodes for expected_revision and exact existing node IDs.",
			"Provide a stable request_id for retries. nodes[].key is only a batch-local key; reference it with {new_node:key}. Reference existing in-scope nodes with {node_id:id}. The server generates persistent IDs, dimensions, dependencies and positions.",
			"Do not fabricate affiliations, research fields, websites or memberships. Leave unknown fields omitted. Same author names do not establish identity; inspect duplicate warnings.",
			"After creating the preview call apply_canvas_changes with the returned proposalId and wait for the user's selection in 画布研究 → 变更预览. Automatic permission mode cannot approve a canvas proposal. Never write canvas files/SQLite or call HTTP to bypass the preview.",
			"For research summaries, evidence-backed paper relations and research layouts use the research tools and canvas-research skill. Ordinary text cards here do not claim research verification.",
		],
		parameters: canvasNodeProposalSchema,
		async execute(_id, input, signal) {
			signal?.throwIfAborted();
			const record = await proposeCanvasNodes(service, input);
			const details = {
				proposalId: record.id,
				status: record.value.status,
				baseRevision: record.value.baseRevision,
				nodes: Object.entries(record.value.editRequest?.nodeIds ?? {}).map(([key, nodeId]) => {
					const op = record.value.operations.find((op) => op.kind === "add_node" && op.node.id === nodeId);
					return { key, nodeId, ...(op?.kind === "add_node" ? { kind: op.node.kind, title: op.node.title } : {}) };
				}),
				edgeCount: record.value.operations.filter((op) => op.kind === "add_edge").length,
				warnings: record.value.warnings,
				message: "已保存节点提案；请在画布研究 → 变更预览选择并应用。可调用 apply_canvas_changes 等待用户确认。",
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}
