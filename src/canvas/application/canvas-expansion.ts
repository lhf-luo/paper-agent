import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import {
	expandCitationNetwork,
	validateCitationExpansion,
} from "../../literature/application/literature-citation-expansion.ts";
import { collectAuthorPapers } from "../../literature/application/literature-author-expansion.ts";
import { ResearchCanvasStore } from "../infrastructure/research-canvas-store.ts";
import { SearchRunGraphs } from "./search-run-graphs.ts";
import type { BackgroundJobContext } from "../../shared/domain/background-job.ts";
export interface CanvasExpansionInput {
	canvasId: string;
	paperId: string;
	kind: "citation" | "author";
	requestId: string;
	direction: "references" | "citations" | "both";
	authorName?: string;
	yearFrom?: number;
	yearTo?: number;
	limit: number;
}
export async function validateCanvasExpansion(store: LiteratureStore, input: CanvasExpansionInput) {
	if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 100)
		throw new Error("缺少有效的请求标识");
	if (!new ResearchCanvasStore(store.databasePath).get(input.canvasId)) throw new Error("画布不存在");
	if (!["citation", "author"].includes(input.kind)) throw new Error("扩展类型无效");
	const seed = await store.getPaper(input.paperId);
	if (!seed) throw new Error("请选择个人库中的起点论文");
	validateCitationExpansion({
		seed_ids: [seed.id],
		direction: input.direction,
		year_from: input.yearFrom,
		year_to: input.yearTo,
		max_neighbors_per_seed: input.limit,
	});
	if (
		input.kind === "author" &&
		(!input.authorName || seed.authors.filter((a) => a === input.authorName).length !== 1)
	)
		throw new Error("请选择起点论文中唯一匹配的作者");
	return seed;
}
export async function executeCanvasExpansion(
	store: LiteratureStore,
	input: CanvasExpansionInput,
	context: BackgroundJobContext,
) {
	const seed = await validateCanvasExpansion(store, input);
	context.report(0.05, "正在查询论文来源");
	const run =
		input.kind === "citation"
			? (
					await expandCitationNetwork(
						store,
						{
							seed_ids: [input.paperId],
							direction: input.direction,
							year_from: input.yearFrom,
							year_to: input.yearTo,
							depth: 1,
							pages_per_seed: 3,
							max_neighbors_per_seed: input.limit,
							max_total_neighbors: input.limit,
						},
						context.signal,
						(message) => context.report(0.35, message),
					)
				).run
			: await collectAuthorPapers({
					seed,
					authorName: input.authorName!,
					yearFrom: input.yearFrom,
					yearTo: input.yearTo,
					maxResultsPerProvider: input.limit,
					signal: context.signal,
				});
	context.signal.throwIfAborted();
	if (input.kind === "author") await store.saveSearchRun(run);
	context.saveCheckpoint?.({ searchRunId: run.id });
	// Canvas may have been deleted while the provider was running. Keep the Search Run regardless.
	const available = Boolean(new ResearchCanvasStore(store.databasePath).get(input.canvasId));
	if (available) await new SearchRunGraphs(store, input.canvasId).show(run.id, "user");
	context.report(
		1,
		`取得 ${run.results.length} 篇论文；${run.failures.length ? `${run.failures.length} 项来源失败，保留部分结果` : "扩展完成"}${available ? "" : "；原画布已删除，结果保留在搜索记录"}`,
	);
	return { searchRunId: run.id, resultCount: run.results.length, failures: run.failures, graphOpened: available };
}
