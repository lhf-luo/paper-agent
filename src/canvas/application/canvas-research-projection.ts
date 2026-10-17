import type { CanvasResearchAnalysis, CanvasResearchContext, CanvasResearchRecord } from "../domain/canvas-research.ts";
import { checkEvidence, type paperSource, researchHash } from "./canvas-research-materials.ts";
import type { CanvasResearchService } from "./canvas-research-service.ts";

type Inventory = Awaited<ReturnType<CanvasResearchService["inventory"]>>;
interface ProjectionContext {
	inventories: Map<string, Promise<Inventory>>;
	sources: Map<string, ReturnType<typeof paperSource>>;
}
const projectionContext = (): ProjectionContext => ({ inventories: new Map(), sources: new Map() });
function settingsKey(a: CanvasResearchAnalysis["settings"]) {
	return researchHash([
		a.question,
		a.scenario,
		a.include,
		a.exclude,
		a.dateFrom,
		a.dateTo,
		a.dimensions,
		a.readingDepth,
	]);
}
async function inventory(service: CanvasResearchService, scope: CanvasResearchContext, ctx: ProjectionContext) {
	const key = JSON.stringify(scope);
	let pending = ctx.inventories.get(key);
	if (!pending) {
		pending = service.inventory(scope, false);
		ctx.inventories.set(key, pending);
	}
	try {
		return await pending;
	} catch {
		return undefined;
	}
}
async function projectRelations(
	service: CanvasResearchService,
	record: CanvasResearchRecord<CanvasResearchAnalysis>,
	live: Inventory | undefined,
	ctx: ProjectionContext,
) {
	const result: CanvasResearchAnalysis["relations"] = [];
	const board = service.board(),
		nodes = new Map((live?.nodes ?? board.nodes).map((n) => [n.id, n]));
	for (const r of record.value.relations) {
		const papers = new Set([
			...r.relation.evidence.map((e) => e.paperId),
			...[r.from, r.to].flatMap((id) => (nodes.get(id)?.kind === "paper" ? [nodes.get(id)!.entityId!] : [])),
		]);
		let current = Boolean(
			live &&
				settingsKey(live.settings) === settingsKey(record.value.settings) &&
				nodes.has(r.from) &&
				nodes.has(r.to) &&
				[...papers].every((id) => live.sources[id] === record.value.sources[id]),
		);
		try {
			await checkEvidence(service.library, r.relation.evidence, record.value.paperIds, ctx.sources);
		} catch {
			current = false;
		}
		const symmetric = ["similar", "complements", "disagrees"].includes(r.relation.type);
		const accepted = board.edges.some(
			(e) =>
				e.research?.analysisId === record.id &&
				e.research.type === r.relation.type &&
				((e.from === r.from && e.to === r.to) || (symmetric && e.from === r.to && e.to === r.from)),
		);
		result.push({
			...r,
			relation: {
				...r.relation,
				...(current ? {} : { evidenceStatus: "needs_review" }),
				...(accepted ? { reviewStatus: "accepted" } : {}),
			},
		});
	}
	return result;
}
export async function readResearchAnalysis(
	service: CanvasResearchService,
	id: string,
	offset = 0,
	limit = 50,
	ctx = projectionContext(),
) {
	const record = service.records.get<CanvasResearchAnalysis>("analysis", id);
	if (!record) throw new Error("分析不存在");
	const live = await inventory(service, record.value.scope, ctx);
	let evidenceCurrent = true;
	try {
		await checkEvidence(
			service.library,
			record.value.cards.flatMap((c) => c.evidence),
			record.value.paperIds,
			ctx.sources,
		);
	} catch {
		evidenceCurrent = false;
	}
	const relations = await projectRelations(service, record, live, ctx);
	const current =
		live?.inputHash === record.value.inputHash &&
		evidenceCurrent &&
		relations.every((r) => r.relation.evidenceStatus !== "needs_review");
	return {
		...record,
		freshness: current ? "current" : "stale",
		pendingPaperIds: live?.paperIds.filter((p) => !record.value.paperIds.includes(p)) ?? [],
		totalCards: record.value.cards.length,
		coverage: Object.fromEntries(
			["unread", "abstract", "method", "full"].map((level) => [
				level,
				record.value.cards.filter((card) => card.coverage === level).length,
			]),
		),
		nextOffset: offset + limit < record.value.cards.length ? offset + limit : undefined,
		value: { ...record.value, cards: record.value.cards.slice(offset, offset + limit), relations },
	};
}
export async function latestResearchAnalysis(service: CanvasResearchService) {
	const records = service.records.list<CanvasResearchAnalysis>("analysis"),
		ctx = projectionContext();
	if (!records.length) return undefined;
	const live = await inventory(service, service.context(), ctx);
	const matching = records.filter((r) => r.value.inputHash === live?.inputHash);
	const ordered = [
		...matching.filter((r) => r.value.status === "completed"),
		...matching.filter((r) => r.value.status !== "completed"),
	];
	for (const record of ordered) {
		const view = await readResearchAnalysis(service, record.id, 0, 50, ctx);
		if (view.freshness === "current") return view;
	}
	return readResearchAnalysis(service, records[0].id, 0, 50, ctx);
}
