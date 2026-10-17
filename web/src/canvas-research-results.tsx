import type { CanvasEvidence, CanvasMethodCard, CanvasResearchAnalysis } from "../../src/canvas/domain/canvas-research";
import { relationLabels } from "../../src/canvas/domain/canvas-research";
import { type AnalysisView, type ResearchNode, researchStatus } from "./canvas-research-api";

type ReadEvidence = (e: CanvasEvidence) => void;
export function ResearchEvidence({ evidence, onRead }: { evidence: CanvasEvidence[]; onRead: ReadEvidence }) {
	return (
		<span className="canvas-research-evidence">
			{evidence.map((e) => (
				<button
					type="button"
					key={JSON.stringify(e)}
					onClick={() => onRead(e)}
					title={e.quote || e.section || e.sourceSha256}
				>
					{e.level === "pdf"
						? `PDF · p.${e.page}`
						: e.level === "text"
							? "正文"
							: e.level === "abstract"
								? "摘要"
								: "推断"}
					{e.noteId ? " · 笔记" : ""}
				</button>
			))}
		</span>
	);
}
function Coverage({ analysis: a }: { analysis: CanvasResearchAnalysis }) {
	return (
		<>
			<div className="canvas-research-summary">{a.summary || "已保存检查点，综合结论尚未完成。"}</div>
			<h3>覆盖缺口</h3>
			{a.gaps.map((g) => (
				<p key={`${g.kind}:${g.description}`}>
					<strong>
						{
							{ unread: "已有未读", unavailable: "材料不可用", coverage: "覆盖不足", evidence: "证据不足" }[
								g.kind
							]
						}
					</strong>{" "}
					· {g.description}
				</p>
			))}
			<h3>下一步</h3>
			{a.nextSteps.map((step) => (
				<p key={step}>{step}</p>
			))}
		</>
	);
}
function MatrixRow({
	card: c,
	dimensions,
	title,
	onRead,
}: {
	card: CanvasMethodCard;
	dimensions: string[];
	title: string;
	onRead: ReadEvidence;
}) {
	return (
		<tr>
			<th>
				<button type="button" onClick={() => onRead({ paperId: c.paperId, level: "abstract" })}>
					{title}
				</button>
				<p>{c.family || "未分类"}</p>
			</th>
			{dimensions.map((d) => (
				<td key={d}>{c.fields[d] || "未知"}</td>
			))}
			<td>
				{researchStatus[c.coverage]}
				<ResearchEvidence evidence={c.evidence} onRead={onRead} />
				{c.unknowns.map((u) => (
					<p key={u}>待核验：{u}</p>
				))}
			</td>
		</tr>
	);
}
function MethodMatrix({
	run,
	nodes,
	onRead,
	onPage,
}: {
	run: AnalysisView;
	nodes: ResearchNode[];
	onRead: ReadEvidence;
	onPage: (offset: number) => void;
}) {
	const a = run.value;
	const titles = new Map(nodes.filter((n) => n.entityId).map((n) => [n.entityId!, n.title]));
	return (
		<>
			<div className="canvas-research-table">
				<table>
					<thead>
						<tr>
							<th>论文／方法家族</th>
							{a.settings.dimensions.map((d) => (
								<th key={d}>{d}</th>
							))}
							<th>覆盖与证据</th>
						</tr>
					</thead>
					<tbody>
						{a.cards.map((c) => (
							<MatrixRow
								key={c.paperId}
								card={c}
								title={titles.get(c.paperId) || c.paperId}
								dimensions={a.settings.dimensions}
								onRead={onRead}
							/>
						))}
					</tbody>
				</table>
			</div>
			<div className="button-row">
				<button type="button" onClick={() => onPage(0)}>
					首页
				</button>
				{run.nextOffset !== undefined && (
					<button type="button" onClick={() => onPage(run.nextOffset!)}>
						下一页
					</button>
				)}
			</div>
		</>
	);
}
function RelationSuggestions({
	run,
	nodes,
	onRead,
}: {
	run: AnalysisView;
	nodes: ResearchNode[];
	onRead: ReadEvidence;
}) {
	const titles = new Map(nodes.map((n) => [n.id, n.title]));
	return (
		<>
			{run.value.relations.map((r) => (
				<article className="canvas-research-item" key={`${r.from}:${r.to}:${r.relation.type}`}>
					<strong>
						{titles.get(r.from) || r.from} → {titles.get(r.to) || r.to}
					</strong>
					<p>
						{relationLabels[r.relation.type]} · 证据：{researchStatus[r.relation.evidenceStatus]} · 审核：
						{researchStatus[r.relation.reviewStatus]}
					</p>
					<p>{r.relation.explanation}</p>
					{r.relation.conditions && <p>适用条件：{r.relation.conditions}</p>}
					<ResearchEvidence evidence={r.relation.evidence} onRead={onRead} />
				</article>
			))}
			{!run.value.relations.length && <p>本轮尚无关系建议。</p>}
		</>
	);
}
export function ResearchResults({
	run,
	tab,
	nodes,
	onRead,
	onPage,
	onAdopt,
}: {
	run?: AnalysisView;
	tab: string;
	nodes: ResearchNode[];
	onRead: ReadEvidence;
	onPage: (offset: number) => void;
	onAdopt: (question: string) => void;
}) {
	if (!run) return <p>尚无分析。先设置研究问题，再在画布 Agent 中提出研究任务。</p>;
	const a = run.value;
	return (
		<>
			<p className="canvas-research-coverage">
				{researchStatus[a.status]} · 纳入 {a.paperIds.length} 篇 · 方法卡 {run.totalCards} 份 ·{" "}
				{run.freshness === "current" ? "来源匹配" : "来源或目标已变化，需要继续研究"}
				{run.pendingPaperIds.length > 0 && ` · 待纳入 ${run.pendingPaperIds.length} 篇`}
			</p>
			<p className="canvas-research-coverage">
				摘要初筛 {run.coverage.abstract} 篇 · 方法取证 {run.coverage.method} 篇 · 全文研究 {run.coverage.full} 篇 ·
				未深入覆盖 {a.paperIds.length - (run.coverage.method + run.coverage.full)} 篇
			</p>
			{a.questionDraft && !a.settings.question && (
				<div>
					<p>研究问题草案：{a.questionDraft}</p>
					<button type="button" onClick={() => onAdopt(a.questionDraft!)}>
						采用此研究问题
					</button>
				</div>
			)}
			{tab === "coverage" && <Coverage analysis={a} />}
			{tab === "matrix" && <MethodMatrix run={run} nodes={nodes} onRead={onRead} onPage={onPage} />}
			{tab === "relations" && <RelationSuggestions run={run} nodes={nodes} onRead={onRead} />}
		</>
	);
}
