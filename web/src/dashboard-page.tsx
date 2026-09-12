import { useEffect, useState } from "react";
import { api } from "./api";
import { EmptyState, PageHeading, StatusPill } from "./components";
import type { ApplicationStatus, BackgroundJob, Page } from "./types";

export interface DashboardPageProps {
	status?: ApplicationStatus;
	go: (page: Page) => void;
}

export function DashboardPage({ status, go }: DashboardPageProps) {
	const [jobs, setJobs] = useState<BackgroundJob[]>([]);
	const [jobsError, setJobsError] = useState("");

	useEffect(() => {
		let cancelled = false;
		const loadJobs = async () => {
			try {
				const value = await api<{ jobs: BackgroundJob[] }>("/api/jobs");
				if (!cancelled) {
					setJobs(value.jobs.slice(0, 6));
					setJobsError("");
				}
			} catch (reason) {
				if (!cancelled) setJobsError(reason instanceof Error ? reason.message : String(reason));
			}
		};
		void loadJobs();
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void loadJobs();
			}
		}, 5_000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, []);

	return (
		<>
			<PageHeading
				eyebrow="RESEARCH COCKPIT · 总览看板"
				title="论文调研总览"
				description="从检索到证据整理，所有长任务、论文和知识库状态集中在这里。"
				actions={
					<button className="button primary" type="button" onClick={() => go("search")}>
						开始搜集论文
					</button>
				}
			/>
			<div className="metric-grid">
				<div className="metric-card accent">
					<span>个人库论文</span>
					<strong>{status?.defaultRecordCount ?? "—"}</strong>
					<small>{status?.personalNamespaces.length ?? 0} 个 namespace</small>
				</div>
				<div className="metric-card">
					<span>运行中任务</span>
					<strong>{status?.jobs.running ?? "—"}</strong>
					<small>{status?.jobs.queued ?? 0} 个等待中</small>
				</div>
				<div className="metric-card">
					<span>需要处理</span>
					<strong>{status?.jobs.failed ?? "—"}</strong>
					<small>失败任务可在任务中心重试</small>
				</div>
				<div className="metric-card">
					<span>证据原则</span>
					<strong>Local</strong>
					<small>个人数据默认留在本机</small>
				</div>
			</div>
			<div className="dashboard-grid">
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">WORKFLOW GUIDE · 快捷流程</span>
							<h2>下一步做什么？</h2>
						</div>
					</div>
					<div className="quick-actions">
						<button type="button" onClick={() => go("search")}>
							<span>01</span>
							<div>
								<strong>搜索与筛选</strong>
								<small>多源检索、去重与批量选择</small>
							</div>
						</button>
						<button type="button" onClick={() => go("library")}>
							<span>02</span>
							<div>
								<strong>整理个人库</strong>
								<small>查看状态、版本和阅读证据</small>
							</div>
						</button>
						<button type="button" onClick={() => go("pdf")}>
							<span>03</span>
							<div>
								<strong>分析本地 PDF</strong>
								<small>图表、正文引用与 artifact</small>
							</div>
						</button>
						<button type="button" onClick={() => go("team")}>
							<span>04</span>
							<div>
								<strong>共享到团队</strong>
								<small>提议、审核与审计</small>
							</div>
						</button>
					</div>
				</section>
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">BACKGROUND QUEUE · 后台队列</span>
							<h2>最近任务</h2>
						</div>
						<button className="text-button" type="button" onClick={() => go("tasks")}>
							查看全部
						</button>
					</div>
					{jobsError ? (
						<div className="error-banner">最近任务读取失败：{jobsError}</div>
					) : jobs.length ? (
						<div className="compact-jobs" aria-live="polite">
							{jobs.map((job) => (
								<div key={job.id}>
									<StatusPill status={job.status} />
									<span>{job.type}</span>
									<small>{job.message || new Date(job.updatedAt).toLocaleString()}</small>
								</div>
							))}
						</div>
					) : (
						<EmptyState title="暂无任务" text="搜索、下载和 PDF 解析任务会出现在这里。" />
					)}
				</section>
			</div>
		</>
	);
}

export default DashboardPage;
