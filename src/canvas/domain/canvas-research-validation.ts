import type {
	CanvasEvidence,
	CanvasMethodCard,
	CanvasResearchAnalysis,
	CanvasResearchContext,
	CanvasResearchRelation,
	CanvasResearchSettings,
} from "./canvas-research.ts";
import { defaultResearchSettings } from "./canvas-research.ts";

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要对象");
	return value as Record<string, unknown>;
}
export function text(value: unknown, max = 20000): string {
	if (typeof value !== "string" || value.length > max) throw new Error(`文字需在 ${max} 字以内`);
	return value;
}
export function strings(value: unknown, max = 500): string[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("列表过长或格式错误");
	return [...new Set(value.map((item) => text(item, 2000)))];
}
export function integer(value: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
		throw new Error(`数值需为 ${min}–${max} 的整数`);
	return Number(value);
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
	if (!values.includes(value as T)) throw new Error(`可用值：${values.join(", ")}`);
	return value as T;
}
function date(value: unknown): string {
	const result = text(value, 10);
	if (
		result &&
		(!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result)
	)
		throw new Error("日期格式错误");
	return result;
}
export function parseResearchSettings(input: unknown): CanvasResearchSettings {
	const v = { ...defaultResearchSettings, ...object(input) };
	const result = {
		question: text(v.question, 2000),
		scenario: text(v.scenario, 2000),
		include: text(v.include, 2000),
		exclude: text(v.exclude, 2000),
		dateFrom: date(v.dateFrom),
		dateTo: date(v.dateTo),
		dimensions: [
			...new Set(
				strings(v.dimensions, 30)
					.map((d) => d.trim())
					.filter(Boolean),
			),
		],
		readingDepth: oneOf(v.readingDepth, ["layered", "method", "full"]),
		readingBudget: integer(v.readingBudget, 1, 500),
		queryBudget: integer(v.queryBudget, 1, 12),
		searchCallBudget: integer(v.searchCallBudget, 1, 20),
		resultsPerProvider: integer(v.resultsPerProvider, 1, 100),
	};
	if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) throw new Error("起始日期不能晚于结束日期");
	if (!result.dimensions.length) throw new Error("至少需要一个比较维度");
	return result;
}
export function parseResearchContext(input: unknown): CanvasResearchContext {
	const v = object(input);
	return {
		scope: oneOf(v.scope ?? "canvas", ["canvas", "selected", "neighbors"]),
		selectedNodeIds: strings(v.selectedNodeIds ?? []),
		...(v.agentNodeId ? { agentNodeId: text(v.agentNodeId, 80) } : {}),
	};
}
export function parseEvidence(input: unknown): CanvasEvidence {
	const v = object(input);
	const level = oneOf(v.level, ["abstract", "text", "pdf", "inference"]);
	if (level === "pdf" && (!v.sourceSha256 || !v.page)) throw new Error("PDF 证据必须有版本 SHA 和物理页码");
	if (level === "text" && !v.sourceSha256 && !v.noteId) throw new Error("正文证据需要材料版本或笔记来源");
	if (v.noteId && v.noteRevision === undefined) throw new Error("笔记证据需要笔记版本");
	if (v.sourceSha256 && !/^[a-f0-9]{64}$/i.test(String(v.sourceSha256))) throw new Error("无效 PDF SHA");
	return {
		paperId: text(v.paperId, 500),
		level,
		...(v.sourceSha256 ? { sourceSha256: String(v.sourceSha256) } : {}),
		...(v.page !== undefined ? { page: integer(v.page, 1, 10000) } : {}),
		...(v.section ? { section: text(v.section, 500) } : {}),
		...(v.quote ? { quote: text(v.quote, 2000) } : {}),
		...(v.noteId ? { noteId: text(v.noteId, 200) } : {}),
		...(v.noteRevision !== undefined ? { noteRevision: integer(v.noteRevision, 0, 1000000) } : {}),
	};
}
export function parseRelation(input: unknown): CanvasResearchRelation {
	const v = object(input);
	const evidence = array(v.evidence ?? [], parseEvidence, 100);
	const type = oneOf(v.type, ["cites", "adopts", "extends", "similar", "complements", "disagrees"]);
	const evidenceStatus = oneOf(v.evidenceStatus ?? "candidate", ["candidate", "supported", "needs_review"]);
	if (evidenceStatus === "supported" && !evidence.some((item) => item.level === "text" || item.level === "pdf"))
		throw new Error("支持状态需要正文证据");
	if (type === "extends" && !evidence.some((e) => e.level === "text" || e.level === "pdf"))
		throw new Error("改进关系需要具体机制的正文依据");
	if (
		type === "disagrees" &&
		evidenceStatus === "supported" &&
		new Set(evidence.filter((e) => e.level === "text" || e.level === "pdf").map((e) => e.paperId)).size < 2
	)
		throw new Error("分歧关系需要双方正文证据与实验条件");
	if ((type === "extends" || type === "disagrees") && !String(v.conditions ?? "").trim())
		throw new Error("改进或分歧关系需要具体机制及条件");
	return {
		type,
		explanation: text(v.explanation, 4000),
		conditions: text(v.conditions ?? "", 4000),
		evidence,
		evidenceStatus,
		reviewStatus: oneOf(v.reviewStatus ?? "pending", ["pending", "accepted", "rejected"]),
		createdBy: text(v.createdBy ?? "agent", 200),
		...(v.analysisId ? { analysisId: text(v.analysisId, 80) } : {}),
	};
}
export function array<T>(value: unknown, parse: (item: unknown) => T, max = 500): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("列表过长或格式错误");
	return value.map(parse);
}
function methodCard(input: unknown): CanvasMethodCard {
	const v = object(input);
	const fields = Object.fromEntries(
		Object.entries(object(v.fields ?? {})).map(([key, val]) => [text(key, 200), text(val, 4000)]),
	);
	if (Object.keys(fields).length > 40) throw new Error("方法卡字段过多");
	if (
		["method", "full"].includes(String(v.coverage)) &&
		!array(v.evidence ?? [], parseEvidence, 100).some((e) => e.level === "text" || e.level === "pdf")
	)
		throw new Error("方法或全文覆盖需要正文取证记录");
	return {
		paperId: text(v.paperId, 500),
		family: text(v.family ?? "待分类", 200),
		fields,
		coverage: oneOf(v.coverage, ["unread", "abstract", "method", "full"]),
		evidence: array(v.evidence ?? [], parseEvidence, 100),
		unknowns: strings(v.unknowns ?? [], 100),
		pagesRead: array(v.pagesRead ?? [], (n) => integer(n, 1, 10000), 10000),
		sectionsRead: strings(v.sectionsRead ?? [], 200),
	};
}
export function parseAnalysisContent(
	input: unknown,
): Pick<
	CanvasResearchAnalysis,
	"status" | "questionDraft" | "cards" | "summary" | "gaps" | "nextSteps" | "relations" | "searchRunIds" | "candidates"
> {
	const v = object(input);
	return {
		status: oneOf(v.status ?? "running", ["running", "completed", "partial", "stopped", "failed", "interrupted"]),
		...(v.questionDraft ? { questionDraft: text(v.questionDraft, 2000) } : {}),
		cards: array(v.cards ?? [], methodCard),
		summary: text(v.summary ?? "", 100000),
		gaps: array(v.gaps ?? [], (raw) => {
			const gap = object(raw);
			return {
				kind: oneOf(gap.kind, ["unread", "unavailable", "coverage", "evidence"]),
				description: text(gap.description, 4000),
				paperIds: strings(gap.paperIds ?? []),
			};
		}),
		nextSteps: strings(v.nextSteps ?? [], 100),
		relations: array(
			v.relations ?? [],
			(raw) => {
				const r = object(raw);
				return { from: text(r.from, 80), to: text(r.to, 80), relation: parseRelation(r.relation) };
			},
			1000,
		),
		searchRunIds: strings(v.searchRunIds ?? [], 100),
		candidates: array(v.candidates ?? [], (raw) => {
			const c = object(raw);
			return {
				searchRunId: text(c.searchRunId, 200),
				paperId: text(c.paperId, 500),
				dimensions: strings(c.dimensions ?? [], 30),
				reason: text(c.reason, 4000),
			};
		}),
	};
}
