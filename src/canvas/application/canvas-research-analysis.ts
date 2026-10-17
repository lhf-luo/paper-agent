import { randomUUID } from "node:crypto";
import { derivedCacheKey } from "../../literature/application/literature-store.ts";
import type {
	CanvasMethodCard,
	CanvasResearchAnalysis,
	CanvasResearchRecord,
	CanvasResearchSettings,
} from "../domain/canvas-research.ts";
import { object, parseAnalysisContent } from "../domain/canvas-research-validation.ts";
import { checkEvidence, researchSources } from "./canvas-research-materials.ts";
import type { CanvasResearchService } from "./canvas-research-service.ts";

type Snapshot = Pick<CanvasResearchAnalysis, "scope" | "settings" | "nodeIds" | "paperIds" | "sources" | "inputHash">;
const coverageRank = { unread: 0, abstract: 1, method: 2, full: 3 };
function cardConfig(s: CanvasResearchSettings) {
	return [s.question, s.dimensions, s.scenario, s.include, s.exclude, s.readingDepth];
}
function cardKey(hash: string, settings: CanvasResearchSettings) {
	return derivedCacheKey({
		inputHashes: [hash],
		operation: "canvas-method-card",
		pipelineVersion: "1",
		normalizedConfig: cardConfig(settings),
	});
}
export class CanvasAnalysisWriter {
	readonly service: CanvasResearchService;
	constructor(service: CanvasResearchService) {
		this.service = service;
	}
	async save(input: unknown, id?: string, expectedRevision?: number) {
		const { service: s } = this;
		const old = id ? s.records.get<CanvasResearchAnalysis>("analysis", id) : undefined;
		if (id && !old) throw new Error("分析不存在");
		if (old && old.sessionId !== s.sessionId) throw new Error("请在自己的会话创建分析，可复用其他会话的方法卡");
		const content = parseAnalysisContent({ ...old?.value, ...object(input) });
		const snapshot = old ? fixedInputs(old.value) : await this.snapshot();
		const sources = await researchSources(s.library, snapshot.paperIds);
		const cards = await this.readCards(snapshot, old);
		const reused = new Set(old?.value.reusedPaperIds ?? cards.keys());
		const reusedDeep = new Set(
			old?.value.reusedDeepPaperIds ??
				[...cards.values()]
					.filter((c) => reused.has(c.paperId) && coverageRank[c.coverage] >= 2)
					.map((c) => c.paperId),
		);
		await this.mergeCards(cards, content.cards, snapshot, sources);
		const roundId = old?.value.roundId ?? s.currentRoundId ?? randomUUID();
		const newlyReadPaperIds = this.checkBudget(cards, reusedDeep, snapshot.settings, roundId);
		const value: CanvasResearchAnalysis = {
			roundId,
			newlyReadPaperIds,
			...content,
			...snapshot,
			cards: [...cards.values()],
			reusedPaperIds: [...reused],
			reusedDeepPaperIds: [...reusedDeep],
		};
		if (
			value.status === "completed" &&
			(value.paperIds.length === 0 ||
				cards.size < value.paperIds.length ||
				value.cards.some((c) => coverageRank[c.coverage] < 2) ||
				value.paperIds.some((p) => sources[p] !== value.sources[p]))
		)
			value.status = "partial";
		const analysisId = id ?? randomUUID();
		await this.checkRelations(value, analysisId);
		await this.checkCandidates(value);
		const result = s.records.save("analysis", value, s.sessionId, analysisId, expectedRevision);
		await this.cacheCards(
			result,
			content.cards.map((c) => cards.get(c.paperId)!),
		);
		return result;
	}
	private async snapshot(): Promise<Snapshot> {
		const i = await this.service.inventory();
		return {
			scope: this.service.context(),
			settings: i.settings,
			nodeIds: i.nodes.map((n) => n.id),
			paperIds: i.paperIds,
			sources: i.sources,
			inputHash: i.inputHash,
		};
	}
	private async readCards(snapshot: Snapshot, old?: CanvasResearchRecord<CanvasResearchAnalysis>) {
		const cards = new Map(old?.value.cards.map((c) => [c.paperId, c]) ?? []);
		if (old) return cards;
		for (const paperId of snapshot.paperIds) {
			const cached = await this.service.library.getDerived(cardKey(snapshot.sources[paperId], snapshot.settings));
			if (!cached) continue;
			const card = cached.result as CanvasMethodCard;
			try {
				await checkEvidence(this.service.library, card.evidence, snapshot.paperIds);
				cards.set(paperId, card);
			} catch {
				/* Recompute only cards whose cited note or PDF has changed. */
			}
		}
		return cards;
	}
	private async mergeCards(
		cards: Map<string, CanvasMethodCard>,
		updates: CanvasMethodCard[],
		snapshot: Snapshot,
		sources: Record<string, string>,
	) {
		for (const card of updates) {
			if (!(await this.service.library.getPaper(card.paperId)) && card.coverage !== "unread")
				throw new Error("论文来源不可用，只能记录未读项");
			if (!snapshot.paperIds.includes(card.paperId)) throw new Error("方法卡论文不在本轮范围");
			if (sources[card.paperId] !== snapshot.sources[card.paperId])
				throw new Error("论文材料已变化，请新建分析并复用有效卡片");
			if (coverageRank[card.coverage] >= 2 && !snapshot.settings.question.trim())
				throw new Error("深入研究前请确定画布研究问题");
			if (
				coverageRank[card.coverage] >= 2 &&
				!card.evidence.some((e) => e.paperId === card.paperId && ["text", "pdf"].includes(e.level))
			)
				throw new Error("方法卡需要这篇论文本身的正文证据");
			await checkEvidence(this.service.library, card.evidence, snapshot.paperIds);
			const previous = cards.get(card.paperId);
			if (!previous || coverageRank[card.coverage] >= coverageRank[previous.coverage]) cards.set(card.paperId, card);
		}
	}
	private checkBudget(
		cards: Map<string, CanvasMethodCard>,
		reused: Set<string>,
		settings: CanvasResearchSettings,
		roundId: string,
	): string[] {
		const newlyRead = [...cards.values()].filter((c) => !reused.has(c.paperId) && coverageRank[c.coverage] >= 2);
		const alreadyRead = this.service.records
			.list<CanvasResearchAnalysis>("analysis")
			.filter((r) => r.value.roundId === roundId)
			.flatMap((r) => r.value.newlyReadPaperIds ?? []);
		const total = [...new Set([...alreadyRead, ...newlyRead.map((c) => c.paperId)])];
		if (settings.readingDepth === "layered" && total.length > settings.readingBudget)
			throw new Error("超出本轮深入阅读预算，请扩大预算后新建分析");
		return total;
	}
	private async checkRelations(value: CanvasResearchAnalysis, id: string) {
		for (const r of value.relations) {
			r.relation.createdBy = this.service.sessionId;
			r.relation.analysisId = id;
			r.relation.reviewStatus = "pending";
			if (!value.nodeIds.includes(r.from) || !value.nodeIds.includes(r.to))
				throw new Error("关系端点不在本轮节点清单");
			await checkEvidence(this.service.library, r.relation.evidence, value.paperIds);
		}
	}
	private async cacheCards(record: CanvasResearchRecord<CanvasResearchAnalysis>, cards: CanvasMethodCard[]) {
		for (const card of cards) {
			if (!(await this.service.library.getPaper(card.paperId))) continue;
			const hash = record.value.sources[card.paperId],
				settings = record.value.settings;
			await this.service.library.putDerived(
				{
					key: cardKey(hash, settings),
					paperId: card.paperId,
					operation: "canvas-method-card",
					inputHashes: [hash],
					pipelineVersion: "1",
					normalizedConfig: cardConfig(settings),
					createdAt: record.updatedAt,
					createdBy: this.service.sessionId,
					result: card,
				},
				{ replace: true },
			);
		}
	}
	private async checkCandidates(value: CanvasResearchAnalysis) {
		const runs = new Map<string, Set<string>>();
		for (const c of value.candidates ?? []) {
			if (!value.searchRunIds.includes(c.searchRunId)) throw new Error("候选推荐必须来自本轮 Search Run");
			if (!runs.has(c.searchRunId))
				runs.set(
					c.searchRunId,
					new Set((await this.service.library.getSearchRun(c.searchRunId))?.results.map((p) => p.id) ?? []),
				);
			if (!runs.get(c.searchRunId)!.has(c.paperId)) throw new Error("候选论文不属于此 Search Run");
		}
	}
}
function fixedInputs(a: CanvasResearchAnalysis): Snapshot {
	return {
		scope: a.scope,
		settings: a.settings,
		nodeIds: a.nodeIds,
		paperIds: a.paperIds,
		sources: a.sources,
		inputHash: a.inputHash,
	};
}
