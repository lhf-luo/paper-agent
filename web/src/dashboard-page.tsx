import {
	Activity,
	ArrowRight,
	ArrowUpRight,
	BookMarked,
	CircleAlert,
	ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { EmptyState, StatusPill } from "./components";
import { Reveal } from "./reveal";
import type { ApplicationStatus, BackgroundJob, Page } from "./types";

export interface DashboardPageProps {
	status?: ApplicationStatus;
	go: (page: Page) => void;
}

const QUICK_ACTIONS: Array<{
	index: string;
	title: string;
	caption: string;
	target: Page;
}> = [
	{ index: "01", title: "搜索与筛选", caption: "多源检索、去重与批量选择", target: "search" },
	{ index: "02", title: "整理个人库", caption: "查看状态、版本和阅读证据", target: "library" },
	{ index: "03", title: "分析本地 PDF", caption: "图表、正文引用与 artifact", target: "pdf" },
	{ index: "04", title: "共享到团队", caption: "提议、审核与审计", target: "team" },
];

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
			<section className="dashboard-hero">
				<span className="hero-bg-word" aria-hidden="true">
					EVIDENCE
				</span>
				<Reveal as="header" className="hero-heading">
					<span className="hero-eyebrow">
						<i className="hero-eyebrow-rule" aria-hidden="true" />
						RESEARCH COCKPIT · 总览看板
					</span>
					<h1 className="hero-title">
						阅读、检索、沉淀，
						<br />
						让每篇论文都留下<span className="hero-accent">证据</span>。
					</h1>
					<p className="hero-description">
						从多源检索、去重收集，到 PDF 精读、调研笔记与团队共享 —— 所有长任务、论文和知识库状态集中在这里。
					</p>
					<div className="hero-actions">
						<button className="button primary" type="button" onClick={() => go("search")}>
							开始搜集论文
							<ArrowRight size={15} aria-hidden="true" />
						</button>
						<button className="button secondary" type="button" onClick={() => go("library")}>
							进入个人文献库
						</button>
					</div>
				</Reveal>
			</section>
			<div className="metric-grid">
				<Reveal delay={90}>
					<div className="metric-card accent">
						<span className="metric-label">
							个人库论文
							<i className="metric-icon" aria-hidden="true">
								<BookMarked size={15} />
							</i>
						</span>
						<strong>{status?.defaultRecordCount ?? "—"}</strong>
						<small>{status?.personalNamespaces.length ?? 0} 个 namespace</small>
					</div>
				</Reveal>
				<Reveal delay={150}>
					<div className="metric-card">
						<span className="metric-label">
							运行中任务
							<i className="metric-icon" aria-hidden="true">
								<Activity size={15} />
							</i>
						</span>
						<strong>{status?.jobs.running ?? "—"}</strong>
						<small>{status?.jobs.queued ?? 0} 个等待中</small>
					</div>
				</Reveal>
				<Reveal delay={210}>
					<div className="metric-card">
						<span className="metric-label">
							需要处理
							<i className="metric-icon" aria-hidden="true">
								<CircleAlert size={15} />
							</i>
						</span>
						<strong>{status?.jobs.failed ?? "—"}</strong>
						<small>失败任务可在任务中心重试</small>
					</div>
				</Reveal>
				<Reveal delay={270}>
					<div className="metric-card">
						<span className="metric-label">
							证据原则
							<i className="metric-icon" aria-hidden="true">
								<ShieldCheck size={15} />
							</i>
						</span>
						<strong>Local</strong>
						<small>个人数据默认留在本机</small>
					</div>
				</Reveal>
			</div>
			<Reveal className="dashboard-grid" delay={160}>
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">WORKFLOW GUIDE · 快捷流程</span>
							<h2>下一步做什么？</h2>
						</div>
					</div>
					<div className="quick-actions">
						{QUICK_ACTIONS.map((action) => (
							<button key={action.index} type="button" onClick={() => go(action.target)}>
								<span aria-hidden="true">{action.index}</span>
								<div>
									<strong>{action.title}</strong>
									<small>{action.caption}</small>
								</div>
								<i className="quick-action-arrow" aria-hidden="true">
									<ArrowUpRight size={16} />
								</i>
							</button>
						))}
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
			</Reveal>
		</>
	);
}

export default DashboardPage;
