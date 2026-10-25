import type { CanvasResearchService } from "./canvas-research-service.ts";

const searches = new Set(["collect_literature", "search_literature", "expand_citation_network", "find_author_papers"]);

/** Bounds explicit canvas searches without requiring a research analysis or a saved plan. */
export class CanvasSearchSession {
	private calls = 0;
	private readonly service: CanvasResearchService;
	constructor(service: CanvasResearchService) {
		this.service = service;
	}
	beginRound() {
		this.calls = 0;
	}
	async before(tool: string, input: Record<string, unknown>): Promise<string | undefined> {
		if (!searches.has(tool)) return undefined;
		Object.assign(input, { scope: "personal", mode: "once" });
		delete input.corpus_root;
		if (tool === "collect_literature" && input.corpus_only === true) return undefined;
		const settings = this.service.settings().value;
		if (this.calls >= settings.searchCallBudget) return "本轮检索预算已用完，请先向用户说明，再在下一轮继续。";
		if (tool === "expand_citation_network") {
			if (!Array.isArray(input.seed_ids) || !input.seed_ids.length) return "请选择已入库的种子论文";
			for (const id of input.seed_ids)
				if (typeof id !== "string" || !(await this.service.library.getPaper(id)))
					return "引用扩展种子必须已在个人库";
			Object.assign(input, {
				depth: 1,
				max_total_neighbors: Math.min(Number(input.max_total_neighbors ?? 100), 100),
				max_neighbors_per_seed: Math.min(Number(input.max_neighbors_per_seed ?? 50), settings.resultsPerProvider),
			});
		}
		if (tool === "find_author_papers" && !(await this.service.library.getPaper(String(input.paper_id))))
			return "作者扩展种子必须已在个人库";
		if (
			tool === "collect_literature" &&
			Array.isArray(input.query_expansions) &&
			input.query_expansions.length + 1 > settings.queryBudget
		)
			return "查询变体超过本轮预算，请缩小范围。";
		if (tool === "collect_literature")
			Object.assign(input, {
				auto_expand: false,
				reuse_corpus: false,
				max_results_per_provider: Math.min(
					Number(input.max_results_per_provider ?? 100),
					settings.resultsPerProvider,
				),
			});
		if (tool === "search_literature")
			input.max_results_per_source = Math.min(
				Number(input.max_results_per_source ?? 20),
				settings.resultsPerProvider,
			);
		if (tool === "find_author_papers")
			input.max_results_per_provider = Math.min(
				Number(input.max_results_per_provider ?? 100),
				settings.resultsPerProvider,
			);
		this.calls++;
		return undefined;
	}
}
