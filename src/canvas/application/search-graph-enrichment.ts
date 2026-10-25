import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundJobContext } from "../../shared/domain/background-job.ts";
import type { Fetcher } from "../../shared/infrastructure/network-security.ts";
import { LiteratureProviderHttpError } from "../../literature/infrastructure/provider-common.ts";
import { fetchGraphCitationPage, graphProvider } from "../infrastructure/search-graph-provider.ts";
import type { SearchRunGraphs } from "./search-run-graphs.ts";
export interface GraphEnrichmentInput {
	canvasId: string;
	runId: string;
	budget: number;
	fingerprint: string;
}
type QueueItem = {
	paper: import("../../literature/domain/literature-types.ts").PaperRecord;
	channel: "references" | "citations";
};
type Options = { fetcher?: Fetcher; spacingMs?: number };
class EnrichmentRound {
	attempts: number;
	readonly retries = new Map<string, number>();
	readonly unavailable = new Set<string>();
	readonly providerDeadline = new Map<string, string>();
	readonly graphs: SearchRunGraphs;
	readonly input: GraphEnrichmentInput;
	readonly context: BackgroundJobContext;
	readonly options: Options;
	readonly features: import("../domain/search-graph-relations.ts").GraphFeatures;
	readonly queue: QueueItem[];
	constructor(
		graphs: SearchRunGraphs,
		input: GraphEnrichmentInput,
		context: BackgroundJobContext,
		options: Options,
		features: import("../domain/search-graph-relations.ts").GraphFeatures,
		queue: QueueItem[],
	) {
		this.graphs = graphs;
		this.input = input;
		this.context = context;
		this.options = options;
		this.features = features;
		this.queue = queue;
		this.attempts = context.checkpoint?.<{ attempts: number }>()?.attempts ?? 0;
	}
	save() {
		this.graphs.views.saveResearch(this.input.runId, {
			features: { ...this.graphs.views.getResearch(this.input.runId).features, ...this.features },
			attempts: this.attempts,
		});
		this.context.saveCheckpoint?.({ attempts: this.attempts });
	}
	async page(item: QueueItem) {
		const set = this.features[item.paper.id][item.channel],
			key = `${item.paper.id}:${item.channel}`;
		const page = await fetchGraphCitationPage(
			item.paper,
			item.channel,
			set,
			this.context.signal,
			this.options.fetcher,
		);
		const merged = [...new Set([...set.ids, ...page.ids])],
			previousCursor = set.cursor;
		Object.assign(set, {
			ids: merged.slice(0, 500),
			provider: page.provider,
			collectedAt: new Date().toISOString(),
			cursor: page.cursor,
			status: page.cursor || merged.length > 500 ? "partial" : "complete",
			capped: merged.length > 500 || Boolean(page.cursor && merged.length >= 500),
			error: undefined,
			retryAfter: undefined,
		});
		if (page.cursor && page.cursor === previousCursor) {
			set.error = "提供商分页游标未推进";
			this.unavailable.add(key);
		} else if (page.cursor && !set.capped) this.queue.push(item);
	}
	failure(item: QueueItem, error: unknown) {
		this.context.signal.throwIfAborted();
		const set = this.features[item.paper.id][item.channel],
			key = `${item.paper.id}:${item.channel}`,
			{ provider } = graphProvider(item.paper);
		set.error = error instanceof Error ? error.message : String(error);
		if (error instanceof LiteratureProviderHttpError) {
			set.retryAfter =
				error.retryAfter ?? (error.statusCode === 429 ? new Date(Date.now() + 60_000).toISOString() : undefined);
			if (set.retryAfter) this.providerDeadline.set(provider, set.retryAfter);
		}
		const count = (this.retries.get(key) ?? 0) + 1;
		this.retries.set(key, count);
		const retryable =
			!(error instanceof LiteratureProviderHttpError) || error.statusCode === 429 || error.statusCode >= 500;
		if (retryable && count < 3) this.queue.push(item);
		else this.unavailable.add(key);
	}
	async attempt(item: QueueItem) {
		const set = this.features[item.paper.id][item.channel],
			key = `${item.paper.id}:${item.channel}`,
			{ provider, id } = graphProvider(item.paper);
		if (!id) {
			set.error = "缺少可解析的提供商身份";
			this.unavailable.add(key);
			return;
		}
		set.retryAfter = this.providerDeadline.get(provider) ?? set.retryAfter;
		if (set.retryAfter && Date.parse(set.retryAfter) > Date.now()) {
			set.error = `限流，${set.retryAfter} 后可继续`;
			this.unavailable.add(key);
			return;
		}
		await delay(this.options.spacingMs ?? 1100, undefined, { signal: this.context.signal });
		this.attempts++;
		this.save(); // Interrupted HTTP requests still consume the budget.
		try {
			await this.page(item);
		} catch (error) {
			this.failure(item, error);
		}
		this.save();
		this.context.report(
			Math.min(0.99, this.attempts / this.input.budget),
			`补全关系：${this.attempts}/${this.input.budget} 次请求；剩余 ${this.queue.length} 个集合`,
		);
	}
	async execute() {
		try {
			while (this.queue.length && this.attempts < this.input.budget) {
				this.context.signal.throwIfAborted();
				await this.attempt(this.queue.shift()!);
			}
		} finally {
			this.save();
		}
		const sets = Object.values(this.features).flatMap((f) => [f.references, f.citations]);
		const result = {
			attempts: this.attempts,
			budgetExhausted: this.queue.length > 0 && this.attempts >= this.input.budget,
			failed: sets.filter((s) => s.error).length,
			complete: sets.filter((s) => s.status === "complete").length,
			empty: sets.filter((s) => s.status === "complete" && !s.ids.length).length,
			rateLimited: sets.filter((s) => s.retryAfter || s.error?.includes("429")).length,
			capped: sets.filter((s) => s.capped).length,
		};
		await this.graphs.research(this.input.runId);
		this.context.report(
			1,
			`关系补全结束：${result.complete} 个完整集合，${result.failed} 个失败/待重试，${result.capped} 个达到采集上限；${result.budgetExhausted ? "预算耗尽" : "可应用新布局"}`,
		);
		return result;
	}
}
export async function enrichSearchGraph(
	graphs: SearchRunGraphs,
	input: GraphEnrichmentInput,
	context: BackgroundJobContext,
	options: Options = {},
) {
	const research = await graphs.research(input.runId);
	if (research.fingerprint !== input.fingerprint && !context.checkpoint?.())
		throw new Error("图谱材料已变化，请重新检查补全计划");
	const { papers, features } = research;
	const queue = papers
		.flatMap((paper) => (["references", "citations"] as const).map((channel) => ({ paper, channel })))
		.filter(
			({ paper, channel }) =>
				features[paper.id][channel].status !== "complete" && !features[paper.id][channel].capped,
		)
		.sort(
			(a, b) =>
				Number(Boolean(features[a.paper.id][a.channel].cursor)) -
				Number(Boolean(features[b.paper.id][b.channel].cursor)),
		);
	return new EnrichmentRound(graphs, input, context, options, features, queue).execute();
}
