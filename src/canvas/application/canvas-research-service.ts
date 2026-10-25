import { resolveCanvasPaper } from "./canvas-graph-service.ts";
import { randomUUID } from "node:crypto";
import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import { applyCanvasOperations, parseChangeOperations, selectedChangeIds } from "../domain/canvas-changes.ts";
import type {
	CanvasChangeProposal,
	CanvasResearchAnalysis,
	CanvasResearchContext,
	CanvasResearchSettings,
} from "../domain/canvas-research.ts";
import { defaultResearchSettings } from "../domain/canvas-research.ts";
import { parseResearchContext, parseResearchSettings } from "../domain/canvas-research-validation.ts";
import { CanvasResearchStore } from "../infrastructure/canvas-research-store.ts";
import { ResearchCanvasStore } from "../infrastructure/research-canvas-store.ts";
import { validateCanvasNodeProposal } from "./canvas-node-proposals.ts";
import { CanvasAnalysisWriter } from "./canvas-research-analysis.ts";
import { type ResearchLayout, researchLayout } from "./canvas-research-layout.ts";
import {
	checkEvidence,
	paperMetadata,
	paperSource,
	researchHash,
	researchPaperIndex,
	scopedNodes,
} from "./canvas-research-materials.ts";
import { readResearchAnalysis } from "./canvas-research-projection.ts";

type SessionSummary = (
	id: string,
) => Promise<{ title: string; status: string; updatedAt: string; pendingRequests: number } | undefined>;
export class CanvasResearchService {
	readonly library: LiteratureStore;

	readonly canvasId: string;
	readonly sessionId: string;
	readonly sessionSummary?: SessionSummary;
	currentRoundId?: string;
	beginRound() {
		this.currentRoundId = randomUUID();
	}
	readonly records: CanvasResearchStore;
	readonly canvases: ResearchCanvasStore;
	constructor(
		library: LiteratureStore,

		canvasId: string,
		sessionId = "user",
		sessionSummary?: SessionSummary,
	) {
		this.library = library;

		this.canvasId = canvasId;
		this.sessionId = sessionId;
		this.sessionSummary = sessionSummary;
		this.records = new CanvasResearchStore(library.databasePath, canvasId);
		this.canvases = new ResearchCanvasStore(library.databasePath);
	}
	board() {
		const board = this.canvases.get(this.canvasId);
		if (!board) throw new Error("画布不存在");
		return board;
	}
	settings() {
		return (
			this.records.get<CanvasResearchSettings>("settings", "shared") ?? {
				id: "shared",
				revision: -1,
				sessionId: "",
				createdAt: "",
				updatedAt: "",
				value: structuredClone(defaultResearchSettings),
			}
		);
	}
	saveSettings(input: unknown, revision: number) {
		return this.records.save("settings", parseResearchSettings(input), this.sessionId, "shared", revision);
	}
	context(): CanvasResearchContext {
		return (
			this.records.get<CanvasResearchContext>("scope", this.sessionId)?.value ?? {
				scope: "canvas",
				selectedNodeIds: [],
			}
		);
	}
	saveContext(input: unknown) {
		const scope = parseResearchContext(input);
		if (
			scope.agentNodeId &&
			!this.board().nodes.some(
				(n) =>
					n.id === scope.agentNodeId &&
					n.kind === "agent" &&
					(this.sessionId === "user" || n.entityId === this.sessionId),
			)
		)
			throw new Error("Agent 节点不属于当前画布会话");
		scopedNodes(this.board(), scope, this.sessionId === "user" ? undefined : this.sessionId);
		const old = this.records.get<CanvasResearchContext>("scope", this.sessionId);
		return this.records.save("scope", scope, this.sessionId, this.sessionId, old?.revision);
	}
	async inventory(scope = this.context(), validateOwner = true) {
		const board = this.board();
		const scoped = scopedNodes(board, scope, validateOwner && this.sessionId !== "user" ? this.sessionId : undefined);
		const resolved = await Promise.all(
			scoped.map(async (n) =>
				n.kind === "paper"
					? { node: n, source: await resolveCanvasPaper(this.library, n) }
					: { node: n, source: undefined },
			),
		);
		const raw = resolved.flatMap(({ node, source }) =>
			node.kind !== "paper"
				? [node]
				: source?.personal
					? [{ ...node, entityId: source.personal.id }]
					: [node],
		);
		const refs = [...new Set(raw.filter((n) => n.kind === "paper").map((n) => n.entityId!))];
		const index = await researchPaperIndex(this.library, refs);
		const nodes = raw.map((n) => (n.kind === "paper" ? { ...n, entityId: index.canonicalIds[n.entityId!] } : n));
		const paperIds = [...new Set(refs.map((id) => index.canonicalIds[id]))].sort();
		const sources = Object.fromEntries(refs.map((id) => [index.canonicalIds[id], index.hashes[id]]));
		const settings = this.settings().value;
		return {
			board,
			nodes,
			paperIds,
			sources,
			settings,
			inputHash: researchHash([
				settings.question,
				settings.scenario,
				settings.include,
				settings.exclude,
				settings.dateFrom,
				settings.dateTo,
				settings.dimensions,
				settings.readingDepth,
				paperIds.map((id) => [id, sources[id]]),
			]),
		};
	}
	async overview() {
		const board = this.board();
		const nodes = scopedNodes(board, this.context(), this.sessionId === "user" ? undefined : this.sessionId);
		const resolvedPapers = await Promise.all(
			nodes.filter((n) => n.kind === "paper").map((n) => resolveCanvasPaper(this.library, n)),
		);
		const latest = this.records
			.list<CanvasResearchAnalysis>("analysis")
			.slice(0, 5)
			.map(({ id, revision, updatedAt, value }) => ({
				id,
				revision,
				updatedAt,
				status: value.status,
				papers: value.paperIds.length,
				cards: value.cards.length,
			}));
		return {
			canvasId: this.canvasId,
			title: board.title,
			revision: board.revision,
			scope: this.context(),
			settings: this.settings(),
			nodes: nodes.length,
			libraryPapers: new Set(resolvedPapers.flatMap((s) => (s.personal ? [s.personal.id] : []))).size,
			uniquePapers: new Set(resolvedPapers.flatMap((s) => (s.paper ? [s.paper.id] : []))).size,
			types: Object.fromEntries(
				["paper", "note", "text", "author", "team", "agent", "search_graph"].map((kind) => [
					kind,
					nodes.filter((n) => n.kind === kind).length,
				]),
			),
			analyses: latest,
		};
	}
	async nodes(offset = 0, limit = 50, ids?: string[]) {
		const board = this.board();
		const available = scopedNodes(board, this.context(), this.sessionId === "user" ? undefined : this.sessionId);
		if (ids?.some((id) => !available.some((n) => n.id === id))) throw new Error("请求节点不在工作范围");
		const filtered = ids ? available.filter((n) => ids.includes(n.id)) : available;
		const selected = filtered.slice(offset, offset + limit);
		const nodes = await Promise.all(
			selected.map(async (node) => {
				if (node.kind === "agent") return { ...node, session: await this.sessionSummary?.(node.entityId!) };
				if (node.kind === "search_graph") return { ...node, source: { kind: "search_run", searchRunId: node.entityId }, readingEnabled: false };
				if (node.kind !== "paper") return node;
				const resolved = await resolveCanvasPaper(this.library, node);
				if (!resolved.personal)
					return {
						...node,
						paper: paperMetadata(resolved.paper),
						available: !!resolved.paper,
						readingEnabled: false,
					};
				const source = await paperSource(this.library, resolved.personal.id);
				return {
					...node,
					entityId: source.paper?.id ?? node.entityId,
					paper: paperMetadata(source.paper),
					readingEnabled: Boolean(source.paper),
					available: Boolean(source.paper),
					pdf: source.preferred ? { sha256: source.preferred.sha256, path: source.preferred.blobPath } : undefined,
					mineru: source.material ? { id: source.material.id, pageCount: source.material.pageCount } : undefined,
					staleMaterial: source.staleMaterial,
					notes: source.notes.map((n) => ({ id: n.id, title: n.title, revision: n.revision })),
				};
			}),
		);
		const visible = new Set(available.map((n) => n.id));
		return {
			revision: board.revision,
			total: filtered.length,
			offset,
			nextOffset: offset + nodes.length < filtered.length ? offset + nodes.length : undefined,
			nodes,
			edges: board.edges.filter(
				(e) => visible.has(e.from) && visible.has(e.to) && selected.some((n) => n.id === e.from || n.id === e.to),
			),
			groups: (board.groups ?? []).filter(
				(g) => this.context().scope === "canvas" || available.some((n) => n.groupId === g.id),
			),
		};
	}
	async analysis(id: string, offset = 0, limit = 50) {
		return readResearchAnalysis(this, id, offset, limit);
	}
	async saveAnalysis(input: unknown, id?: string, expectedRevision?: number) {
		return new CanvasAnalysisWriter(this).save(input, id, expectedRevision);
	}
	async layoutProposal(mode: ResearchLayout, analysisId: string, reason: string) {
		const run = await this.analysis(analysisId, 0, 500);
		if (run.freshness !== "current") throw new Error("分析已过期，请继续研究后生成布局");
		const inventory = await this.inventory(run.value.scope, false);
		const normalized = new Map(inventory.nodes.map((n) => [n.id, n]));
		const board = this.board();
		const years = new Map(
			await Promise.all(
				run.value.paperIds.map(async (id) => [id, (await this.library.getPaper(id))?.year] as const),
			),
		);
		const operations = researchLayout(
			{ ...board, nodes: board.nodes.map((n) => normalized.get(n.id) ?? n) },
			run.value,
			analysisId,
			mode,
			years,
		);
		return this.preview({ reason, analysisId, operations });
	}
	async preview(input: { reason: string; operations: unknown; analysisId?: string }) {
		if (input.analysisId && (await this.analysis(input.analysisId)).freshness !== "current")
			throw new Error("分析来源或目标已变化，请继续研究后重新预览");
		const board = this.board();
		const operations = parseChangeOperations(input.operations);
		const snapshot = await this.inventory();
		const visible = new Set(snapshot.nodes.map((n) => n.id));
		const newIds = new Set(operations.flatMap((op) => (op.kind === "add_node" ? [op.node.id] : [])));
		for (const op of operations) {
			if (op.kind === "add_node" && op.node.kind !== "paper" && op.node.kind !== "text")
				throw new Error("研究提案仅能新增论文或总结文本卡；作者、团队请使用 propose_canvas_nodes");
			if (op.kind === "add_node" && op.node.kind === "text") {
				if (!input.analysisId || !this.records.get("analysis", input.analysisId))
					throw new Error("研究总结卡必须关联分析记录");
				op.node.generatedFrom = { analysisId: input.analysisId };
			}
			if (op.kind === "add_edge" && op.edge.research)
				op.edge.research = {
					...op.edge.research,
					createdBy: this.sessionId,
					reviewStatus: "pending",
					analysisId: input.analysisId,
				};
			if (op.kind === "move_node" && !visible.has(op.nodeId) && !newIds.has(op.nodeId))
				throw new Error("移动节点不在工作范围");
			if (op.kind === "add_edge" && [op.edge.from, op.edge.to].some((id) => !visible.has(id) && !newIds.has(id)))
				throw new Error("关系端点不在工作范围");
			if (op.kind === "add_edge" && op.edge.research)
				await checkEvidence(this.library, op.edge.research.evidence, snapshot.paperIds);
		}
		applyCanvasOperations(
			board,
			operations,
			operations.map((op) => op.id),
		);
		for (const op of operations) {
			if (op.kind === "add_node" && op.node.kind === "paper" && !(await this.library.getPaper(op.node.entityId!)))
				throw new Error("新增论文必须已在当前个人库");
		}
		const value: CanvasChangeProposal = {
			reason: input.reason.slice(0, 4000),
			analysisId: input.analysisId,
			baseRevision: board.revision,
			sourceHash: snapshot.inputHash,
			scope: this.context(),
			operations,
			status: "pending",
			warnings: [],
		};
		return this.records.save("proposal", value, this.sessionId);
	}
	async apply(id: string, selectedIds: string[], revision: number, undo = false) {
		const proposal = this.records.get<CanvasChangeProposal>("proposal", id);
		if (!proposal) throw new Error("提案不存在");
		if (proposal.value.purpose === "editing") {
			if (!undo && proposal.value.status === "pending")
				await validateCanvasNodeProposal(this, proposal.value, selectedIds, proposal.sessionId);
			return this.records.commitProposal(id, selectedIds, revision, undo);
		}
		if (
			!undo &&
			proposal.value.status === "pending" &&
			proposal.value.analysisId &&
			(await this.analysis(proposal.value.analysisId)).freshness !== "current"
		)
			throw new Error("提案引用的研究证据已变化，请重新预览");
		if (
			!undo &&
			proposal.value.status === "pending" &&
			proposal.value.sourceHash !== (await this.inventory(proposal.value.scope)).inputHash
		)
			throw new Error("研究来源或目标已变化，请重新生成预览");
		if (!undo && proposal.value.status === "pending") {
			const selected = new Set(selectedChangeIds(proposal.value.operations, selectedIds));
			const inventory = await this.inventory(proposal.value.scope);
			for (const op of proposal.value.operations)
				if (selected.has(op.id) && op.kind === "add_edge" && op.edge.research)
					await checkEvidence(this.library, op.edge.research.evidence, inventory.paperIds);
		}
		return this.records.commitProposal(id, selectedIds, revision, undo);
	}
}
