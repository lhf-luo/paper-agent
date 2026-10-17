import type { CanvasResearchAnalysis, CanvasSearchPlan } from "../domain/canvas-research.ts";
import { object, parseSearchPlan, text } from "../domain/canvas-research-validation.ts";
import type { CanvasResearchService } from "./canvas-research-service.ts";

const externalSearchTools = new Set([
	"collect_literature",
	"search_literature",
	"expand_citation_network",
	"find_author_papers",
]);
export class CanvasResearchSearch {
	private readonly calls = new Map<string, string>();
	readonly service: CanvasResearchService;
	constructor(service: CanvasResearchService) {
		this.service = service;
	}
	create(input: unknown) {
		const raw = object(input);
		const analysis = this.service.records.get<CanvasResearchAnalysis>("analysis", text(raw.analysisId, 80));
		if (!analysis || analysis.sessionId !== this.service.sessionId) throw new Error("补搜计划必须关联当前会话的分析");
		const settings = analysis.value.settings;
		const plan = parseSearchPlan({
			dateFrom: settings.dateFrom,
			dateTo: settings.dateTo,
			callBudget: Math.min(4, settings.searchCallBudget),
			resultsPerProvider: settings.resultsPerProvider,
			...raw,
		});
		if (
			plan.queries.length > settings.queryBudget ||
			plan.callBudget > settings.searchCallBudget ||
			plan.resultsPerProvider > settings.resultsPerProvider
		)
			throw new Error("补搜计划超过画布预算，请先修改研究设置");
		return this.service.records.save("search", plan, this.service.sessionId);
	}
	decide(id: string, approved: boolean, revision: number) {
		const old = this.service.records.get<CanvasSearchPlan>("search", id);
		if (!old || old.value.status !== "pending") throw new Error("待审批的补搜计划不存在");
		return this.service.records.save(
			"search",
			{ ...old.value, status: approved ? "approved" : "rejected" },
			old.sessionId,
			id,
			revision,
		);
	}
	async before(tool: string, input: Record<string, unknown>, callId: string): Promise<string | undefined> {
		if (!externalSearchTools.has(tool)) return undefined;
		Object.assign(input, { namespace: this.service.namespace, scope: "personal", mode: "once" });
		delete input.corpus_root;
		if (tool === "collect_literature" && input.corpus_only === true) return undefined;
		const plans = this.service.records.list<CanvasSearchPlan>("search");
		const approved = plans.find((r) => r.sessionId === this.service.sessionId && r.value.status === "approved");
		if (!approved) return "请先通过 save_canvas_analysis 的 search_plan 保存补搜计划，并在画布研究面板等待用户接受。";
		const p = approved.value;
		if (p.callsUsed >= p.callBudget) return "本轮检索预算已用完，请提出新的补搜计划。";
		const run = this.service.records.get<CanvasResearchAnalysis>("analysis", p.analysisId);
		if (!run || (await this.service.analysis(run.id)).freshness !== "current")
			return "研究目标或来源已变化，请更新分析并重新提出补搜计划。";
		const reason = validatePlanRequest(tool, input, p, run.value);
		if (reason) return reason;
		bindSearchInput(tool, input, p, this.service.namespace);
		this.service.records.save(
			"search",
			{ ...p, callsUsed: p.callsUsed + 1 },
			approved.sessionId,
			approved.id,
			approved.revision,
		);
		this.calls.set(callId, approved.id);
		return undefined;
	}
	after(callId: string, details: unknown): void {
		const id = this.calls.get(callId);
		this.calls.delete(callId);
		if (!id || !details || typeof details !== "object") return;
		const value = details as Record<string, unknown>;
		const runId = value.searchRunId ?? value.search_run_id ?? value.expansionRunId;
		if (typeof runId !== "string") return;
		const plan = this.service.records.get<CanvasSearchPlan>("search", id);
		if (!plan) return;
		this.service.records.save(
			"search",
			{ ...plan.value, searchRunIds: [...new Set([...plan.value.searchRunIds, runId])] },
			plan.sessionId,
			id,
			plan.revision,
		);
		const run = this.service.records.get<CanvasResearchAnalysis>("analysis", plan.value.analysisId);
		if (run)
			this.service.records.save(
				"analysis",
				{ ...run.value, searchRunIds: [...new Set([...run.value.searchRunIds, runId])] },
				run.sessionId,
				run.id,
				run.revision,
			);
	}
}

function validatePlanRequest(
	tool: string,
	input: Record<string, unknown>,
	p: CanvasSearchPlan,
	run: CanvasResearchAnalysis,
): string | undefined {
	if (
		(tool === "expand_citation_network") !== (p.strategy === "citations") ||
		(tool === "find_author_papers") !== (p.strategy === "author")
	)
		return "检索方式与已接受的补搜计划不同。";
	const queries =
		tool === "expand_citation_network"
			? []
			: [input.query ?? input.author_name, ...(Array.isArray(input.query_expansions) ? input.query_expansions : [])];
	if (queries.some((q) => typeof q !== "string" || !p.queries.includes(q))) return "查询词超出已接受的补搜计划。";
	if (
		input.providers &&
		(!Array.isArray(input.providers) || input.providers.some((provider) => !p.providers.includes(String(provider))))
	)
		return "提供商超出补搜计划。";
	const fixedProviders =
		tool === "search_literature"
			? ["arxiv", "openalex", "crossref"]
			: tool === "find_author_papers"
				? ["openalex", "semanticscholar", "dblp"]
				: tool === "expand_citation_network"
					? ["openalex", "semanticscholar"]
					: [];
	if (fixedProviders.some((provider) => !p.providers.includes(provider)))
		return `该工具固定使用 ${fixedProviders.join("、")}，超出本轮提供商授权；请选择 collect_literature 或重新提出计划。`;
	if (
		tool === "expand_citation_network" &&
		(!Array.isArray(input.seed_ids) || input.seed_ids.some((id) => !run.paperIds.includes(String(id))))
	)
		return "引用扩展种子需来自本轮研究论文。";
	if (tool === "find_author_papers" && !run.paperIds.includes(String(input.paper_id)))
		return "作者扩展种子需来自本轮研究论文。";
	return undefined;
}

function bindSearchInput(tool: string, input: Record<string, unknown>, p: CanvasSearchPlan, namespace: string): void {
	Object.assign(input, { namespace, scope: "personal", mode: "once" });
	if (tool === "collect_literature")
		Object.assign(input, {
			providers: p.providers,
			auto_expand: false,
			reuse_corpus: true,
			max_results_per_provider: Math.min(
				Number(input.max_results_per_provider ?? p.resultsPerProvider),
				p.resultsPerProvider,
			),
		});
	if (tool === "search_literature")
		input.max_results_per_source = Math.min(Number(input.max_results_per_source ?? 20), p.resultsPerProvider, 100);
	if (tool === "find_author_papers")
		input.max_results_per_provider = Math.min(Number(input.max_results_per_provider ?? 100), p.resultsPerProvider);
	if (tool === "expand_citation_network")
		Object.assign(input, {
			depth: 1,
			max_total_neighbors: Math.min(Number(input.max_total_neighbors ?? 100), 100),
			max_neighbors_per_seed: Math.min(Number(input.max_neighbors_per_seed ?? 50), 100),
		});
	if (p.dateFrom) input.year_from = Number(p.dateFrom.slice(0, 4));
	if (p.dateTo) input.year_to = Number(p.dateTo.slice(0, 4));
	if (p.dateFrom) input.arxiv_submitted_from = p.dateFrom;
	if (p.dateTo) input.arxiv_submitted_to = p.dateTo;
}
