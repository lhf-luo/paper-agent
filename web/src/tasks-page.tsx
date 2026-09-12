import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouterContext } from "./router";
import { api } from "./api";
import { EmptyState, LoadingBlock, PageHeading, StatusPill } from "./components";
import type { BackgroundJob } from "./types";

export function TasksPage() {
	const { navigate } = useRouterContext();
	const [jobs, setJobs] = useState<BackgroundJob[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [activeJobId, setActiveJobId] = useState<string>();

	const load = useCallback(async () => {
		try {
			setJobs((await api<{ jobs: BackgroundJob[] }>("/api/jobs")).jobs);
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") {
				void load();
			}
		}, 1800);
		return () => clearInterval(timer);
	}, [load]);

	const action = async (job: BackgroundJob, name: string) => {
		setActiveJobId(job.id);
		setError("");
		try {
			await api(`/api/jobs/${job.id}/${name}`, { method: "POST" });
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setActiveJobId(undefined);
		}
	};

	const removeJob = async (job: BackgroundJob) => {
		if (
			!window.confirm(
				`删除任务 ${job.type} ${job.id.slice(0, 18)}？\n\n删除后不可恢复(仅删除任务记录, 不影响已保存的论文/PDF)。`,
			)
		) {
			return;
		}
		setActiveJobId(job.id);
		setError("");
		try {
			await api(`/api/jobs/${job.id}`, { method: "DELETE" });
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setActiveJobId(undefined);
		}
	};

	const clearFinishedJobs = async () => {
		if (!jobs.some((job) => ["succeeded", "failed", "cancelled"].includes(job.status))) return;
		if (
			!window.confirm(
				"清空所有已完成/失败/已取消的任务记录？\n\n运行中的任务会保留；仅删除任务记录，不影响已保存的论文/PDF。",
			)
		) {
			return;
		}
		setError("");
		try {
			await api("/api/jobs/clear", { method: "POST" });
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	return (
		<>
			<PageHeading
				eyebrow="RUNTIME TASKS · 任务调度中心"
				title="任务中心"
				description="长任务可以独立运行、暂停、取消和恢复；失败原因不会被隐藏。"
			/>
			{error && <div className="error-banner">{error}</div>}
			{jobs.some((job) => ["succeeded", "failed", "cancelled"].includes(job.status)) && (
				<div className="jobs-toolbar">
					<button className="button secondary" type="button" onClick={() => void clearFinishedJobs()}>
						清空已完成/失败任务
					</button>
				</div>
			)}
			<section className="panel table-panel">
				{loading ? (
					<LoadingBlock text="正在读取任务队列…" />
				) : jobs.length ? (
					<section className="jobs-table" aria-label="后台任务队列">
						<div className="table-header">
							<span>任务</span>
							<span>状态</span>
							<span>进度</span>
							<span>更新时间</span>
							<span>操作</span>
						</div>
						{jobs.map((job) => {
							const retryable =
								["literature-search", "pdf-analysis", "artifact-discovery"].includes(job.type) &&
								(["failed", "cancelled"].includes(job.status) ||
									(job.type === "literature-search" &&
										job.status === "succeeded" &&
										(job.result?.run?.failures?.some((failure: any) => failure.retryable) ?? false)));
							return (
								<div className="table-row" key={job.id}>
									<div>
										<strong>{job.type}</strong>
										<code>{job.id.slice(0, 18)}</code>
										{job.error && <small className="error-text">{job.error}</small>}
										{job.result?.run?.providerHealth &&
											Object.values(job.result.run.providerHealth).some(
												(health: any) => health.retryAfter,
											) && (
												<small>
													限流恢复时间：
													{new Date(
														(
															Object.values(job.result.run.providerHealth).find(
																(health: any) => health.retryAfter,
															) as any
														).retryAfter,
													).toLocaleString()}
												</small>
											)}
									</div>
									<StatusPill status={job.status} />
									<div>
									<div
										className="progress-track small"
										role="progressbar"
										aria-label={`${job.type} 进度`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={Math.round(job.progress * 100)}
									>
										<span style={{ width: `${job.progress * 100}%` }} />
									</div>
										<small>{job.message}</small>
									</div>
									<span>{new Date(job.updatedAt).toLocaleString()}</span>
									<div className="row-actions">
										{job.status === "running" && (
											<button
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void action(job, "pause")}
											>
												暂停
											</button>
										)}
										{job.status === "paused" && (
											<button
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void action(job, "resume")}
											>
												继续
											</button>
										)}
										{!["succeeded", "failed", "cancelled"].includes(job.status) && (
											<button
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void action(job, "cancel")}
											>
												取消
											</button>
										)}
										{job.type.includes("pdf") || job.type.includes("artifact") ? (
											<button
												type="button"
												onClick={() => navigate("pdf")}
												title="前往 PDF 与 Artifact 工作台"
											>
												前往查看 <ArrowUpRight size={11} style={{ marginLeft: 3 }} />
											</button>
										) : (
											<button
												type="button"
												onClick={() => navigate("library")}
												title="前往个人文献库"
											>
												前往查看 <ArrowUpRight size={11} style={{ marginLeft: 3 }} />
											</button>
										)}
										{retryable && (
											<button
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void action(job, "retry")}
											>
												重试
											</button>
										)}
										{["succeeded", "failed", "cancelled"].includes(job.status) && (
											<button
												className="danger-text"
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void removeJob(job)}
											>
												删除
											</button>
										)}
									</div>
								</div>
							);
						})}
					</section>
				) : (
					<EmptyState
						title="当前任务队列为空"
						text="文献检索、PDF 全文解析与 OCR、论文翻译和批量导出等耗时异步作业将在此处集中调度。"
						tips={[
							"在「检索与收集」页面触发异步文献多源并发检索",
							"在「PDF 与 Artifact」工作台进行本地论文图表抽取与 MinerU 解析",
							"在「个人文献库」选择论文执行批量导出或标注"
						]}
					/>
				)}
			</section>
		</>
	);
}

export default TasksPage;
