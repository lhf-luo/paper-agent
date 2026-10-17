import { useEffect, useState } from "react";
import type { CanvasResearchRecord, CanvasSearchPlan } from "../../src/canvas/domain/canvas-research";
import { api } from "./api";
import { useResearchAction } from "./canvas-research-action";
import { type ResearchClient, researchStatus } from "./canvas-research-api";
import { ConsentCard, confirmOperation, JobProgress, useJob } from "./components";
import type { BackgroundJob, PaperRecord, PreparedOperation } from "./types";

interface Candidates {
	runId: string;
	total: number;
	papers: PaperRecord[];
	failures?: unknown[];
	coverage?: unknown;
	executions?: unknown;
	authorExpansion?: unknown;
	citationExpansion?: unknown;
	gaps: string;
	recommendations?: Array<{ paperId: string; dimensions: string[]; reason: string }>;
}
type Plan = CanvasResearchRecord<CanvasSearchPlan>;
function CandidateList({
	data,
	plan,
	selected,
	setSelected,
	disabled,
}: {
	data?: Candidates;
	plan: Plan;
	selected: string[];
	setSelected: (s: string[]) => void;
	disabled: boolean;
}) {
	return (
		<>
			{data?.papers.map((p) => (
				<label className="canvas-research-candidate" key={p.id}>
					<input
						type="checkbox"
						checked={selected.includes(p.id)}
						disabled={disabled}
						onChange={(e) =>
							setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))
						}
					/>
					<span>
						<strong>{p.title}</strong>
						<small>
							{p.authors?.join("、")} · {p.year ?? "年份未知"}
						</small>
						<details>
							<summary>摘要与推荐背景</summary>
							<p>{p.abstract || "缺少摘要"}</p>
							<p>{plan.value.reason}</p>
							<p>
								补足维度：
								{data?.recommendations?.find((c) => c.paperId === p.id)?.dimensions.join("、") ||
									plan.value.gap}
							</p>
							<p>
								{data?.recommendations?.find((c) => c.paperId === p.id)?.reason ||
									"尚未逐篇推荐；该候选来自本轮查询，请根据摘要核对相关性。"}
							</p>
						</details>
					</span>
				</label>
			))}
		</>
	);
}
interface CandidateImportProps {
	client: ResearchClient;
	runId: string;
	selected: string[];
	gap: string;
	refresh: () => void;
	onBusy: (b: boolean) => void;
}
function useCandidateImport({ client, runId, selected, gap, refresh, onBusy }: CandidateImportProps) {
	const [prepared, setPrepared] = useState<PreparedOperation>(),
		[importIds, setImportIds] = useState<string[]>([]),
		[jobId, setJobId] = useState<string>();
	const action = useResearchAction(),
		job = useJob(jobId);
	useEffect(() => {
		onBusy(Boolean(prepared || jobId || action.busy));
	}, [prepared, jobId, action.busy, onBusy]);
	const prepare = () =>
		action.perform(async () => {
			setPrepared(
				await api<PreparedOperation>("/api/library/import/prepare", {
					method: "POST",
					body: JSON.stringify({ namespace: client.namespace, searchRunId: runId, paperIds: selected }),
				}),
			);
			setImportIds([...selected]);
		});
	const execute = () =>
		action.perform(async () => {
			if (!prepared) return;
			const grant = await confirmOperation(prepared);
			const job = await api<BackgroundJob>("/api/library/import/execute", {
				method: "POST",
				body: JSON.stringify({ namespace: client.namespace, searchRunId: runId, paperIds: importIds, grant }),
			});
			setJobId(job.id);
			setPrepared(undefined);
		});
	const preview = () =>
		action.perform(async () => {
			await client.post("proposals", { paperIds: importIds, reason: `补充研究材料：${gap}` });
			refresh();
			setJobId(undefined);
		});
	return { prepared, setPrepared, job, jobId, setJobId, action, prepare, execute, preview };
}
function CandidateImport(props: CandidateImportProps) {
	const { prepared, setPrepared, job, jobId, setJobId, action, prepare, execute, preview } = useCandidateImport(props);
	const { selected } = props;
	return (
		<>
			<button
				type="button"
				disabled={action.busy || !selected.length || Boolean(jobId || prepared)}
				onClick={() => void prepare()}
			>
				将所选论文入库
			</button>
			{prepared && (
				<ConsentCard
					operation={prepared}
					onConfirm={() => execute().then(() => undefined)}
					onCancel={() => setPrepared(undefined)}
					busy={action.busy}
				/>
			)}
			<JobProgress job={job} />
			{job?.status === "succeeded" && (
				<button type="button" disabled={action.busy} onClick={() => void preview()}>
					生成加入画布的预览
				</button>
			)}
			{["failed", "cancelled"].includes(job?.status ?? "") && (
				<button type="button" onClick={() => setJobId(undefined)}>
					重新选择并入库
				</button>
			)}
			{action.error && <p role="alert">{action.error}</p>}
		</>
	);
}
function useCandidateResults(client: ResearchClient, planId: string, runId: string, offset: number) {
	const [data, setData] = useState<Candidates>(),
		[error, setError] = useState("");
	useEffect(() => {
		let active = true;
		client
			.get<Candidates>(`searches/${encodeURIComponent(planId)}/candidates`, { runId, offset })
			.then((v) => {
				if (active) {
					setData(v);
				}
			})
			.catch((e) => active && setError(String(e)));
		return () => {
			active = false;
		};
	}, [client, planId, runId, offset]);
	return { data, error };
}
function CandidateCoverage({ data }: { data?: Candidates }) {
	return (
		<details>
			<summary>检索覆盖、截断和错误</summary>
			<pre>
				{JSON.stringify(
					{
						failures: data?.failures,
						coverage: data?.coverage,
						executions: data?.executions,
						authorExpansion: data?.authorExpansion,
						citationExpansion: data?.citationExpansion,
					},
					null,
					2,
				)}
			</pre>
		</details>
	);
}
function CandidatePagination({
	offset,
	setOffset,
	locked,
	total,
}: {
	offset: number;
	setOffset: (f: (o: number) => number) => void;
	locked: boolean;
	total?: number;
}) {
	return (
		<div className="button-row">
			<button type="button" disabled={locked || offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 50))}>
				上一页
			</button>
			<button
				type="button"
				disabled={locked || total === undefined || offset + 50 >= total}
				onClick={() => setOffset((o) => o + 50)}
			>
				下一页
			</button>
		</div>
	);
}
function ResearchCandidates({ client, plan, refresh }: { client: ResearchClient; plan: Plan; refresh: () => void }) {
	const [runId, setRunId] = useState(plan.value.searchRunIds[0]),
		[offset, setOffset] = useState(0);
	const [selected, setSelected] = useState<string[]>([]),
		[locked, setLocked] = useState(false);
	const { data, error } = useCandidateResults(client, plan.id, runId, offset);
	useEffect(() => {
		void runId;
		void offset;
		setSelected([]);
	}, [runId, offset]);
	return (
		<div>
			<label>
				Search Run
				<select
					disabled={locked}
					value={runId}
					onChange={(e) => {
						setRunId(e.target.value);
						setOffset(0);
					}}
				>
					{plan.value.searchRunIds.map((id) => (
						<option key={id} value={id}>
							{id}
						</option>
					))}
				</select>
			</label>
			<p>
				补足维度：{plan.value.gap} · {data?.total ?? 0} 条候选
			</p>
			<CandidateList data={data} plan={plan} selected={selected} setSelected={setSelected} disabled={locked} />
			<CandidateCoverage data={data} />
			<CandidatePagination offset={offset} setOffset={setOffset} locked={locked} total={data?.total} />
			<CandidateImport
				key={runId}
				client={client}
				runId={runId}
				selected={selected}
				gap={plan.value.gap}
				refresh={refresh}
				onBusy={setLocked}
			/>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
function SearchPlan({ client, plan: p, refresh }: { client: ResearchClient; plan: Plan; refresh: () => void }) {
	const action = useResearchAction();
	const decide = (approved: boolean) =>
		action.perform(async () => {
			await client.post(`searches/${encodeURIComponent(p.id)}/decision`, { approved, expectedRevision: p.revision });
			refresh();
		});
	return (
		<article className="canvas-research-item">
			<strong>{p.value.gap}</strong>
			<p>{p.value.reason}</p>
			<p>
				{researchStatus[p.value.status]} · {p.value.strategy} · 提供商 {p.value.providers.join("、")} · 调用{" "}
				{p.value.callsUsed}/{p.value.callBudget} · 每提供商最多 {p.value.resultsPerProvider} 条
			</p>
			<p>
				{p.value.dateFrom || "不限起点"} 至 {p.value.dateTo || "不限截止"}
			</p>
			{(p.value.dateFrom || p.value.dateTo) && p.value.providers.some((provider) => provider !== "arxiv") && (
				<p>arXiv 按 UTC 首次提交日筛选，其他提供商按年份筛选；精确日期需要进一步核验。</p>
			)}
			<ul>
				{p.value.queries.map((q) => (
					<li key={q}>{q}</li>
				))}
			</ul>
			{p.value.status === "pending" && (
				<div className="button-row">
					<button type="button" className="button" disabled={action.busy} onClick={() => void decide(true)}>
						接受本轮检索计划
					</button>
					<button type="button" disabled={action.busy} onClick={() => void decide(false)}>
						拒绝
					</button>
				</div>
			)}
			{p.value.status === "approved" && (
				<p>等待中的 Agent 将继续执行；如会话已停止，在原会话发送“继续执行已接受的补搜计划”。</p>
			)}
			{p.value.searchRunIds.length > 0 && <ResearchCandidates client={client} plan={p} refresh={refresh} />}
			{action.error && <p role="alert">{action.error}</p>}
		</article>
	);
}
export function ResearchSearch({
	client,
	plans,
	refresh,
}: {
	client: ResearchClient;
	plans: Plan[];
	refresh: () => void;
}) {
	return (
		<>
			{plans.map((p) => (
				<SearchPlan key={p.id} client={client} plan={p} refresh={refresh} />
			))}
			{!plans.length && <p>暂无补搜计划。Agent 会先说明缺口、查询范围及预算，接受后才执行外部检索。</p>}
		</>
	);
}
