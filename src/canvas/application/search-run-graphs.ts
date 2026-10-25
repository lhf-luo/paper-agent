import { graphProvider } from "../infrastructure/search-graph-provider.ts";
import { createHash } from "node:crypto";
import { unionPapers } from "../../literature/domain/citation-seeds.ts";
import {
	calculateRelations,
	existingFeatures,
	sparseRelations,
	GRAPH_ALGORITHM,
} from "../domain/search-graph-relations.ts";
import { dirname } from "node:path";
import { fingerprintSearchRun, readFilterResult } from "../../literature/application/literature-filter-result.ts";
import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import type { SearchRun } from "../../literature/domain/literature-types.ts";
import { samePaper } from "../domain/canvas-graph.ts";
import type { CanvasGraphState } from "../domain/canvas-graph.ts";
import { SearchRunGraphStore } from "../infrastructure/search-run-graph-store.ts";

export class SearchRunGraphs {
	readonly views: SearchRunGraphStore;
	readonly library: LiteratureStore;
	readonly canvasId: string;
	constructor(library: LiteratureStore, canvasId: string) {
		this.library = library;
		this.canvasId = canvasId;
		this.views = new SearchRunGraphStore(library.databasePath, canvasId);
	}
	async run(id: string): Promise<SearchRun> {
		const run = await this.library.getSearchRun(id);
		if (!run) throw new Error("Search Run 不存在，原搜索结果可能已被删除");
		return run;
	}
	async results(run: SearchRun, filterId?: string, sessionId?: string) {
		if (!filterId) return run.results;
		const root = dirname(dirname(dirname(this.library.root)));
		const filter = await readFilterResult(root, sessionId === "user" ? undefined : sessionId, filterId);
		if (filter.searchRunId !== run.id || filter.runFingerprint !== fingerprintSearchRun(run))
			throw new Error("筛选结果已过期或不属于此 Search Run");
		const ids = new Set(filter.entries.map((e) => e.paperId));
		return run.results.filter((p) => ids.has(p.id));
	}
	async show(runId: string, sessionId: string, filterResultId?: string) {
		const run = await this.run(runId);
		const results = await this.results(run, filterResultId, sessionId);
		const old = this.views.get(runId);
		const prefix =
			run.runKind === "citation-expansion"
				? "引用检索"
				: run.runKind === "author-expansion"
					? "作者检索"
					: "论文检索";
		const graph = this.views.save({
			runId,
			sessionId,
			filterResultId,
			title:
				old?.title ??
				`${prefix}：${run.authorExpansion?.authorName ?? run.seedSnapshots?.[0]?.title ?? run.queries[0] ?? run.id}`,
			openedAt: new Date(Math.max(Date.now(), old ? Date.parse(old.openedAt) + 1 : 0)).toISOString(),
			closed: false,
			state: old?.state ?? { revision: 0, positions: {}, viewport: { x: 0, y: 0, scale: 1 } },
		});
		const projection = await this.projection(runId);
		return {
			searchRunId: runId,
			resultCount: run.results.length,
			displayedCount: projection.papers.length,
			matchedCount: results.length,
			seedCount: projection.seeds.length,
			status: "ready",
			title: graph.title,
		};
	}
	async projection(runId: string) {
		const view = this.views.get(runId);
		if (!view) throw new Error("搜索图谱不存在");
		const run = await this.run(runId);
		const results = await this.results(run, view.filterResultId, view.sessionId);
		const seedIds = new Set(run.runKind === "citation-expansion" ? run.seedPaperIds : []);
		const seeds = run.results.filter((paper) => seedIds.has(paper.id));
		return { run, view, seeds, results, papers: unionPapers([...seeds, ...results]) };
	}
	async research(runId: string) {
		const projection = await this.projection(runId);
		const saved = this.views.getResearch(runId);
		const features = existingFeatures(projection.papers, saved.features);
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify([GRAPH_ALGORITHM.version, projection.papers.map((p) => [p.id, p.identifiers]), features]),
			)
			.digest("hex");
		const relations =
			saved.fingerprint === fingerprint && saved.relations
				? saved.relations
				: calculateRelations(projection.papers, features);
		if (saved.fingerprint !== fingerprint)
			this.views.saveResearch(runId, {
				...saved,
				features: { ...saved.features, ...features },
				fingerprint,
				relations,
			});
		return { ...projection, features, relations, fingerprint };
	}
	async enrichmentPlan(runId: string) {
		const { papers, features } = await this.research(runId);
		const complete = papers.filter(
			(p) => features[p.id].references.status === "complete" && features[p.id].citations.status === "complete",
		).length;
		return {
			total: papers.length,
			complete,
			pending: papers.filter(
				(p) =>
					graphProvider(p).id &&
					[features[p.id].references, features[p.id].citations].some((s) => s.status !== "complete" && !s.capped),
			).length,
			capped: papers.filter((p) => features[p.id].references.capped || features[p.id].citations.capped).length,
			unresolved: papers.filter((p) => !graphProvider(p).id).length,
			providers: [...new Set(papers.map((p) => (p.identifiers.openAlexId ? "OpenAlex" : "Semantic Scholar")))],
			requestBudget: 100,
			idsPerCollection: 500,
		};
	}
	applyLayout(runId: string, restore = false) {
		const view = this.views.get(runId);
		if (!view) throw new Error("搜索图谱不存在");
		const state = view.state;
		if (restore && !state.previousLayout) throw new Error("没有可恢复的布局");
		const previousLayout = {
			positions: state.positions,
			viewport: state.viewport,
			layoutVersion: state.layoutVersion,
			manualPins: state.manualPins,
		};
		const next = restore
			? { ...state, ...state.previousLayout, previousLayout, needsFit: false }
			: {
					...state,
					previousLayout,
					positions: Object.fromEntries(
						Object.entries(state.positions).filter(([id]) => state.manualPins?.includes(id)),
					),
					layoutVersion: GRAPH_ALGORITHM.version,
					needsFit: true,
				};
		this.saveState(runId, next);
		this.views.save({ ...this.views.get(runId)!, openedAt: new Date().toISOString() });
		return { applied: true };
	}

	async graph(runId: string, detailId?: string) {
		const view = this.views.get(runId);
		if (!view) throw new Error("请先打开此 Search Run 的搜索图谱");
		const { run, papers, seeds, results, features, relations, fingerprint } = await this.research(runId);
		const library = await this.library.listPapers();
		if (detailId) {
			const paper = papers.find((p) => p.id === detailId);
			if (!paper) throw new Error("论文不在当前搜索结果中");
			return {
				nodeId: paper.id,
				paper,
				libraryPaperId: library.find((p) => samePaper(p, paper))?.id,
				missingRelations: !relations.some((e) => e.from === paper.id || e.to === paper.id),
				isSeed: seeds.some((s) => samePaper(s, paper)),
				coverage: features[paper.id],
			};
		}
		return {
			canvasId: this.canvasId,
			revision: 0,
			runId,
			state: {
				...view.state,
				positions: Object.fromEntries(
					papers.flatMap((p) => {
						const position =
							view.state.positions[p.id] ?? p.mergedFrom.map((id) => view.state.positions[id]).find(Boolean);
						return position ? [[p.id, position]] : [];
					}),
				),
			},
			resultCount: run.results.length,
			matchedCount: results.length,
			seedCount: seeds.length,
			algorithmVersion: GRAPH_ALGORITHM.version,
			inputFingerprint: fingerprint,
			relationCoverage: Object.fromEntries(
				Object.entries(features).map(([id, f]) => [
					id,
					{ references: f.references.status, citations: f.citations.status },
				]),
			),
			allRelations: relations.map(({ evidence: _evidence, ...e }) => e),
			failures: run.failures,
			coverage: run.coverage,
			citationExpansion: run.citationExpansion,
			nodes: papers.map((p) => ({
				id: p.id,
				isSeed: seeds.some((s) => samePaper(s, p)),
				kind: "paper" as const,
				title: p.title,
				authors: p.authors,
				year: p.year,
				citationCount: p.citationCount,
				runIds: [runId],
				libraryPaperId: library.find((saved) => samePaper(saved, p))?.id,
				available: true,
				x: 0,
				y: 0,
			})),
			edges: sparseRelations(relations).map(({ evidence: _evidence, ...e }) => e),
		};
	}
	saveState(runId: string, state: CanvasGraphState) {
		const old = this.views.get(runId);
		if (!old) throw new Error("搜索图谱不存在");
		if (
			!state ||
			!Number.isSafeInteger(state.revision) ||
			state.revision < 0 ||
			!state.viewport ||
			!state.positions ||
			![state.viewport.x, state.viewport.y, state.viewport.scale].every(Number.isFinite) ||
			Array.isArray(state.positions) ||
			typeof state.positions !== "object" ||
			state.viewport.scale <= 0 ||
			Object.values(state.positions).some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
		)
			throw new Error("搜索图谱视图格式错误");
		if (
			state.manualPins &&
			(!Array.isArray(state.manualPins) || state.manualPins.some((id) => typeof id !== "string"))
		)
			throw new Error("固定位置格式错误");
		if (state.layoutVersion !== undefined && typeof state.layoutVersion !== "string")
			throw new Error("布局版本格式错误");
		if (state.needsFit !== undefined && typeof state.needsFit !== "boolean") throw new Error("布局适配格式错误");
		if (
			state.previousLayout &&
			(!state.previousLayout.positions ||
				!state.previousLayout.viewport ||
				![
					state.previousLayout.viewport.x,
					state.previousLayout.viewport.y,
					state.previousLayout.viewport.scale,
				].every(Number.isFinite) ||
				state.previousLayout.viewport.scale <= 0 ||
				Object.values(state.previousLayout.positions).some(
					(p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y),
				))
		)
			throw new Error("历史布局格式错误");
		if (
			state.filters &&
			["query", "year", "batch", "status"].some(
				(k) => typeof state.filters![k as keyof typeof state.filters] !== "string",
			)
		)
			throw new Error("搜索图谱筛选格式错误");
		return this.views.save({ ...old, state: { ...state, revision: state.revision + 1 } }, state.revision).state;
	}
}
