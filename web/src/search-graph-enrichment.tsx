import { useEffect, useState } from "react";
import { api } from "./api";
import { flushOpenGraph } from "./use-canvas-graph";
import type { BackgroundJob } from "../../src/shared/domain/background-job";
interface Plan {
	capped: number;
	unresolved: number;
	total: number;
	complete: number;
	pending: number;
	providers: string[];
	requestBudget: number;
	job?: BackgroundJob;
}
interface Props {
	canvasId: string;
	runId: string;
	onOpen: (id: string) => Promise<void>;
}
function useEnrichmentEvents(
	base: string,
	canvasId: string,
	runId: string,
	expanded: boolean,
	setPlan: (p: Plan) => void,
	setJob: (j: BackgroundJob | undefined) => void,
	setError: (s: string) => void,
) {
	useEffect(() => {
		if (!expanded) return;
		const events = new EventSource("/api/events");
		const sync = () =>
			void api<Plan>(`${base}/enrich`)
				.then((p) => {
					setPlan(p);
					setJob(p.job);
				})
				.catch((e) => setError(String(e)));
		const receive = (e: MessageEvent) => {
			const j = JSON.parse(e.data) as BackgroundJob,
				input = j.input as { canvasId?: string; runId?: string };
			if (j.type !== "search-graph-enrich" || input.canvasId !== canvasId || input.runId !== runId) return;
			setJob(j);
			if (["succeeded", "failed", "cancelled"].includes(j.status)) sync();
		};
		events.addEventListener("job", receive);
		events.addEventListener("ready", sync);
		return () => events.close();
	}, [expanded, canvasId, runId, base, setPlan, setJob, setError]);
}
function useEnrichment({ canvasId, runId, onOpen }: Props) {
	const base = `/api/canvases/${encodeURIComponent(canvasId)}/search-graphs/${encodeURIComponent(runId)}`;
	const [plan, setPlan] = useState<Plan>(),
		[job, setJob] = useState<BackgroundJob>(),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const act = async (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	useEnrichmentEvents(base, canvasId, runId, Boolean(plan), setPlan, setJob, setError);
	const layout = (restore = false) =>
		act(async () => {
			await flushOpenGraph(base);
			await api(`${base}/${restore ? "restore-layout" : "layout"}`, { method: "POST", body: "{}" });
			await onOpen(runId);
		});
	return {
		plan,
		job,
		error,
		busy,
		running: Boolean(job && ["queued", "running", "paused"].includes(job.status)),
		layout,
		close: () => setPlan(undefined),
		load: () =>
			act(async () => {
				const p = await api<Plan>(`${base}/enrich`);
				setPlan(p);
				setJob(p.job);
			}),
		start: () =>
			act(async () =>
				setJob(
					await api<BackgroundJob>(`${base}/enrich`, {
						method: "POST",
						body: JSON.stringify({ budget: plan?.requestBudget ?? 100 }),
					}),
				),
			),
		cancel: () =>
			act(async () => {
				if (job) setJob(await api<BackgroundJob>(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" }));
			}),
	};
}
type Model = ReturnType<typeof useEnrichment>;
function EnrichmentPlan({ m, plan }: { m: Model; plan: Plan }) {
	return (
		<div className="graph-enrich-plan">
			<p>
				{plan.providers.join(" / ")} · 已完整缓存 {plan.complete}/{plan.total} 篇，待补 {plan.pending} 篇；达到上限{" "}
				{plan.capped} 篇，身份待确认 {plan.unresolved} 篇。
			</p>
			<p>
				本轮最多 {plan.requestBudget} 次 HTTP 尝试（含重试），每篇参考与施引集合各最多 500 个 ID，不增加展示论文。
			</p>
			{m.job && (
				<output>
					{
						{
							queued: "等待中",
							running: "运行中",
							paused: "已暂停",
							succeeded: "已结束",
							failed: "失败",
							cancelled: "已取消",
						}[m.job.status]
					}{" "}
					· {m.job.error ?? m.job.message ?? "等待执行"}
				</output>
			)}
			{m.running ? (
				<button type="button" disabled={m.busy} onClick={() => void m.cancel()}>
					取消补全，保留进度
				</button>
			) : (
				<button type="button" disabled={m.busy || !plan.pending} onClick={() => void m.start()}>
					确认补全 / 继续未完成部分
				</button>
			)}
			<button type="button" onClick={m.close}>
				收起
			</button>
		</div>
	);
}
export function SearchGraphEnrichment(props: Props) {
	const m = useEnrichment(props);
	return (
		<div className="search-graph-enrichment">
			<div className="search-graph-manager-actions">
				<button type="button" disabled={m.busy} onClick={() => void m.load()}>
					补全关系
				</button>
				<button type="button" disabled={m.busy || m.running} onClick={() => void m.layout()}>
					应用新布局
				</button>
				<button type="button" disabled={m.busy} onClick={() => void m.layout(true)}>
					恢复上次布局
				</button>
			</div>
			{m.plan && <EnrichmentPlan m={m} plan={m.plan} />}
			{m.error && <p role="alert">{m.error}</p>}
		</div>
	);
}
