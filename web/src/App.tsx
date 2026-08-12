import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiBytes, hasSessionToken, jsonBody, launchPdfPath } from "./api";
import { AgentPage } from "./agent-page";
import { ArtifactEvaluationPage } from "./artifact-evaluation-page";
import {
	ConsentCard,
	confirmOperation,
	EmptyState,
	JobProgress,
	LoadingBlock,
	PaperCard,
	PdfViewer,
	StatusPill,
	useJob,
} from "./components";
import type {
	AgentSearchRun,
	AgentSearchRunSummary,
	BackgroundJob,
	ConfirmationGrant,
	PaperAgentConfigView,
	PaperAsset,
	PaperRecord,
	PreparedOperation,
} from "./types";

type Page =
	| "dashboard"
	| "search"
	| "agent"
	| "library"
	| "tasks"
	| "pdf"
	| "quality"
	| "team"
	| "research"
	| "settings"
	| "reader";

interface ApplicationStatus {
	ok: boolean;
	projectRoot: string;
	dataRoot: string;
	corpusRoot: string;
	defaultNamespace: string;
	personalNamespaces: string[];
	defaultRecordCount: number;
	jobs: { queued: number; running: number; failed: number };
}

interface ReaderState {
	title: string;
	url: string;
	pdfPath?: string;
}

const navigation: Array<{ id: Page; label: string; icon: string; section?: string }> = [
	{ id: "dashboard", label: "总览", icon: "⌂" },
	{ id: "search", label: "搜索论文", icon: "⌕" },
	{ id: "agent", label: "Agent 对话", icon: "✦" },
	{ id: "library", label: "个人库", icon: "▤" },
	{ id: "tasks", label: "任务中心", icon: "◷" },
	{ id: "pdf", label: "PDF 与 Artifact", icon: "▧", section: "研究工具" },
	{ id: "quality", label: "质量评估", icon: "✓" },
	{ id: "team", label: "团队知识库", icon: "◎" },
	{ id: "research", label: "调研工作区", icon: "◇" },
	{ id: "settings", label: "设置与诊断", icon: "⚙", section: "系统" },
];

function timeLabel(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(
		date.getHours(),
	).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function PageHeading({
	eyebrow,
	title,
	description,
	actions,
}: {
	eyebrow: string;
	title: string;
	description: string;
	actions?: React.ReactNode;
}) {
	return (
		<header className="page-heading">
			<div>
				<span className="eyebrow">{eyebrow}</span>
				<h1>{title}</h1>
				<p>{description}</p>
			</div>
			{actions && <div className="heading-actions">{actions}</div>}
		</header>
	);
}

function DashboardPage({ status, go }: { status?: ApplicationStatus; go: (page: Page) => void }) {
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
		const interval = window.setInterval(() => void loadJobs(), 5_000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, []);
	return (
		<>
			<PageHeading
				eyebrow="Research cockpit"
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
							<span className="eyebrow">快捷流程</span>
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
							<span className="eyebrow">后台队列</span>
							<h2>最近任务</h2>
						</div>
						<button className="text-button" type="button" onClick={() => go("tasks")}>
							查看全部
						</button>
					</div>
					{jobsError ? (
						<div className="error-banner">最近任务读取失败：{jobsError}</div>
					) : jobs.length ? (
						<div className="compact-jobs">
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

function SearchPage({ onTask }: { onTask: (job: BackgroundJob) => void }) {
	const [query, setQuery] = useState("");
	const [providers, setProviders] = useState<string[]>([]);
	const [yearFrom, setYearFrom] = useState("");
	const [yearTo, setYearTo] = useState("");
	const [maxResults, setMaxResults] = useState("20");
	const [pagesPerProvider, setPagesPerProvider] = useState("1");
	const [queryExpansions, setQueryExpansions] = useState("");
	const [authors, setAuthors] = useState("");
	const [venues, setVenues] = useState("");
	const [publicationTypes, setPublicationTypes] = useState("");
	const [openAccess, setOpenAccess] = useState("any");
	const [reuseCorpus, setReuseCorpus] = useState(true);
	const [namespace, setNamespace] = useState("default");
	const [namespaces, setNamespaces] = useState<string[]>(["default"]);
	const [searchJobId, setSearchJobId] = useState<string>();
	const [agentRuns, setAgentRuns] = useState<AgentSearchRunSummary[]>([]);
	const [selectedRun, setSelectedRun] = useState<AgentSearchRun>();
	const [selectedRunId, setSelectedRunId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<PreparedOperation>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [providerCatalog, setProviderCatalog] = useState<
		Array<{
			id: string;
			label: string;
			description: string;
			queryMode: string;
			requiresEnvironmentVariable?: string;
			credentialsAvailable: boolean;
		}>
	>([]);
	const job = useJob(searchJobId);
	const jobRun = job?.status === "succeeded" ? (job.result?.run as AgentSearchRun | undefined) : undefined;
	const run = selectedRun ?? jobRun;
	const results: PaperRecord[] = run?.results ?? [];
	const providerHealth: Record<
		string,
		{ status: string; recordCount: number; failureCount: number; message?: string }
	> = run?.providerHealth ?? {};
	const loadAgentRun = async (id: string) => {
		if (!id) {
			setSelectedRun(undefined);
			return;
		}
		setBusy(true);
		setError("");
		try {
			setSelectedRun((await api<{ run: AgentSearchRun }>(`/api/search/runs/${encodeURIComponent(id)}`)).run);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		void Promise.all([
			api<{ providers: typeof providerCatalog }>("/api/providers"),
			api<PaperAgentConfigView>("/api/config"),
			api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces"),
			api<{ runs: AgentSearchRunSummary[] }>("/api/search/runs").catch(() => ({ runs: [] })),
		])
			.then(([catalogResponse, config, namespaceResponse, runsResponse]) => {
				setProviderCatalog(catalogResponse.providers);
				setAgentRuns(runsResponse.runs);
				const available = new Set(
					catalogResponse.providers
						.filter((provider) => provider.credentialsAvailable)
						.map((provider) => provider.id),
				);
				setProviders(config.search.providers.filter((provider) => available.has(provider)));
				setMaxResults(String(config.search.maxResultsPerProvider));
				setPagesPerProvider(String(config.search.pagesPerProvider));
				setQueryExpansions(config.search.queryExpansions.join("\n"));
				setReuseCorpus(config.search.reuseCorpus);
				setNamespace(namespaceResponse.defaultNamespace);
				setNamespaces(namespaceResponse.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);
	const listValues = (value: string) =>
		value
			.split(/\r?\n|,/)
			.map((item) => item.trim())
			.filter(Boolean);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError("");
		try {
			if (!providers.length) throw new Error("请至少选择一个当前可用的文献源");
			const created = await api<BackgroundJob>(
				"/api/search",
				jsonBody({
					query,
					providers,
					queryExpansions: listValues(queryExpansions),
					filters: {
						yearFrom: yearFrom ? Number(yearFrom) : undefined,
						yearTo: yearTo ? Number(yearTo) : undefined,
						authors: listValues(authors),
						venues: listValues(venues),
						types: listValues(publicationTypes),
						openAccess: openAccess === "any" ? undefined : openAccess === "yes",
					},
					pagesPerProvider: Number(pagesPerProvider),
					maxResultsPerProvider: Number(maxResults),
					namespace,
					reuseCorpus,
				}),
			);
			setSearchJobId(created.id);
			setSelected(new Set());
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const toggleProvider = (provider: string) =>
		setProviders((current) =>
			current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider],
		);
	const prepareSave = async () => {
		if (!job || !selected.size) return;
		setBusy(true);
		setError("");
		try {
			setPending(
				await api(
					"/api/library/import/prepare",
					jsonBody({ searchJobId: job.id, paperIds: [...selected], namespace }),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const confirmSave = async () => {
		if (!pending || !job) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/library/import/execute",
				jsonBody({ searchJobId: job.id, paperIds: [...selected], namespace, grant }),
			);
			onTask(created);
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeading
				eyebrow="Discovery"
				title="搜索与收集论文"
				description="组合多个文献源，保存每次查询、过滤、失败和去重来源。"
			/>
			<section className="search-workbench">
				<form className="search-form" onSubmit={submit}>
					<label className="search-input">
						<span>研究问题或检索式</span>
						<div>
							<span>⌕</span>
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="例如：stateful protocol fuzzing with learned state models"
								required
							/>
							<button type="submit" disabled={busy}>
								开始检索
							</button>
						</div>
					</label>
					<div className="filter-row">
						<div>
							<span className="field-label">数据源</span>
							<div className="chip-row">
								{(providerCatalog.length
									? providerCatalog
									: ["arxiv", "openalex", "crossref", "semanticscholar"].map((id) => ({
											id,
											label: id,
											description: id,
											queryMode: "search",
											credentialsAvailable: true,
											requiresEnvironmentVariable: undefined,
										}))
								).map((provider) => (
									<button
										className={`${providers.includes(provider.id) ? "chip active" : "chip"}${provider.credentialsAvailable ? "" : " unavailable"}`}
										type="button"
										key={provider.id}
										disabled={!provider.credentialsAvailable}
										onClick={() => toggleProvider(provider.id)}
										title={`${provider.description}${provider.requiresEnvironmentVariable && !provider.credentialsAvailable ? `；未找到 ${provider.requiresEnvironmentVariable}` : ""}${provider.queryMode === "doi-enrichment" ? "；请输入 DOI" : ""}`}
									>
										{provider.label}
									</button>
								))}
							</div>
						</div>
						<label>
							<span className="field-label">个人库 namespace</span>
							<select value={namespace} onChange={(event) => setNamespace(event.target.value)}>
								{namespaces.map((item) => (
									<option value={item} key={item}>
										{item}
									</option>
								))}
							</select>
						</label>
						<label>
							<span className="field-label">起始年份</span>
							<input
								type="number"
								value={yearFrom}
								onChange={(event) => setYearFrom(event.target.value)}
								placeholder="2019"
							/>
						</label>
						<label>
							<span className="field-label">结束年份</span>
							<input
								type="number"
								value={yearTo}
								onChange={(event) => setYearTo(event.target.value)}
								placeholder="2026"
							/>
						</label>
						<label>
							<span className="field-label">每源上限</span>
							<input
								type="number"
								min="1"
								max="500"
								value={maxResults}
								onChange={(event) => setMaxResults(event.target.value)}
							/>
						</label>
						<label>
							<span className="field-label">每源页数</span>
							<input
								type="number"
								min="1"
								max="20"
								value={pagesPerProvider}
								onChange={(event) => setPagesPerProvider(event.target.value)}
							/>
						</label>
					</div>
					<details className="advanced-filters">
						<summary>高级检索选项</summary>
						<div className="filter-row">
							<label>
								<span className="field-label">查询扩展（逗号或换行分隔）</span>
								<textarea
									value={queryExpansions}
									onChange={(event) => setQueryExpansions(event.target.value)}
									placeholder="state model inference&#10;protocol state learning"
								/>
							</label>
							<label>
								<span className="field-label">作者</span>
								<input
									value={authors}
									onChange={(event) => setAuthors(event.target.value)}
									placeholder="Alice, Bob"
								/>
							</label>
							<label>
								<span className="field-label">会议 / 期刊</span>
								<input
									value={venues}
									onChange={(event) => setVenues(event.target.value)}
									placeholder="USENIX Security"
								/>
							</label>
							<label>
								<span className="field-label">论文类型</span>
								<input
									value={publicationTypes}
									onChange={(event) => setPublicationTypes(event.target.value)}
									placeholder="journal-article, proceedings-article"
								/>
							</label>
							<label>
								<span className="field-label">开放获取</span>
								<select value={openAccess} onChange={(event) => setOpenAccess(event.target.value)}>
									<option value="any">不限</option>
									<option value="yes">仅开放获取</option>
									<option value="no">仅非开放获取</option>
								</select>
							</label>
							<label className="checkbox-field">
								<input
									type="checkbox"
									checked={reuseCorpus}
									onChange={(event) => setReuseCorpus(event.target.checked)}
								/>
								<span>复用个人库已有记录，避免重复请求和重复分析</span>
							</label>
						</div>
					</details>
				</form>
			</section>
			{error && <div className="error-banner">{error}</div>}
			<JobProgress job={job} />
			{Object.keys(providerHealth).length > 0 && (
				<div className="provider-health">
					{Object.entries(providerHealth).map(([provider, health]) => (
						<div key={provider} title={health.message}>
							<StatusPill status={health.status} />
							<strong>{provider}</strong>
							<span>{health.recordCount} 条</span>
							{health.failureCount > 0 && <small>{health.failureCount} 个失败</small>}
						</div>
					))}
				</div>
			)}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={() => void confirmSave()}
				/>
			)}
			{agentRuns.length > 0 && (
				<div className="agent-run-picker">
					<label htmlFor="agent-run-select">
						<span>Agent 对话产生的搜索记录</span>
					</label>
					<div className="agent-run-row">
						<select
							id="agent-run-select"
							value={selectedRunId}
							onChange={(event) => setSelectedRunId(event.target.value)}
						>
							<option value="">-- 选择一次 Agent 搜索 --</option>
							{agentRuns.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{(entry.queries[0] ?? "").slice(0, 40)} · {entry.resultCount} 条 · {timeLabel(entry.completedAt)}
								</option>
							))}
						</select>
						<button
							className="button secondary"
							type="button"
							disabled={busy || !selectedRunId}
							onClick={() => void loadAgentRun(selectedRunId)}
						>
							{selectedRunId === selectedRun?.id ? "展示中" : "展示结果"}
						</button>
					</div>
				</div>
			)}
			{results.length > 0 && (
				<section className="results-section">
					<div className="results-toolbar">
						<div>
							<strong>{results.length}</strong> 篇去重结果 · 已选择 {selected.size} 篇
						</div>
						<div className="button-row">
							<button
								className="button secondary"
								type="button"
								onClick={() => setSelected(new Set(results.map((paper) => paper.id)))}
							>
								全选
							</button>
							<button
								className="button primary"
								type="button"
								disabled={!selected.size || busy}
								onClick={() => void prepareSave()}
							>
								保存到个人库
							</button>
						</div>
					</div>
					<div className="paper-list">
						{results.map((paper) => (
							<PaperCard
								key={paper.id}
								paper={paper}
								selected={selected.has(paper.id)}
								onSelect={(checked) =>
									setSelected((current) => {
										const next = new Set(current);
										if (checked) next.add(paper.id);
										else next.delete(paper.id);
										return next;
									})
								}
							/>
						))}
					</div>
				</section>
			)}
		</>
	);
}

function LibraryPage({
	onOpenReader,
	onTask,
}: {
	onOpenReader: (state: ReaderState) => void;
	onTask: (job: BackgroundJob) => void;
}) {
	const [query, setQuery] = useState("");
	const [papers, setPapers] = useState<PaperRecord[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [details, setDetails] = useState<any>();
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<PreparedOperation>();
	const [annotationPending, setAnnotationPending] = useState<PreparedOperation>();
	const [annotationPayload, setAnnotationPayload] = useState<Record<string, unknown>>();
	const [exportPending, setExportPending] = useState<PreparedOperation>();
	const [exportPayload, setExportPayload] = useState<Record<string, unknown>>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [namespace, setNamespace] = useState("default");
	const [namespaces, setNamespaces] = useState<string[]>(["default"]);
	const [annotationTags, setAnnotationTags] = useState("");
	const [annotationNote, setAnnotationNote] = useState("");
	const [screeningStatus, setScreeningStatus] = useState("unreviewed");
	const [screeningReason, setScreeningReason] = useState("");
	const [screeningFilter, setScreeningFilter] = useState("all");
	const [exportFormat, setExportFormat] = useState("markdown");
	const [exportFilename, setExportFilename] = useState("");
	useEffect(() => {
		void api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces")
			.then((value) => {
				setNamespace(value.defaultNamespace);
				setNamespaces(value.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);
	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const params = new URLSearchParams({ q: query, namespace, limit: "300" });
			if (screeningFilter !== "all") params.append("screeningStatus", screeningFilter);
			setPapers(
				(await api<{ hits: Array<{ record: PaperRecord }> }>(`/api/library?${params.toString()}`)).hits.map(
					(hit) => hit.record,
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [namespace, query, screeningFilter]);
	useEffect(() => {
		setSelected(new Set());
		setDetails(undefined);
		void load();
	}, [load]);
	const open = async (paper: PaperRecord) => {
		setError("");
		try {
			setDetails(
				await api(`/api/papers/${encodeURIComponent(paper.id)}?namespace=${encodeURIComponent(namespace)}`),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const prepareDownload = async () => {
		setBusy(true);
		setError("");
		try {
			setPending(await api("/api/pdf-downloads/prepare", jsonBody({ paperIds: [...selected], namespace })));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeDownload = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const job = await api<BackgroundJob>(
				"/api/pdf-downloads/execute",
				jsonBody({ paperIds: [...selected], namespace, grant }),
			);
			onTask(job);
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareAnnotation = async () => {
		if (!selected.size) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const payload: Record<string, unknown> = {
				paperIds: [...selected],
				namespace,
				tags: annotationTags
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean),
				note: annotationNote,
				screeningStatus: screeningStatus === "unreviewed" ? undefined : screeningStatus,
				screeningReason,
			};
			setAnnotationPayload(payload);
			setAnnotationPending(await api("/api/library/annotations/prepare", jsonBody(payload)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeAnnotation = async () => {
		if (!annotationPending || !annotationPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(annotationPending)) as ConfirmationGrant;
			const result = await api<{ count: number }>(
				"/api/library/annotations/execute",
				jsonBody({ ...annotationPayload, grant }),
			);
			setMessage(`已更新 ${result.count} 篇个人论文的标签、笔记或筛选状态。`);
			setAnnotationPending(undefined);
			setAnnotationPayload(undefined);
			setSelected(new Set());
			setDetails(undefined);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareExport = async () => {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const payload: Record<string, unknown> = {
				paperIds: selected.size ? [...selected] : undefined,
				namespace,
				format: exportFormat,
				filename: exportFilename.trim() || undefined,
			};
			setExportPayload(payload);
			setExportPending(await api("/api/library/export/prepare", jsonBody(payload)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeExport = async () => {
		if (!exportPending || !exportPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(exportPending)) as ConfirmationGrant;
			const result = await api<{ filename: string; count: number }>(
				"/api/library/export/execute",
				jsonBody({ ...exportPayload, grant }),
			);
			const bytes = await apiBytes(
				`/api/library/exports/${encodeURIComponent(result.filename)}?namespace=${encodeURIComponent(namespace)}`,
			);
			const objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = result.filename;
			anchor.click();
			URL.revokeObjectURL(objectUrl);
			setMessage(`已导出 ${result.count} 篇论文：${result.filename}`);
			setExportPending(undefined);
			setExportPayload(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const hasAnnotationChanges = Boolean(
		annotationTags.trim() || annotationNote.trim() || screeningStatus !== "unreviewed",
	);
	return (
		<>
			<PageHeading
				eyebrow="Personal corpus"
				title="个人论文库"
				description="原始论文、人工笔记和 AI 派生内容分开保存，并保留版本与来源。"
				actions={
					<button
						className="button primary"
						type="button"
						disabled={!selected.size || busy}
						onClick={() => void prepareDownload()}
					>
						下载所选 PDF
					</button>
				}
			/>
			<div className="library-toolbar">
				<label>
					<span>⌕</span>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索标题、作者、摘要、标签或笔记"
					/>
				</label>
				<label>
					<span>Namespace</span>
					<select value={namespace} onChange={(event) => setNamespace(event.target.value)}>
						{namespaces.map((item) => (
							<option value={item} key={item}>
								{item}
							</option>
						))}
					</select>
				</label>
				<label>
					<span>筛选状态</span>
					<select value={screeningFilter} onChange={(event) => setScreeningFilter(event.target.value)}>
						<option value="all">全部</option>
						<option value="unreviewed">未筛选</option>
						<option value="include">纳入</option>
						<option value="maybe">待定</option>
						<option value="exclude">排除</option>
					</select>
				</label>
				<span>
					{papers.length} 篇 · 已选择 {selected.size}
				</span>
			</div>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			<section className="panel">
				<div className="panel-heading">
					<div>
						<span className="eyebrow">Personal curation</span>
						<h2>整理所选论文</h2>
					</div>
					<small>{selected.size ? `已选择 ${selected.size} 篇` : "未选择时导出整个 namespace"}</small>
				</div>
				<div className="button-row">
					<input
						value={annotationTags}
						onChange={(event) => setAnnotationTags(event.target.value)}
						placeholder="标签（逗号分隔）"
					/>
					<select
						value={screeningStatus}
						onChange={(event) => {
							setScreeningStatus(event.target.value);
							if (event.target.value === "unreviewed") setScreeningReason("");
						}}
					>
						<option value="unreviewed">不改变筛选状态</option>
						<option value="include">纳入</option>
						<option value="maybe">待定</option>
						<option value="exclude">排除</option>
					</select>
					<input
						value={screeningReason}
						onChange={(event) => setScreeningReason(event.target.value)}
						disabled={screeningStatus === "unreviewed"}
						placeholder="筛选理由（可选）"
					/>
					<button
						className="button secondary"
						type="button"
						disabled={!selected.size || busy || !hasAnnotationChanges}
						onClick={() => void prepareAnnotation()}
					>
						预览并保存整理
					</button>
				</div>
				<textarea
					value={annotationNote}
					onChange={(event) => setAnnotationNote(event.target.value)}
					placeholder="个人笔记（不会自动进入团队库）"
					rows={2}
				/>
				<div className="button-row">
					<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}>
						<option value="markdown">Markdown</option>
						<option value="csv">CSV</option>
						<option value="bibtex">BibTeX</option>
						<option value="json">JSON</option>
					</select>
					<input
						value={exportFilename}
						onChange={(event) => setExportFilename(event.target.value)}
						placeholder="导出文件名（可选）"
					/>
					<button
						className="button secondary"
						type="button"
						disabled={busy || !papers.length}
						onClick={() => void prepareExport()}
					>
						预览并导出
					</button>
				</div>
			</section>
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={() => void executeDownload()}
				/>
			)}
			{annotationPending && (
				<ConsentCard
					operation={annotationPending}
					busy={busy}
					onCancel={() => {
						setAnnotationPending(undefined);
						setAnnotationPayload(undefined);
					}}
					onConfirm={() => void executeAnnotation()}
				/>
			)}
			{exportPending && (
				<ConsentCard
					operation={exportPending}
					busy={busy}
					onCancel={() => {
						setExportPending(undefined);
						setExportPayload(undefined);
					}}
					onConfirm={() => void executeExport()}
				/>
			)}
			<div className="library-layout">
				<div>
					{loading ? (
						<LoadingBlock />
					) : papers.length ? (
						<div className="paper-list">
							{papers.map((paper) => (
								<PaperCard
									key={paper.id}
									paper={paper}
									selected={selected.has(paper.id)}
									onSelect={(checked) =>
										setSelected((current) => {
											const next = new Set(current);
											checked ? next.add(paper.id) : next.delete(paper.id);
											return next;
										})
									}
									onOpen={() => void open(paper)}
								/>
							))}
						</div>
					) : (
						<EmptyState title="个人库还是空的" text="先到“搜索论文”页面收集并保存感兴趣的论文。" />
					)}
				</div>
				<aside className="detail-panel">
					{details ? (
						<>
							<span className="eyebrow">Paper details</span>
							<h2>{details.paper.title}</h2>
							<p>{details.paper.authors.join(", ")}</p>
							<div className="detail-stats">
								<div>
									<span>PDF 版本</span>
									<strong>{details.versions.length}</strong>
								</div>
								<div>
									<span>派生记忆</span>
									<strong>{details.derived.length}</strong>
								</div>
							</div>
							<h3>PDF 版本</h3>
							{details.versions.length ? (
								details.versions.map((version: any) => (
									<button
										className="version-row"
										type="button"
										key={version.sha256}
										onClick={() =>
											onOpenReader({
												title: details.paper.title,
												url: `/api/papers/${encodeURIComponent(details.paper.id)}/pdf/${version.sha256}?namespace=${encodeURIComponent(namespace)}`,
												pdfPath: version.blobPath,
											})
										}
									>
										<span>{new Date(version.retrievedAt).toLocaleDateString()}</span>
										<code>{version.sha256.slice(0, 12)}</code>
										<small>{Math.round(version.bytes / 1024)} KB</small>
									</button>
								))
							) : (
								<p className="muted">尚未下载 PDF。</p>
							)}
							<h3>标签与状态</h3>
							<div className="chip-row">
								{(details.paper.curation?.tags ?? []).map((tag: string) => (
									<span className="chip active" key={tag}>
										{tag}
									</span>
								))}
								{!details.paper.curation?.tags?.length && <span className="muted">暂无标签</span>}
							</div>
							{details.paper.curation?.screening && (
								<p className="muted">
									筛选：{details.paper.curation.screening.status}
									{details.paper.curation.screening.reason
										? ` · ${details.paper.curation.screening.reason}`
										: ""}
								</p>
							)}
							{details.paper.curation?.userNotes?.length ? (
								<div>
									<h3>个人笔记</h3>
									{details.paper.curation.userNotes.slice(-5).map((note: any) => (
										<blockquote key={note.id}>{note.text}</blockquote>
									))}
								</div>
							) : null}
						</>
					) : (
						<EmptyState title="选择一篇论文" text="查看 PDF 版本、派生记忆、标签和来源。" />
					)}
				</aside>
			</div>
		</>
	);
}

function TasksPage() {
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
		const timer = setInterval(() => void load(), 1800);
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
	return (
		<>
			<PageHeading
				eyebrow="Background work"
				title="任务中心"
				description="长任务可以独立运行、暂停、取消和恢复；失败原因不会被隐藏。"
			/>
			{error && <div className="error-banner">{error}</div>}
			<section className="panel table-panel">
				{loading ? (
					<LoadingBlock text="正在读取任务队列…" />
				) : jobs.length ? (
					<div className="jobs-table">
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
										<div className="progress-track small">
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
										{retryable && (
											<button
												type="button"
												disabled={activeJobId === job.id}
												onClick={() => void action(job, "retry")}
											>
												重试
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<EmptyState title="任务队列为空" text="搜索、下载、解析和同步操作会显示在这里。" />
				)}
			</section>
		</>
	);
}

function PdfWorkspacePage({ onTask }: { onTask: (job: BackgroundJob) => void }) {
	const [path, setPath] = useState("");
	const [jobId, setJobId] = useState<string>();
	const [mode, setMode] = useState<"analysis" | "artifacts" | "acquisition">("analysis");
	const [selectedArtifacts, setSelectedArtifacts] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<PreparedOperation>();
	const [correctionPending, setCorrectionPending] = useState<PreparedOperation>();
	const [correctionAsset, setCorrectionAsset] = useState<PaperAsset>();
	const [correctionRegion, setCorrectionRegion] = useState<PaperAsset["candidateRegion"]>();
	const [correctionNote, setCorrectionNote] = useState("");
	const [artifactDetails, setArtifactDetails] = useState<any>();
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [teamPending, setTeamPending] = useState<PreparedOperation>();
	const [teamPaperId, setTeamPaperId] = useState("");
	const [personalNamespace, setPersonalNamespace] = useState("default");
	const [personalNamespaces, setPersonalNamespaces] = useState<string[]>(["default"]);
	const [personalPapers, setPersonalPapers] = useState<PaperRecord[]>([]);
	const job = useJob(jobId);
	useEffect(() => {
		void api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces")
			.then((value) => {
				setPersonalNamespace(value.defaultNamespace);
				setPersonalNamespaces(value.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);
	useEffect(() => {
		void api<{ hits: Array<{ record: PaperRecord }> }>(
			`/api/library?namespace=${encodeURIComponent(personalNamespace)}&limit=300`,
		)
			.then((value) => {
				const records = value.hits.map((hit) => hit.record);
				setPersonalPapers(records);
				setTeamPaperId((current) =>
					current && records.some((record) => record.id === current) ? current : (records[0]?.id ?? ""),
				);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [personalNamespace]);
	const run = async (kind: "analysis" | "artifacts") => {
		setBusy(true);
		setError("");
		setMessage("");
		setMode(kind);
		setJobId(undefined);
		if (kind === "artifacts") {
			setSelectedArtifacts(new Set());
			setPending(undefined);
			setArtifactDetails(undefined);
		}
		try {
			const created = await api<BackgroundJob>(
				kind === "analysis" ? "/api/pdf/analyze" : "/api/artifacts/discover",
				jsonBody(kind === "analysis" ? { pdfPath: path, refine: true } : { pdfPath: path }),
			);
			setJobId(created.id);
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const assets: PaperAsset[] = mode === "analysis" && job?.status === "succeeded" ? (job.result?.assets ?? []) : [];
	const candidates: any[] = mode === "artifacts" && job?.status === "succeeded" ? (job.result?.candidates ?? []) : [];
	useEffect(() => {
		if (mode !== "acquisition" || job?.status !== "succeeded") return;
		void api(`/api/artifacts/jobs/${encodeURIComponent(job.id)}`)
			.then(setArtifactDetails)
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [job, mode]);
	const prepareAcquire = async () => {
		setBusy(true);
		setError("");
		try {
			const value = await api<{ prepared: PreparedOperation }>(
				"/api/artifacts/prepare",
				jsonBody({ pdfPath: path, candidateIds: [...selectedArtifacts] }),
			);
			setPending(value.prepared);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeAcquire = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/artifacts/execute",
				jsonBody({ pdfPath: path, candidateIds: [...selectedArtifacts], grant }),
			);
			onTask(created);
			setPending(undefined);
			setJobId(created.id);
			setMode("acquisition");
			setArtifactDetails(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareTeamManifest = async () => {
		if (!job || !teamPaperId) return;
		setBusy(true);
		setError("");
		try {
			setTeamPending(
				await api<PreparedOperation>(
					"/api/team/artifacts/prepare",
					jsonBody({ artifactJobId: job.id, paperId: teamPaperId, personalNamespace }),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeTeamManifest = async () => {
		if (!job || !teamPending || !teamPaperId) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(teamPending)) as ConfirmationGrant;
			await api(
				"/api/team/artifacts/execute",
				jsonBody({ artifactJobId: job.id, paperId: teamPaperId, personalNamespace, grant }),
			);
			setTeamPending(undefined);
			setMessage("Artifact manifest 已提交到团队审核队列；团队服务不会自动接收本地文件。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const selectCorrection = (asset: PaperAsset, region = asset.candidateRegion) => {
		setCorrectionAsset(asset);
		setCorrectionRegion(region);
		setCorrectionNote("");
	};
	const prepareCorrection = async () => {
		if (!job || !correctionAsset || !correctionRegion) return;
		setBusy(true);
		setError("");
		try {
			setCorrectionPending(
				await api<PreparedOperation>(
					"/api/pdf/corrections/prepare",
					jsonBody({
						analysisJobId: job.id,
						assetId: correctionAsset.id,
						correctedRegion: correctionRegion,
						note: correctionNote,
					}),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeCorrection = async () => {
		if (!job || !correctionPending || !correctionAsset || !correctionRegion) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(correctionPending)) as ConfirmationGrant;
			await api(
				"/api/pdf/corrections/execute",
				jsonBody({
					analysisJobId: job.id,
					assetId: correctionAsset.id,
					correctedRegion: correctionRegion,
					note: correctionNote,
					grant,
				}),
			);
			setCorrectionPending(undefined);
			setCorrectionAsset(undefined);
			setCorrectionRegion(undefined);
			await run("analysis");
			setMessage("图表区域校正已保存，并已重新分析应用最新校正。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<PageHeading
				eyebrow="Primary source"
				title="PDF 与 Artifact 工作台"
				description="输入本地 PDF 路径，建立图表、正文 mention、section 和公开 artifact 的可追溯关联。"
			/>
			<section className="path-workbench">
				<label>
					<span>本地 PDF 路径</span>
					<input
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="D:\papers\example.pdf"
					/>
				</label>
				<div className="button-row">
					<button
						className="button primary"
						disabled={!path || busy}
						type="button"
						onClick={() => void run("analysis")}
					>
						分析图表与正文
					</button>
					<button
						className="button secondary"
						disabled={!path || busy}
						type="button"
						onClick={() => void run("artifacts")}
					>
						发现 Artifact
					</button>
				</div>
			</section>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			<JobProgress job={job} />
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={() => void executeAcquire()}
				/>
			)}
			{correctionPending && (
				<ConsentCard
					operation={correctionPending}
					busy={busy}
					onCancel={() => setCorrectionPending(undefined)}
					onConfirm={() => void executeCorrection()}
				/>
			)}
			{teamPending && (
				<ConsentCard
					operation={teamPending}
					busy={busy}
					onCancel={() => setTeamPending(undefined)}
					onConfirm={() => void executeTeamManifest()}
				/>
			)}
			{path && mode === "analysis" && job?.status === "succeeded" && (
				<div className="reader-grid">
					<PdfViewer
						url={`/api/local-pdf?path=${encodeURIComponent(path)}`}
						assets={assets}
						pageMetrics={job.result?.pages ?? []}
						editable
						onAssetSelect={(asset) => selectCorrection(asset)}
						onRegionChange={(asset, region) => selectCorrection(asset, region)}
					/>
					<aside className="asset-details">
						<span className="eyebrow">Detected assets</span>
						<h2>{assets.length} 个图表资产</h2>
						<p className="muted">拖动框移动区域，拖动右下角控制点改变大小；保存前会显示 exact-plan 确认。</p>
						{correctionAsset && correctionRegion && (
							<div className="crop-editor">
								<strong>
									校正 {correctionAsset.type} {correctionAsset.identifier}
								</strong>
								<div className="crop-grid">
									{(["x", "y", "width", "height"] as const).map((key) => (
										<label key={key}>
											<span>{key}</span>
											<input
												type="number"
												step="0.1"
												value={Math.round(correctionRegion[key] * 10) / 10}
												onChange={(event) =>
													setCorrectionRegion({ ...correctionRegion, [key]: Number(event.target.value) })
												}
											/>
										</label>
									))}
								</div>
								<textarea
									rows={2}
									value={correctionNote}
									onChange={(event) => setCorrectionNote(event.target.value)}
									placeholder="校正原因（可选）"
								/>
								<div className="button-row">
									<button
										type="button"
										className="button secondary"
										onClick={() => {
											setCorrectionAsset(undefined);
											setCorrectionRegion(undefined);
										}}
									>
										取消
									</button>
									<button
										type="button"
										className="button primary"
										disabled={busy}
										onClick={() => void prepareCorrection()}
									>
										保存校正
									</button>
								</div>
							</div>
						)}
						{assets.map((asset) => (
							<article className={correctionAsset?.id === asset.id ? "selected" : ""} key={asset.id}>
								<button className="asset-select-button" type="button" onClick={() => selectCorrection(asset)}>
									<strong>
										{asset.type} {asset.identifier}
									</strong>
									<StatusPill status={asset.manualCorrection ? "high" : asset.regionConfidence} />
									<p>{asset.caption}</p>
									<small>
										{asset.mentions[0]?.section || "Section 未识别"} · {asset.mentions.length} 个正文引用
										{asset.subfigureRegions?.length ? ` · ${asset.subfigureRegions.length} 个子图` : ""}
										{asset.continuationRegions?.length ? ` · ${asset.continuationRegions.length} 个续页` : ""}
									</small>
									{asset.manualCorrection && (
										<small>
											人工校正：{asset.manualCorrection.author} ·{" "}
											{new Date(asset.manualCorrection.createdAt).toLocaleString()}
										</small>
									)}
								</button>
								{asset.mentions.slice(0, 2).map((mention, index) => (
									<blockquote key={`${asset.id}-${index}`}>
										<strong>{mention.matchedText}</strong> · {mention.context}
									</blockquote>
								))}
							</article>
						))}
					</aside>
				</div>
			)}
			{candidates.length > 0 && (
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Artifact candidates</span>
							<h2>发现 {candidates.length} 个候选</h2>
						</div>
						<button
							className="button primary"
							disabled={!selectedArtifacts.size || busy}
							type="button"
							onClick={() => void prepareAcquire()}
						>
							获取所选 Artifact
						</button>
					</div>
					<div className="artifact-list">
						{candidates.map((candidate) => (
							<label key={candidate.id}>
								<input
									type="checkbox"
									checked={selectedArtifacts.has(candidate.id)}
									onChange={(event) =>
										setSelectedArtifacts((current) => {
											const next = new Set(current);
											event.target.checked ? next.add(candidate.id) : next.delete(candidate.id);
											return next;
										})
									}
								/>
								<div>
									<strong>{candidate.kind}</strong>
									<code>{candidate.url}</code>
									<small>
										{candidate.confidence} ·{" "}
										{candidate.sources
											?.map((source: any) => (source.page ? `p.${source.page}` : source.method))
											.join(" · ")}
									</small>
								</div>
							</label>
						))}
					</div>
				</section>
			)}
			{mode !== "analysis" && job?.status === "succeeded" && (
				<section className="panel team-manifest-share">
					<div>
						<span className="eyebrow">Artifact manifest → Team</span>
						<h2>提交到团队审核队列</h2>
						<p>只提交来源链接、PDF hash、commit/hash、失败原因和获取记录；本地 artifact 文件不会自动上传。</p>
					</div>
					<div className="team-manifest-controls">
						<select value={personalNamespace} onChange={(event) => setPersonalNamespace(event.target.value)}>
							{personalNamespaces.map((namespace) => (
								<option key={namespace} value={namespace}>
									{namespace}
								</option>
							))}
						</select>
						<select value={teamPaperId} onChange={(event) => setTeamPaperId(event.target.value)}>
							{personalPapers.map((paper) => (
								<option key={paper.id} value={paper.id}>
									{paper.title}
								</option>
							))}
						</select>
						<button
							className="button primary"
							type="button"
							disabled={!teamPaperId || busy}
							onClick={() => void prepareTeamManifest()}
						>
							预览并提议
						</button>
					</div>
				</section>
			)}
			{mode === "acquisition" && artifactDetails && (
				<section className="artifact-result-grid">
					<div className="panel">
						<span className="eyebrow">Acquisition manifest</span>
						<h2>Artifact 获取结果</h2>
						<p>
							<code>{artifactDetails.manifestPath}</code>
						</p>
						<div className="artifact-snapshots">
							{artifactDetails.manifest.acquisitions.map((snapshot: any, index: number) => (
								<article key={`${snapshot.candidateId}-${index}`}>
									<StatusPill status={snapshot.status === "failed" ? "failed" : "succeeded"} />
									<div>
										<strong>{snapshot.candidateId}</strong>
										<code>{snapshot.finalUrl ?? snapshot.sourceUrl}</code>
										<small>
											{snapshot.commit
												? `commit ${snapshot.commit}`
												: snapshot.sha256
													? `sha256 ${snapshot.sha256}`
													: (snapshot.failureReason ?? "无额外证据")}
										</small>
										<small>
											{snapshot.bytes ? `${Math.round(snapshot.bytes / 1024)} KB` : ""}
											{snapshot.licenseFiles?.length
												? ` · license: ${snapshot.licenseFiles.map((item: string) => item.split(/[\\/]/).at(-1)).join(", ")}`
												: ""}
										</small>
									</div>
								</article>
							))}
						</div>
					</div>
					<div className="panel">
						<span className="eyebrow">Bounded file tree</span>
						<h2>本地文件结构</h2>
						<p className="muted">为避免泄露和性能问题，最多显示 1500 项、6 层，并跳过 .git 与 node_modules。</p>
						<div className="file-tree">
							{artifactDetails.tree.map((entry: any) => (
								<div key={entry.path} className={`tree-${entry.type}`}>
									<span>{entry.type === "directory" ? "▸" : "·"}</span>
									<code>{entry.path}</code>
									<small>{entry.bytes === undefined ? "" : `${Math.round(entry.bytes / 1024)} KB`}</small>
								</div>
							))}
						</div>
						{artifactDetails.truncated && <div className="error-banner">文件树已按安全上限截断。</div>}
					</div>
				</section>
			)}
		</>
	);
}

function ReaderPage({
	reader,
	onBack,
	onTask,
}: {
	reader: ReaderState;
	onBack: () => void;
	onTask: (job: BackgroundJob) => void;
}) {
	const [analysisJobId, setAnalysisJobId] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const job = useJob(analysisJobId);
	const assets: PaperAsset[] = job?.status === "succeeded" ? (job.result?.assets ?? []) : [];
	const analyze = async () => {
		if (!reader.pdfPath) return;
		setBusy(true);
		setError("");
		setAnalysisJobId(undefined);
		try {
			const created = await api<BackgroundJob>(
				"/api/pdf/analyze",
				jsonBody({ pdfPath: reader.pdfPath, refine: true }),
			);
			setAnalysisJobId(created.id);
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<PageHeading
				eyebrow="Evidence reader"
				title={reader.title}
				description="图表区域、caption、正文引用和 section 在同一阅读界面中联动。"
				actions={
					<div className="button-row">
						<button className="button secondary" type="button" onClick={onBack}>
							返回个人库
						</button>
						<button
							className="button primary"
							disabled={!reader.pdfPath || busy}
							type="button"
							onClick={() => void analyze()}
						>
							分析图表
						</button>
					</div>
				}
			/>
			{error && <div className="error-banner">{error}</div>}
			<JobProgress job={job} />
			<div className="reader-grid">
				<PdfViewer url={reader.url} assets={assets} pageMetrics={job?.result?.pages ?? []} />
				<aside className="asset-details">
					<span className="eyebrow">Evidence index</span>
					<h2>{assets.length ? `${assets.length} 个资产` : "等待分析"}</h2>
					{assets.map((asset) => (
						<article key={asset.id}>
							<strong>
								{asset.type} {asset.identifier}
							</strong>
							<p>{asset.caption}</p>
							<small>
								第 {asset.page} 页 · {asset.section || "未知 section"}
							</small>
							{asset.mentions.map((mention) => (
								<blockquote
									key={`${asset.id}-${mention.page}-${mention.matchedText}-${mention.lineBox?.x ?? "no-box"}-${mention.lineBox?.y ?? "no-box"}`}
								>
									{mention.context}
								</blockquote>
							))}
						</article>
					))}
				</aside>
			</div>
		</>
	);
}

function TeamPage() {
	const [overview, setOverview] = useState<any>();
	const [personal, setPersonal] = useState<PaperRecord[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingRequest, setPendingRequest] = useState<{ path: string; payload: Record<string, unknown> }>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [identityName, setIdentityName] = useState("");
	const [identityRoles, setIdentityRoles] = useState<string[]>(["reader"]);
	const [oneTimeToken, setOneTimeToken] = useState("");
	const [personalNamespace, setPersonalNamespace] = useState("default");
	const [personalNamespaces, setPersonalNamespaces] = useState<string[]>(["default"]);
	const [blobPaperId, setBlobPaperId] = useState("");
	const [blobVersions, setBlobVersions] = useState<any[]>([]);
	const [backupPath, setBackupPath] = useState("");
	const [teamQuery, setTeamQuery] = useState("");
	const [teamYearFrom, setTeamYearFrom] = useState("");
	const [teamYearTo, setTeamYearTo] = useState("");
	const [teamSearchResults, setTeamSearchResults] = useState<PaperRecord[]>([]);
	const [teamSearchCursor, setTeamSearchCursor] = useState<string>();
	const [teamSearchLoading, setTeamSearchLoading] = useState(false);
	const load = useCallback(async () => {
		setError("");
		try {
			const [team, library, namespaces] = await Promise.all([
				api<any>("/api/team/overview"),
				api<{ hits: Array<{ record: PaperRecord }> }>(
					`/api/library?namespace=${encodeURIComponent(personalNamespace)}&limit=300`,
				),
				api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces"),
			]);
			setOverview(team);
			const records = library.hits.map((hit) => hit.record);
			setPersonal(records);
			setPersonalNamespaces(namespaces.personal);
			if (
				!namespaces.personal.includes(personalNamespace) &&
				namespaces.personal.includes(namespaces.defaultNamespace)
			) {
				setPersonalNamespace(namespaces.defaultNamespace);
			}
			setBlobPaperId((current) =>
				current && records.some((record) => record.id === current) ? current : (records[0]?.id ?? ""),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [personalNamespace]);
	useEffect(() => {
		void load();
	}, [load]);
	const prepare = async (preparePath: string, executePath: string, payload: Record<string, unknown>) => {
		setError("");
		setMessage("");
		setOneTimeToken("");
		try {
			setPendingRequest({ path: executePath, payload });
			setPending(await api<PreparedOperation>(preparePath, jsonBody(payload)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const execute = async () => {
		if (!pending || !pendingRequest) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const result = await api<any>(pendingRequest.path, jsonBody({ ...pendingRequest.payload, grant }));
			if (typeof result.token === "string") setOneTimeToken(result.token);
			if (typeof result.backupPath === "string") setBackupPath(result.backupPath);
			setMessage(
				result.token
					? "新 token 仅显示这一次，请立即复制到安全位置。"
					: result.validated
						? `恢复演练通过：${result.stats.recordCount} 篇论文、${result.stats.derivedCount} 条派生记忆、${result.stats.artifactCount} 份 artifact、${result.stats.blobCount} 个 blob。`
						: result.backupPath
							? `团队备份已创建：${result.backupPath}`
							: "团队操作已完成并写入审计记录。",
			);
			setPending(undefined);
			setPendingRequest(undefined);
			setSelected(new Set());
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const copyAndHideToken = async () => {
		if (!oneTimeToken) return;
		try {
			await navigator.clipboard.writeText(oneTimeToken);
			setOneTimeToken("");
			setMessage("新 token 已复制并从界面隐藏；请立即保存到受保护的环境变量或密码管理器。");
		} catch (reason) {
			setError(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`);
		}
	};
	const loadBlobVersions = async () => {
		if (!blobPaperId) return;
		setError("");
		try {
			const details = await api<any>(
				`/api/papers/${encodeURIComponent(blobPaperId)}?namespace=${encodeURIComponent(personalNamespace)}`,
			);
			setBlobVersions(details.versions ?? []);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const searchTeam = async (cursor?: string) => {
		setTeamSearchLoading(true);
		setError("");
		try {
			const params = new URLSearchParams();
			if (teamQuery.trim()) params.set("q", teamQuery.trim());
			if (teamYearFrom) params.set("yearFrom", teamYearFrom);
			if (teamYearTo) params.set("yearTo", teamYearTo);
			params.set("limit", "50");
			if (cursor) params.set("cursor", cursor);
			const result = await api<{ hits: Array<{ record: PaperRecord }>; nextCursor?: string }>(
				`/api/team/search?${params.toString()}`,
			);
			setTeamSearchResults((current) =>
				cursor ? [...current, ...result.hits.map((hit) => hit.record)] : result.hits.map((hit) => hit.record),
			);
			setTeamSearchCursor(result.nextCursor);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setTeamSearchLoading(false);
		}
	};
	const review = (
		resource: "papers" | "derived" | "artifacts",
		ids: string[],
		decision: "team-approved" | "team-rejected",
	) => prepare("/api/team/reviews/prepare", "/api/team/reviews/execute", { resource, ids, decision });
	const roles: string[] = overview?.identity?.roles ?? [];
	const capabilities = overview?.capabilities ?? {
		canRead: roles.includes("admin") || roles.includes("reader"),
		canContribute: roles.includes("admin") || roles.includes("contributor"),
		canReview: roles.includes("admin") || roles.includes("reviewer"),
		canAdmin: roles.includes("admin"),
	};
	const canRead = Boolean(capabilities.canRead);
	const contributor = Boolean(capabilities.canContribute);
	const reviewer = Boolean(capabilities.canReview);
	const admin = Boolean(capabilities.canAdmin);
	if (!overview)
		return (
			<>
				<PageHeading eyebrow="Shared knowledge" title="团队知识库" description="正在读取团队服务状态。" />
				{error ? <div className="error-banner">{error}</div> : <LoadingBlock />}
			</>
		);
	if (!overview.connected)
		return (
			<>
				<PageHeading
					eyebrow="Shared knowledge"
					title="团队知识库"
					description="个人内容默认私有；配置团队服务后才能共享。"
					actions={
						<button className="button secondary" type="button" onClick={() => void load()}>
							重新检测
						</button>
					}
				/>
				{error && <div className="error-banner">{error}</div>}
				<div className="team-grid">
					<section className="panel">
						<span className="eyebrow">连接状态</span>
						<h2>{overview.configured ? "尚未连接" : "尚未配置"}</h2>
						<p>{overview.reason}</p>
						{overview.serverUrl && (
							<code className="command-block">
								{overview.serverUrl} / {overview.namespace}
							</code>
						)}
						<div className="callout">
							<strong>下一步</strong>
							<span>
								在“设置与诊断”中填写服务 URL、namespace 和 token 环境变量名；真实 token 只放入环境变量。
							</span>
						</div>
					</section>
					<section className="panel">
						<span className="eyebrow">安全边界</span>
						<h2>个人数据不会自动上传</h2>
						<ol className="workflow-list">
							<li>
								<span>1</span>选择个人论文
							</li>
							<li>
								<span>2</span>检查脱敏预览与 fingerprint
							</li>
							<li>
								<span>3</span>人工确认后提交提议
							</li>
							<li>
								<span>4</span>Reviewer 再次审核
							</li>
						</ol>
					</section>
				</div>
			</>
		);
	const stats = overview.stats ?? {};
	return (
		<>
			<PageHeading
				eyebrow="Shared knowledge"
				title="团队知识库"
				description={`${overview.identity.name} · ${roles.join(", ")} · ${overview.serverUrl}/${overview.namespace}`}
				actions={
					<div className="button-row">
						<button className="button secondary" type="button" onClick={() => void load()}>
							刷新
						</button>
						{admin && (
							<button
								className="button primary"
								type="button"
								onClick={() => void prepare("/api/team/backup/prepare", "/api/team/backup/execute", {})}
							>
								创建备份
							</button>
						)}
					</div>
				}
			/>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			{oneTimeToken && (
				<div className="secret-output">
					<strong>一次性新 token</strong>
					<code>{oneTimeToken}</code>
					<div className="row-actions">
						<button type="button" onClick={() => void copyAndHideToken()}>
							复制并隐藏
						</button>
						<button type="button" onClick={() => setOneTimeToken("")}>
							隐藏
						</button>
					</div>
				</div>
			)}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => {
						setPending(undefined);
						setPendingRequest(undefined);
					}}
					onConfirm={() => void execute()}
				/>
			)}
			{admin && (
				<section className="panel restore-drill-panel">
					<div>
						<span className="eyebrow">Backup verification</span>
						<h2>备份与恢复演练</h2>
						<p>恢复演练只在服务端临时目录中校验完整性与内容统计，不覆盖当前团队库。</p>
					</div>
					<div className="restore-drill-controls">
						<input
							value={backupPath}
							onChange={(event) => setBackupPath(event.target.value)}
							placeholder="先创建备份，或粘贴服务端 backupPath"
						/>
						<button
							className="button secondary"
							type="button"
							disabled={!backupPath.trim()}
							onClick={() =>
								void prepare("/api/team/restore-drill/prepare", "/api/team/restore-drill/execute", {
									backupPath,
								})
							}
						>
							预览恢复演练
						</button>
					</div>
				</section>
			)}
			<div className="metric-grid">
				<div className="metric-card accent">
					<span>共享论文</span>
					<strong>{canRead ? (stats.manifest?.recordCount ?? overview.papers?.length ?? 0) : "—"}</strong>
					<small>{canRead ? `${stats.pendingPapers ?? 0} 篇待审核` : "需要 reader 权限"}</small>
				</div>
				<div className="metric-card">
					<span>派生记忆</span>
					<strong>{canRead ? (stats.derivedCount ?? overview.derived?.length ?? 0) : "—"}</strong>
					<small>{canRead ? `${stats.pendingDerived ?? 0} 条待审核` : "需要 reader 权限"}</small>
				</div>
				<div className="metric-card">
					<span>Artifact manifest</span>
					<strong>{canRead ? (stats.artifactCount ?? overview.artifacts?.length ?? 0) : "—"}</strong>
					<small>{canRead ? `${stats.pendingArtifacts ?? 0} 条待审核` : "需要 reader 权限"}</small>
				</div>
				<div className="metric-card">
					<span>内容寻址 Blob</span>
					<strong>{canRead ? (stats.blobCount ?? 0) : "—"}</strong>
					<small>{canRead ? `${Math.round((stats.blobBytes ?? 0) / 1024 / 1024)} MB` : "需要 reader 权限"}</small>
				</div>
			</div>
			{canRead && (
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Shared search</span>
							<h2>检索团队论文</h2>
						</div>
						<small>{teamSearchResults.length} 条结果</small>
					</div>
					<div className="button-row">
						<input
							value={teamQuery}
							onChange={(event) => setTeamQuery(event.target.value)}
							placeholder="标题、作者、摘要或 DOI"
						/>
						<input
							type="number"
							value={teamYearFrom}
							onChange={(event) => setTeamYearFrom(event.target.value)}
							placeholder="起始年份"
						/>
						<input
							type="number"
							value={teamYearTo}
							onChange={(event) => setTeamYearTo(event.target.value)}
							placeholder="结束年份"
						/>
						<button
							className="button secondary"
							type="button"
							disabled={teamSearchLoading}
							onClick={() => void searchTeam()}
						>
							{teamSearchLoading ? "检索中…" : "检索"}
						</button>
					</div>
					{teamSearchResults.length ? (
						<div className="shared-record-list">
							{teamSearchResults.map((paper) => (
								<article key={paper.id}>
									<div>
										<strong>{paper.title}</strong>
										<small>
											{paper.authors.slice(0, 3).join(", ")} · {paper.year ?? "年份未知"} ·{" "}
											{paper.venue ?? "venue 未知"}
										</small>
									</div>
									<StatusPill status={paper.curation?.teamReview?.status ?? "team-approved"} />
								</article>
							))}
						</div>
					) : (
						<p className="muted">输入条件后检索；团队检索不会修改个人库。</p>
					)}
					{teamSearchCursor && (
						<button
							className="button secondary"
							type="button"
							disabled={teamSearchLoading}
							onClick={() => void searchTeam(teamSearchCursor)}
						>
							加载下一页
						</button>
					)}
				</section>
			)}
			<div className="team-workspace-grid">
				{contributor ? (
					<section className="panel team-personal-picker">
						<div className="panel-heading">
							<div>
								<span className="eyebrow">Personal → Team</span>
								<h2>提交论文提议</h2>
							</div>
							<div className="button-row">
								<select
									value={personalNamespace}
									onChange={(event) => {
										setPersonalNamespace(event.target.value);
										setSelected(new Set());
										setBlobVersions([]);
									}}
								>
									{personalNamespaces.map((namespace) => (
										<option key={namespace} value={namespace}>
											{namespace}
										</option>
									))}
								</select>
								<button
									className="button primary"
									disabled={!selected.size || busy}
									type="button"
									onClick={() =>
										void prepare("/api/team/proposals/prepare", "/api/team/proposals/execute", {
											paperIds: [...selected],
											personalNamespace,
										})
									}
								>
									预览并提议
								</button>
							</div>
						</div>
						<p>只上传论文元数据、公开链接、provenance 和标签；个人笔记与 screening 决策会被清除。</p>
						<div className="selection-list">
							{personal.map((paper) => (
								<label key={paper.id}>
									<input
										type="checkbox"
										checked={selected.has(paper.id)}
										onChange={(event) =>
											setSelected((current) => {
												const next = new Set(current);
												event.target.checked ? next.add(paper.id) : next.delete(paper.id);
												return next;
											})
										}
									/>
									<div>
										<strong>{paper.title}</strong>
										<small>
											{paper.authors.slice(0, 3).join(", ")} · {paper.year ?? "年份未知"}
										</small>
									</div>
								</label>
							))}
						</div>
						<div className="blob-uploader">
							<h3>上传已下载 PDF blob</h3>
							<p className="muted">PDF 不会随论文元数据自动上传。请选择论文并单独检查内容 hash、大小和目标。</p>
							<div className="button-row">
								<select
									value={blobPaperId}
									onChange={(event) => {
										setBlobPaperId(event.target.value);
										setBlobVersions([]);
									}}
								>
									{personal.map((paper) => (
										<option key={paper.id} value={paper.id}>
											{paper.title}
										</option>
									))}
								</select>
								<button
									className="button secondary"
									type="button"
									disabled={!blobPaperId}
									onClick={() => void loadBlobVersions()}
								>
									读取 PDF 版本
								</button>
							</div>
							<div className="blob-version-list">
								{blobVersions.map((version) => (
									<article key={version.sha256}>
										<div>
											<code>{version.sha256}</code>
											<small>
												{Math.round(version.bytes / 1024)} KB · {version.contentType}
											</small>
										</div>
										<button
											type="button"
											onClick={() =>
												void prepare("/api/team/blobs/prepare", "/api/team/blobs/execute", {
													paperId: blobPaperId,
													sha256: version.sha256,
													personalNamespace,
												})
											}
										>
											预览上传
										</button>
									</article>
								))}
							</div>
						</div>
					</section>
				) : (
					<section className="panel">
						<span className="eyebrow">Personal → Team</span>
						<h2>当前身份不可提交</h2>
						<p>连接正常，但该 token 没有 contributor 权限。个人库内容仍留在本机，不会自动上传。</p>
					</section>
				)}
				<section className="panel">
					<span className="eyebrow">Shared papers</span>
					<h2>已共享论文</h2>
					<div className="shared-record-list">
						{canRead ? (
							overview.papers?.length ? (
								overview.papers.slice(0, 50).map((paper: PaperRecord) => (
									<article key={paper.id}>
										<div>
											<strong>{paper.title}</strong>
											<small>
												{paper.authors.slice(0, 3).join(", ")} · {paper.year ?? "—"}
											</small>
										</div>
										<StatusPill status={paper.curation?.teamReview?.status ?? "team-approved"} />
									</article>
								))
							) : (
								<EmptyState
									title="团队库还没有论文"
									text={
										contributor
											? "从左侧选择个人论文并提交提议。"
											: "具有 contributor 权限的成员可以提交论文提议。"
									}
								/>
							)
						) : (
							<EmptyState
								title="当前身份不可读取团队论文"
								text="连接仍然有效；请让管理员为该身份增加 reader 权限。"
							/>
						)}
					</div>
				</section>
			</div>
			{canRead && (
				<div className="team-grid knowledge-detail-grid">
					<section className="panel">
						<span className="eyebrow">Approved derived memory</span>
						<h2>已批准派生知识</h2>
						<div className="shared-record-list">
							{overview.derived?.filter((entry: any) => entry.review.status === "team-approved").length ? (
								overview.derived
									.filter((entry: any) => entry.review.status === "team-approved")
									.slice(0, 50)
									.map((entry: any) => (
										<article key={entry.record.key}>
											<div>
												<strong>{entry.record.operation}</strong>
												<small>
													{entry.record.paperId} · {entry.record.createdBy || "作者未知"} ·{" "}
													{new Date(entry.record.createdAt).toLocaleString()}
												</small>
												<code>{entry.record.key}</code>
											</div>
											<StatusPill status="team-approved" />
										</article>
									))
							) : (
								<p className="muted">暂无已批准的略读卡、比较矩阵或证据图。</p>
							)}
						</div>
					</section>
					<section className="panel">
						<span className="eyebrow">Approved artifact manifests</span>
						<h2>已批准 Artifact 证据</h2>
						<div className="artifact-snapshots">
							{overview.artifacts?.filter((entry: any) => entry.review.status === "team-approved").length ? (
								overview.artifacts
									.filter((entry: any) => entry.review.status === "team-approved")
									.slice(0, 30)
									.map((entry: any) => (
										<article key={entry.paperId}>
											<StatusPill status="team-approved" />
											<div>
												<strong>{entry.paperId}</strong>
												<small>
													PDF {entry.manifest.pdfSha256?.slice(0, 12)} · {entry.manifest.candidates.length}{" "}
													candidates · {entry.manifest.acquisitions.length} acquisitions
												</small>
												{entry.manifest.acquisitions.slice(0, 3).map((snapshot: any, index: number) => (
													<code key={`${entry.paperId}-${snapshot.candidateId}-${index}`}>
														{snapshot.status}: {snapshot.finalUrl ?? snapshot.sourceUrl}
														{snapshot.commit
															? ` @ ${snapshot.commit}`
															: snapshot.sha256
																? ` # ${snapshot.sha256}`
																: ""}
													</code>
												))}
											</div>
										</article>
									))
							) : (
								<p className="muted">暂无已批准的 Artifact manifest。</p>
							)}
						</div>
					</section>
				</div>
			)}
			{reviewer && (
				<section className="panel review-center">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Review queue</span>
							<h2>待审核内容</h2>
						</div>
					</div>
					<div className="review-columns">
						<div>
							<h3>论文 ({overview.pendingPapers?.length ?? 0})</h3>
							{overview.pendingPapers?.map((paper: PaperRecord) => (
								<article key={paper.id}>
									<strong>{paper.title}</strong>
									<small>{paper.curation?.teamReview?.proposedBy}</small>
									<div className="row-actions">
										<button type="button" onClick={() => void review("papers", [paper.id], "team-approved")}>
											批准
										</button>
										<button type="button" onClick={() => void review("papers", [paper.id], "team-rejected")}>
											拒绝
										</button>
									</div>
								</article>
							))}
						</div>
						<div>
							<h3>
								派生记忆 (
								{overview.derived?.filter((entry: any) => entry.review.status === "team-proposed").length ?? 0})
							</h3>
							{overview.derived
								?.filter((entry: any) => entry.review.status === "team-proposed")
								.map((entry: any) => (
									<article key={entry.record.key}>
										<strong>{entry.record.operation}</strong>
										<code>{entry.record.key}</code>
										<div className="row-actions">
											<button
												type="button"
												onClick={() => void review("derived", [entry.record.key], "team-approved")}
											>
												批准
											</button>
											<button
												type="button"
												onClick={() => void review("derived", [entry.record.key], "team-rejected")}
											>
												拒绝
											</button>
										</div>
									</article>
								))}
						</div>
						<div>
							<h3>
								Artifact (
								{overview.artifacts?.filter((entry: any) => entry.review.status === "team-proposed").length ??
									0}
								)
							</h3>
							{overview.artifacts
								?.filter((entry: any) => entry.review.status === "team-proposed")
								.map((entry: any) => (
									<article key={entry.paperId}>
										<strong>{entry.paperId}</strong>
										<small>
											{entry.manifest.candidates.length} candidates · {entry.manifest.acquisitions.length}{" "}
											acquisitions
										</small>
										<div className="row-actions">
											<button
												type="button"
												onClick={() => void review("artifacts", [entry.paperId], "team-approved")}
											>
												批准
											</button>
											<button
												type="button"
												onClick={() => void review("artifacts", [entry.paperId], "team-rejected")}
											>
												拒绝
											</button>
										</div>
									</article>
								))}
						</div>
					</div>
				</section>
			)}
			<div className="team-grid">
				<section className="panel">
					<span className="eyebrow">Append-only audit</span>
					<h2>最近审计事件</h2>
					<div className="audit-list">
						{overview.events?.length ? (
							overview.events.slice(0, 30).map((event: any) => (
								<div key={event.id}>
									<StatusPill status="low" />
									<div>
										<strong>{event.action}</strong>
										<small>
											{event.actor} · {new Date(event.at).toLocaleString()}
										</small>
									</div>
									<code>{event.target}</code>
								</div>
							))
						) : (
							<p className="muted">当前角色不可查看，或尚无事件。</p>
						)}
					</div>
				</section>
				{admin ? (
					<section className="panel">
						<span className="eyebrow">Token administration</span>
						<h2>身份与在线轮换</h2>
						<div className="identity-create">
							<input
								value={identityName}
								onChange={(event) => setIdentityName(event.target.value)}
								placeholder="新身份或已有身份名称"
							/>
							<div className="chip-row">
								{["reader", "contributor", "reviewer", "admin"].map((role) => (
									<button
										className={identityRoles.includes(role) ? "chip active" : "chip"}
										type="button"
										key={role}
										onClick={() =>
											setIdentityRoles((current) =>
												current.includes(role)
													? current.filter((item) => item !== role)
													: [...current, role],
											)
										}
									>
										{role}
									</button>
								))}
							</div>
							<button
								className="button primary"
								type="button"
								disabled={!identityName || !identityRoles.length}
								onClick={() =>
									void prepare("/api/team/tokens/prepare", "/api/team/tokens/execute", {
										action: "rotate",
										name: identityName,
										roles: identityRoles,
									})
								}
							>
								创建/轮换 token
							</button>
						</div>
						<div className="identity-list">
							{overview.identities?.map((identity: any) => (
								<div key={identity.name}>
									<div>
										<strong>{identity.name}</strong>
										<small>
											{identity.roles.join(", ")}
											{identity.revokedAt
												? ` · 已撤销 ${new Date(identity.revokedAt).toLocaleDateString()}`
												: ""}
										</small>
									</div>
									{identity.name !== overview.identity.name && !identity.revokedAt && (
										<button
											type="button"
											onClick={() =>
												void prepare("/api/team/tokens/prepare", "/api/team/tokens/execute", {
													action: "revoke",
													name: identity.name,
												})
											}
										>
											撤销
										</button>
									)}
								</div>
							))}
						</div>
					</section>
				) : (
					<section className="panel">
						<span className="eyebrow">Collaboration boundary</span>
						<h2>当前角色权限</h2>
						<p>{roles.join(", ")}</p>
						<div className="callout">
							<strong>Token 不进入浏览器存储</strong>
							<span>本地服务从进程环境变量读取团队 token；GUI 只看到连接结果与角色。</span>
						</div>
					</section>
				)}
			</div>
		</>
	);
}

function ResearchPage() {
	const [overview, setOverview] = useState<any>();
	const [kind, setKind] = useState<"skim-card" | "comparison-matrix" | "evidence-graph">("skim-card");
	const [editing, setEditing] = useState<any>();
	const [title, setTitle] = useState("");
	const [author, setAuthor] = useState("researcher");
	const [authorType, setAuthorType] = useState<"human" | "ai-assisted">("human");
	const [humanReviewed, setHumanReviewed] = useState(true);
	const [modelVersion, setModelVersion] = useState("");
	const [reviewedBy, setReviewedBy] = useState("researcher");
	const [reviewedAt, setReviewedAt] = useState("");
	const [fields, setFields] = useState<Record<string, string>>({});
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingRequest, setPendingRequest] = useState<{ path: string; payload: Record<string, unknown> }>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const load = useCallback(async () => setOverview(await api("/api/research")), []);
	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [load]);
	const reset = (nextKind = kind) => {
		setKind(nextKind);
		setEditing(undefined);
		setTitle("");
		setFields({});
		setAuthorType("human");
		setHumanReviewed(true);
		setModelVersion("");
		setReviewedBy(author || "researcher");
		setReviewedAt("");
	};
	const edit = (record: any) => {
		setKind(record.kind);
		setEditing(record);
		setTitle(record.title);
		setAuthor(record.authorship.author);
		setAuthorType(record.authorship.type);
		setHumanReviewed(record.authorship.humanReviewed);
		setModelVersion(record.authorship.model ?? "");
		setReviewedBy(
			record.authorship.reviewedBy ?? (record.authorship.type === "human" ? record.authorship.author : ""),
		);
		setReviewedAt(record.authorship.reviewedAt ?? "");
		if (record.kind === "skim-card")
			setFields({
				paperId: record.paperId,
				researchQuestion: record.researchQuestion,
				problem: record.problem,
				method: record.method,
				datasets: record.datasets,
				findings: record.findings,
				limitations: record.limitations,
				unknowns: record.unknowns,
				page: String(record.sources[0]?.page ?? ""),
				quote: record.sources[0]?.quote ?? "",
			});
		if (record.kind === "comparison-matrix")
			setFields({
				paperIds: record.paperIds.join("\n"),
				dimensions: record.dimensions.join("\n"),
				cells: Object.entries(record.cells)
					.flatMap(([paperId, row]: any) =>
						Object.entries(row).map(([dimension, cell]: any) =>
							[
								paperId,
								dimension,
								cell.value,
								cell.sources?.[0]?.page ?? "",
								cell.sources?.[0]?.quote ?? "",
							].join(" | "),
						),
					)
					.join("\n"),
			});
		if (record.kind === "evidence-graph")
			setFields({
				question: record.question,
				humanConclusion: record.humanConclusion,
				aiSuggestions: record.aiSuggestions ?? "",
				cards: record.cards
					.map((card: any) =>
						[
							card.id,
							card.stance,
							card.confidence,
							card.claim,
							card.evidence,
							card.sources?.[0]?.paperId ?? "",
							card.sources?.[0]?.page ?? "",
							card.sources?.[0]?.quote ?? "",
						].join(" | "),
					)
					.join("\n"),
				edges: record.edges.map((edge: any) => [edge.from, edge.relation, edge.to].join(" | ")).join("\n"),
			});
	};
	const lines = (value: string) =>
		value
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean);
	const buildRecord = () => {
		const now = new Date().toISOString();
		const base = {
			id: editing?.id ?? `${kind}-${Date.now()}`,
			kind,
			title,
			authorship: {
				type: authorType,
				author,
				model: authorType === "ai-assisted" ? modelVersion || undefined : undefined,
				humanReviewed,
				reviewedBy: humanReviewed ? reviewedBy || (authorType === "human" ? author : undefined) : undefined,
				reviewedAt: humanReviewed ? reviewedAt || now : undefined,
			},
			createdAt: editing?.createdAt ?? now,
			updatedAt: now,
			revision: editing?.revision ?? 0,
		};
		if (kind === "skim-card")
			return {
				...base,
				kind,
				paperId: fields.paperId ?? "",
				researchQuestion: fields.researchQuestion ?? "",
				problem: fields.problem ?? "",
				method: fields.method ?? "",
				datasets: fields.datasets ?? "",
				findings: fields.findings ?? "",
				limitations: fields.limitations ?? "",
				unknowns: fields.unknowns ?? "",
				sources: fields.paperId
					? [
							{
								paperId: fields.paperId,
								page: fields.page ? Number(fields.page) : undefined,
								quote: fields.quote || undefined,
							},
						]
					: [],
			};
		if (kind === "comparison-matrix") {
			const paperIds = lines(fields.paperIds ?? "");
			const dimensions = lines(fields.dimensions ?? "");
			const cells: Record<string, Record<string, any>> = Object.fromEntries(paperIds.map((id) => [id, {}]));
			for (const line of lines(fields.cells ?? "")) {
				const [paperId, dimension, value, page, quote] = line.split("|").map((part) => part.trim());
				if (!paperId || !dimension || !value) continue;
				cells[paperId] ??= {};
				cells[paperId][dimension] = {
					value,
					sources: [{ paperId, page: page ? Number(page) : undefined, quote: quote || undefined }],
				};
			}
			return { ...base, kind, paperIds, dimensions, cells };
		}
		const cards = lines(fields.cards ?? "").map((line) => {
			const [id, stance, confidence, claim, evidence, paperId, page, quote] = line
				.split("|")
				.map((part) => part.trim());
			return {
				id,
				stance,
				confidence,
				claim,
				evidence,
				sources: paperId ? [{ paperId, page: page ? Number(page) : undefined, quote: quote || undefined }] : [],
			};
		});
		const edges = lines(fields.edges ?? "").map((line) => {
			const [from, relation, to] = line.split("|").map((part) => part.trim());
			return { from, relation, to };
		});
		return {
			...base,
			kind,
			question: fields.question ?? "",
			humanConclusion: fields.humanConclusion ?? "",
			aiSuggestions: fields.aiSuggestions || undefined,
			cards,
			edges,
		};
	};
	const prepare = async (path: string, executePath: string, payload: Record<string, unknown>) => {
		setError("");
		setMessage("");
		try {
			setPendingRequest({ path: executePath, payload });
			setPending(await api<PreparedOperation>(path, jsonBody(payload)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const save = () => prepare("/api/research/write/prepare", "/api/research/write/execute", { record: buildRecord() });
	const share = (record: any) =>
		prepare("/api/research/share/prepare", "/api/research/share/execute", { kind: record.kind, id: record.id });
	const execute = async () => {
		if (!pending || !pendingRequest) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			await api(pendingRequest.path, jsonBody({ ...pendingRequest.payload, grant }));
			setMessage(
				pendingRequest.path.includes("share")
					? "已提交到团队 derived memory 审核队列。"
					: "调研记录已持久化并写入审计日志。",
			);
			setPending(undefined);
			setPendingRequest(undefined);
			reset(kind);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const records: any[] = overview?.records ?? [];
	return (
		<>
			<PageHeading
				eyebrow="Human-led synthesis"
				title="调研工作区"
				description="略读卡、比较矩阵和证据图均保留原文 locator；人工结论与 AI 辅助内容分开。"
				actions={
					<button className="button primary" type="button" onClick={() => reset(kind)}>
						新建记录
					</button>
				}
			/>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => {
						setPending(undefined);
						setPendingRequest(undefined);
					}}
					onConfirm={() => void execute()}
				/>
			)}
			<div className="metric-grid">
				<div className="metric-card accent">
					<span>略读卡</span>
					<strong>{overview?.counts?.skimCards ?? 0}</strong>
					<small>定位到论文、页码与引用</small>
				</div>
				<div className="metric-card">
					<span>比较矩阵</span>
					<strong>{overview?.counts?.comparisonMatrices ?? 0}</strong>
					<small>跨论文维度比较</small>
				</div>
				<div className="metric-card">
					<span>证据图</span>
					<strong>{overview?.counts?.evidenceGraphs ?? 0}</strong>
					<small>支持、反证与未知</small>
				</div>
				<div className="metric-card">
					<span>AI 草稿</span>
					<strong>{overview?.counts?.aiDrafts ?? 0}</strong>
					<small>不能覆盖人工记录</small>
				</div>
			</div>
			<div className="research-workspace-layout">
				<section className="panel research-records">
					<span className="eyebrow">Persistent memory</span>
					<h2>已有调研记录</h2>
					<div className="research-record-list">
						{records.length ? (
							records.map((record) => (
								<article key={`${record.kind}-${record.id}`}>
									<button type="button" onClick={() => edit(record)}>
										<StatusPill status={record.authorship.type === "human" ? "high" : "medium"} />
										<div>
											<strong>{record.title}</strong>
											<small>
												{record.kind} · rev {record.revision} · 来源：{record.authorship.author}
												{record.authorship.model ? ` (${record.authorship.model})` : ""}
												{record.authorship.humanReviewed
													? ` · 人工复核：${record.authorship.reviewedBy}`
													: " · 未人工复核"}
											</small>
										</div>
									</button>
									<div className="row-actions">
										<button type="button" onClick={() => edit(record)}>
											编辑
										</button>
										<button
											type="button"
											disabled={!record.authorship.humanReviewed}
											onClick={() => void share(record)}
										>
											共享
										</button>
									</div>
								</article>
							))
						) : (
							<EmptyState title="暂无调研记录" text="在右侧创建第一张略读卡、比较矩阵或证据图。" />
						)}
					</div>
				</section>
				<section className="panel research-editor">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Structured editor</span>
							<h2>
								{editing ? "编辑" : "新建"}
								{kind === "skim-card" ? "略读卡" : kind === "comparison-matrix" ? "比较矩阵" : "证据图"}
							</h2>
						</div>
						<select value={kind} onChange={(event) => reset(event.target.value as typeof kind)}>
							<option value="skim-card">略读卡</option>
							<option value="comparison-matrix">比较矩阵</option>
							<option value="evidence-graph">证据图</option>
						</select>
					</div>
					<div className="form-grid two">
						<label className="wide">
							<span>标题</span>
							<input value={title} onChange={(event) => setTitle(event.target.value)} />
						</label>
						<label>
							<span>作者</span>
							<input value={author} onChange={(event) => setAuthor(event.target.value)} />
						</label>
						<label>
							<span>内容来源</span>
							<select
								value={authorType}
								onChange={(event) => {
									const value = event.target.value as typeof authorType;
									setAuthorType(value);
									if (value === "ai-assisted") {
										setHumanReviewed(false);
										setReviewedBy("");
										setReviewedAt("");
									} else {
										setReviewedBy(author);
									}
								}}
							>
								<option value="human">人工撰写</option>
								<option value="ai-assisted">AI 辅助草稿</option>
							</select>
						</label>
						{authorType === "ai-assisted" && (
							<label>
								<span>模型 / 版本</span>
								<input
									value={modelVersion}
									onChange={(event) => setModelVersion(event.target.value)}
									placeholder="provider/model 或流水线版本"
								/>
							</label>
						)}
					</div>
					<label className="toggle-row">
						<input
							type="checkbox"
							checked={humanReviewed}
							onChange={(event) => {
								setHumanReviewed(event.target.checked);
								if (event.target.checked && authorType === "human" && !reviewedBy) setReviewedBy(author);
								if (!event.target.checked) setReviewedAt("");
							}}
						/>
						<span>
							{authorType === "ai-assisted"
								? "已有独立研究者人工复核此 AI 草稿"
								: "我已人工核验，可允许提议到团队库"}
						</span>
					</label>
					{humanReviewed && (
						<div className="form-grid two review-provenance">
							<label>
								<span>人工复核人</span>
								<input
									value={reviewedBy}
									onChange={(event) => setReviewedBy(event.target.value)}
									placeholder="必须是真实研究者；不能与 AI 作者相同"
								/>
							</label>
							<label>
								<span>复核时间</span>
								<input
									type="datetime-local"
									value={reviewedAt ? reviewedAt.slice(0, 16) : ""}
									onChange={(event) =>
										setReviewedAt(event.target.value ? new Date(event.target.value).toISOString() : "")
									}
								/>
							</label>
							<p className="wide form-hint">留空复核时间时，保存会使用当前时间；AI 作者身份会原样保留。</p>
						</div>
					)}
					{kind === "skim-card" && (
						<div className="form-grid two">
							<label>
								<span>Paper ID</span>
								<input
									value={fields.paperId ?? ""}
									onChange={(event) => setFields({ ...fields, paperId: event.target.value })}
								/>
							</label>
							<label>
								<span>物理页码</span>
								<input
									type="number"
									min="1"
									value={fields.page ?? ""}
									onChange={(event) => setFields({ ...fields, page: event.target.value })}
								/>
							</label>
							{[
								["researchQuestion", "研究问题"],
								["problem", "问题与动机"],
								["method", "方法"],
								["datasets", "数据集/实验对象"],
								["findings", "主要发现"],
								["limitations", "局限"],
								["unknowns", "未知与待核验"],
								["quote", "原文引用"],
							].map(([key, label]) => (
								<label className="wide" key={key}>
									<span>{label}</span>
									<textarea
										rows={key === "quote" ? 3 : 4}
										value={fields[key] ?? ""}
										onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
									/>
								</label>
							))}
						</div>
					)}
					{kind === "comparison-matrix" && (
						<div className="form-grid">
							<label>
								<span>Paper IDs（每行一个）</span>
								<textarea
									rows={4}
									value={fields.paperIds ?? ""}
									onChange={(event) => setFields({ ...fields, paperIds: event.target.value })}
								/>
							</label>
							<label>
								<span>比较维度（每行一个）</span>
								<textarea
									rows={4}
									value={fields.dimensions ?? ""}
									onChange={(event) => setFields({ ...fields, dimensions: event.target.value })}
								/>
							</label>
							<label>
								<span>单元格：paperId | 维度 | 内容 | 页码 | 原文引用（每行一项）</span>
								<textarea
									rows={10}
									value={fields.cells ?? ""}
									onChange={(event) => setFields({ ...fields, cells: event.target.value })}
								/>
							</label>
						</div>
					)}
					{kind === "evidence-graph" && (
						<div className="form-grid">
							{[
								["question", "研究判断/问题"],
								["humanConclusion", "人工结论"],
								["aiSuggestions", "AI 建议（不能覆盖人工结论）"],
							].map(([key, label]) => (
								<label key={key}>
									<span>{label}</span>
									<textarea
										rows={4}
										value={fields[key] ?? ""}
										onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
									/>
								</label>
							))}
							<label>
								<span>
									证据卡：id | support/challenge/unknown | high/medium/low | claim | evidence | paperId | page
									| quote
								</span>
								<textarea
									rows={9}
									value={fields.cards ?? ""}
									onChange={(event) => setFields({ ...fields, cards: event.target.value })}
								/>
							</label>
							<label>
								<span>关系：from | supports/challenges/depends-on/contradicts | to</span>
								<textarea
									rows={5}
									value={fields.edges ?? ""}
									onChange={(event) => setFields({ ...fields, edges: event.target.value })}
								/>
							</label>
						</div>
					)}
					<div className="button-row editor-actions">
						<button className="button secondary" type="button" onClick={() => reset(kind)}>
							清空
						</button>
						<button
							className="button primary"
							type="button"
							disabled={
								!title ||
								!author ||
								(authorType === "ai-assisted" &&
									humanReviewed &&
									(!reviewedBy.trim() || reviewedBy.trim().toLowerCase() === author.trim().toLowerCase()))
							}
							onClick={() => void save()}
						>
							检查并保存
						</button>
					</div>
				</section>
			</div>
			<div className="human-boundary">
				<strong>AI 使用边界</strong>
				<p>
					AI
					草稿不能覆盖任何人工撰写记录，也不能修改证据图中的人工结论；只有标记为人工核验的记录才能进入团队审核队列。
				</p>
			</div>
		</>
	);
}

function SettingsPage({ status }: { status?: ApplicationStatus }) {
	const [config, setConfig] = useState<PaperAgentConfigView>();
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingConfig, setPendingConfig] = useState<unknown>();
	const [pendingAction, setPendingAction] = useState<"save" | "probe">("save");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [dirty, setDirty] = useState(false);
	const load = useCallback(async () => {
		setConfig(await api<PaperAgentConfigView>("/api/config"));
		setDirty(false);
	}, []);
	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [load]);
	const update = (recipe: (next: PaperAgentConfigView) => void) => {
		setDirty(true);
		setConfig((current) => {
			if (!current) return current;
			const next = structuredClone(current);
			recipe(next);
			return next;
		});
	};
	const updateModel = (recipe: (model: NonNullable<PaperAgentConfigView["model"]>) => void) =>
		update((next) => {
			if (!next.model) return;
			recipe(next.model);
			delete next.model.toolCallingProbe;
			delete next.model.toolCallingVerifiedAt;
		});
	const serializable = () => {
		if (!config) return undefined;
		const next: any = structuredClone(config);
		delete next.path;
		if (next.model) delete next.model.credentialsAvailable;
		if (next.team) delete next.team.credentialsAvailable;
		return next;
	};
	const prepareSave = async () => {
		const candidate = serializable();
		if (!candidate) return;
		setError("");
		setMessage("");
		try {
			setPendingConfig(candidate);
			setPendingAction("save");
			setPending(await api<PreparedOperation>("/api/config/prepare", jsonBody({ config: candidate })));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const prepareProbe = async () => {
		setError("");
		setMessage("");
		try {
			setPendingAction("probe");
			setPending(await api<PreparedOperation>("/api/model-probe/prepare", jsonBody({})));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const executePending = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			if (pendingAction === "save") {
				const result = await api<{ restartRequired: boolean }>(
					"/api/config/execute",
					jsonBody({ config: pendingConfig, grant }),
				);
				setMessage(
					result.restartRequired
						? "设置已保存。存储路径或 namespace 已改变，请重启 Paper Agent。"
						: "设置已保存并立即生效。服务级选项会在下次启动时应用。",
				);
			} else {
				const result = await api<{ supported: boolean; reason: string; latencyMs: number }>(
					"/api/model-probe/execute",
					jsonBody({ grant }),
				);
				setMessage(
					`Tool calling 探测${result.supported ? "通过" : "未通过"}：${result.reason}（${result.latencyMs} ms）`,
				);
			}
			setPending(undefined);
			setPendingConfig(undefined);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	if (!config)
		return (
			<>
				<PageHeading eyebrow="Environment" title="设置与诊断" description="读取本地配置中。" />
				{error ? <div className="error-banner">{error}</div> : <LoadingBlock />}
			</>
		);
	const automaticModelProbe = Boolean(
		config.model && ["openai-completions", "openai-responses"].includes(config.model.api),
	);
	return (
		<>
			<PageHeading
				eyebrow="Environment"
				title="设置与诊断"
				description="配置只保存环境变量名，不保存 API key 或团队 token；所有写入都需要确认。"
				actions={
					<button
						className="button primary"
						type="button"
						disabled={!dirty || busy}
						onClick={() => void prepareSave()}
					>
						{dirty ? "保存设置" : "设置已保存"}
					</button>
				}
			/>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={() => void executePending()}
				/>
			)}
			<div className="settings-form">
				<section className="panel form-panel">
					<span className="eyebrow">Local workspace</span>
					<h2>界面与存储</h2>
					<div className="form-grid two">
						<label>
							<span>默认个人 namespace</span>
							<input
								value={config.storage.defaultNamespace}
								onChange={(event) =>
									update((next) => {
										next.storage.defaultNamespace = event.target.value;
									})
								}
							/>
						</label>
						<label>
							<span>本地 Web 端口</span>
							<input
								type="number"
								min="0"
								max="65535"
								value={config.interface.port}
								onChange={(event) =>
									update((next) => {
										next.interface.port = Number(event.target.value);
									})
								}
							/>
						</label>
						<label className="wide">
							<span>运行数据目录（留空使用项目内 .paper-agent）</span>
							<input
								value={config.storage.dataRoot ?? ""}
								onChange={(event) =>
									update((next) => {
										next.storage.dataRoot = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label className="wide">
							<span>Corpus 目录（留空跟随运行数据目录）</span>
							<input
								value={config.storage.corpusRoot ?? ""}
								onChange={(event) =>
									update((next) => {
										next.storage.corpusRoot = event.target.value || undefined;
									})
								}
							/>
						</label>
					</div>
					<label className="toggle-row">
						<input
							type="checkbox"
							checked={config.interface.openBrowser}
							onChange={(event) =>
								update((next) => {
									next.interface.openBrowser = event.target.checked;
								})
							}
						/>
						<span>启动时自动打开浏览器</span>
					</label>
					<p className="form-hint">
						配置文件：<code>{config.path}</code>
					</p>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">Literature discovery</span>
					<h2>搜索默认值</h2>
					<div className="form-grid two">
						<label className="wide">
							<span>默认数据源（逗号分隔）</span>
							<input
								value={config.search.providers.join(", ")}
								onChange={(event) =>
									update((next) => {
										next.search.providers = event.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean);
									})
								}
							/>
						</label>
						<label>
							<span>每源结果上限</span>
							<input
								type="number"
								min="1"
								max="500"
								value={config.search.maxResultsPerProvider}
								onChange={(event) =>
									update((next) => {
										next.search.maxResultsPerProvider = Number(event.target.value);
									})
								}
							/>
						</label>
						<label>
							<span>每源页数</span>
							<input
								type="number"
								min="1"
								max="20"
								value={config.search.pagesPerProvider}
								onChange={(event) =>
									update((next) => {
										next.search.pagesPerProvider = Number(event.target.value);
									})
								}
							/>
						</label>
						<label className="wide">
							<span>默认查询扩展（每行一条）</span>
							<textarea
								value={config.search.queryExpansions.join("\n")}
								onChange={(event) =>
									update((next) => {
										next.search.queryExpansions = event.target.value
											.split(/\r?\n/)
											.map((value) => value.trim())
											.filter(Boolean);
									})
								}
							/>
						</label>
					</div>
					<label className="toggle-row">
						<input
							type="checkbox"
							checked={config.search.reuseCorpus}
							onChange={(event) =>
								update((next) => {
									next.search.reuseCorpus = event.target.checked;
								})
							}
						/>
						<span>检索时优先复用个人库已有记录</span>
					</label>
				</section>
				<section className="panel form-panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Model endpoint</span>
							<h2>模型与工具调用</h2>
						</div>
						<label className="switch">
							<input
								type="checkbox"
								checked={Boolean(config.model)}
								onChange={(event) =>
									update((next) => {
										if (event.target.checked)
											next.model = {
												providerId: "research-relay",
												modelId: "",
												api: "openai-completions",
												baseUrl: "",
												apiKeyEnvironmentVariable: "PAPER_AGENT_RELAY_API_KEY",
											};
										else delete next.model;
									})
								}
							/>
							<span />
						</label>
					</div>
					{config.model ? (
						<div className="form-grid two">
							<label>
								<span>Provider ID</span>
								<input
									value={config.model.providerId}
									onChange={(event) =>
										updateModel((model) => {
											model.providerId = event.target.value;
										})
									}
								/>
							</label>
							<label>
								<span>模型 ID</span>
								<input
									value={config.model.modelId}
									onChange={(event) =>
										updateModel((model) => {
											model.modelId = event.target.value;
										})
									}
								/>
							</label>
							<label className="wide">
								<span>Base URL</span>
								<input
									value={config.model.baseUrl}
									placeholder="https://relay.example.com/v1"
									onChange={(event) =>
										updateModel((model) => {
											model.baseUrl = event.target.value;
										})
									}
								/>
							</label>
							<label>
								<span>API 类型</span>
								<select
									value={config.model.api}
									onChange={(event) =>
										updateModel((model) => {
											model.api = event.target.value as NonNullable<PaperAgentConfigView["model"]>["api"];
										})
									}
								>
									<option value="openai-completions">openai-completions</option>
									<option value="openai-responses">openai-responses</option>
									<option value="anthropic-messages">anthropic-messages</option>
									<option value="google-generative-ai">google-generative-ai</option>
								</select>
							</label>
							<label>
								<span>API key 环境变量名</span>
								<input
									value={config.model.apiKeyEnvironmentVariable}
									onChange={(event) =>
										updateModel((model) => {
											model.apiKeyEnvironmentVariable = event.target.value.toUpperCase();
										})
									}
								/>
							</label>
							<div className="wide capability-row">
								<StatusPill status={config.model.credentialsAvailable ? "succeeded" : "failed"} />
								<span>
									{config.model.credentialsAvailable
										? "当前进程已读取到密钥"
										: `未找到 ${config.model.apiKeyEnvironmentVariable}`}
								</span>
								{config.model.toolCallingProbe && <small>{config.model.toolCallingProbe.reason}</small>}
								{dirty && <small>模型配置有未保存修改；保存后才能对当前 endpoint 进行探测。</small>}
								{!automaticModelProbe && (
									<small>该 API 类型不能自动探测；请在 Pi 会话中运行一个真实的工具调用任务并检查结果。</small>
								)}
								<button
									className="button secondary"
									disabled={dirty || !config.model.credentialsAvailable || !automaticModelProbe}
									type="button"
									onClick={() => void prepareProbe()}
								>
									{automaticModelProbe ? "探测 tool calling" : "需要手工验证"}
								</button>
							</div>
						</div>
					) : (
						<p className="muted">
							GUI 不依赖模型即可管理论文；需要 AI 对话时可在这里记录 endpoint，密钥仍由环境变量提供。
						</p>
					)}
				</section>
				<section className="panel form-panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Team connection</span>
							<h2>团队知识库</h2>
						</div>
						<label className="switch">
							<input
								type="checkbox"
								checked={Boolean(config.team)}
								onChange={(event) =>
									update((next) => {
										if (event.target.checked)
											next.team = {
												serverUrl: "https://",
												namespace: next.storage.defaultNamespace,
												tokenEnvironmentVariable: "PAPER_AGENT_TEAM_TOKEN",
											};
										else delete next.team;
									})
								}
							/>
							<span />
						</label>
					</div>
					{config.team ? (
						<div className="form-grid two">
							<label className="wide">
								<span>团队服务 URL</span>
								<input
									value={config.team.serverUrl}
									onChange={(event) =>
										update((next) => {
											next.team!.serverUrl = event.target.value;
										})
									}
								/>
							</label>
							<label>
								<span>团队 namespace</span>
								<input
									value={config.team.namespace}
									onChange={(event) =>
										update((next) => {
											next.team!.namespace = event.target.value;
										})
									}
								/>
							</label>
							<label>
								<span>Token 环境变量名</span>
								<input
									value={config.team.tokenEnvironmentVariable}
									onChange={(event) =>
										update((next) => {
											next.team!.tokenEnvironmentVariable = event.target.value.toUpperCase();
										})
									}
								/>
							</label>
							<div className="wide capability-row">
								<StatusPill status={config.team.credentialsAvailable ? "succeeded" : "failed"} />
								<span>
									{config.team.credentialsAvailable
										? "团队 token 已就绪"
										: `未找到 ${config.team.tokenEnvironmentVariable}`}
								</span>
							</div>
						</div>
					) : (
						<p className="muted">不配置团队服务时，个人库仍保持完全可用和本地隔离。</p>
					)}
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">Diagnostics</span>
					<h2>运行状态</h2>
					<dl>
						<dt>项目</dt>
						<dd>
							<code>{status?.projectRoot}</code>
						</dd>
						<dt>Corpus</dt>
						<dd>
							<code>{status?.corpusRoot}</code>
						</dd>
						<dt>运行数据</dt>
						<dd>
							<code>{status?.dataRoot}</code>
						</dd>
						<dt>监听</dt>
						<dd>127.0.0.1 + 临时令牌</dd>
					</dl>
					<code className="command-block">paper-agent --doctor --probe-model</code>
				</section>
			</div>
		</>
	);
}

export default function App() {
	const initialPdf = useMemo(() => launchPdfPath(), []);
	const [page, setPage] = useState<Page>(initialPdf ? "reader" : "dashboard");
	const [status, setStatus] = useState<ApplicationStatus>();
	const [reader, setReader] = useState<ReaderState | undefined>(() =>
		initialPdf
			? {
					title: initialPdf.split(/[\\/]/).at(-1) ?? "本地论文",
					url: `/api/local-pdf?path=${encodeURIComponent(initialPdf)}`,
					pdfPath: initialPdf,
				}
			: undefined,
	);
	const [lastTask, setLastTask] = useState<BackgroundJob>();
	const [error, setError] = useState("");
	const refreshStatus = useCallback(async () => {
		try {
			setStatus(await api<ApplicationStatus>("/api/status"));
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, []);
	useEffect(() => {
		if (!hasSessionToken()) {
			setError("本地会话令牌缺失。请通过 paper-agent 命令重新打开界面。");
			return;
		}
		void refreshStatus();
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") void refreshStatus();
		}, 5_000);
		return () => window.clearInterval(interval);
	}, [refreshStatus]);
	const go = (next: Page) => {
		setPage(next);
		void refreshStatus();
	};
	const trackTask = (task: BackgroundJob) => {
		setLastTask(task);
		void refreshStatus();
	};
	const openReader = (state: ReaderState) => {
		setReader(state);
		setPage("reader");
	};
	const title = useMemo(() => navigation.find((item) => item.id === page)?.label ?? "论文阅读器", [page]);
	let lastSection = "";
	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand">
					<div className="brand-mark">P</div>
					<div>
						<strong>Paper Agent</strong>
						<span>Evidence workspace</span>
					</div>
				</div>
				<nav>
					{navigation.map((item) => {
						const section = item.section && item.section !== lastSection ? item.section : undefined;
						if (item.section) lastSection = item.section;
						return (
							<div key={item.id}>
								{section && <span className="nav-section">{section}</span>}
								<button className={page === item.id ? "active" : ""} type="button" onClick={() => go(item.id)}>
									<span>{item.icon}</span>
									{item.label}
								</button>
							</div>
						);
					})}
				</nav>
				<div className="sidebar-footer">
					<span className="health-dot" />
					<div>
						<strong>本地服务已连接</strong>
						<small>{status?.defaultRecordCount ?? 0} 篇个人论文</small>
					</div>
				</div>
			</aside>
			<main className="main-area">
				<div className="topbar">
					<div>
						<span className="breadcrumb">Paper Agent /</span> {title}
					</div>
					<div className="topbar-actions">
						{lastTask && (
							<button type="button" onClick={() => go("tasks")}>
								<StatusPill status={lastTask.status} />
								{lastTask.type}
							</button>
						)}
						<span className="local-badge">LOCAL FIRST</span>
					</div>
				</div>
				<div className="page-content">
					{error && <div className="error-banner">{error}</div>}
					{page === "dashboard" && <DashboardPage status={status} go={go} />}
					{page === "search" && <SearchPage onTask={trackTask} />}
					{page === "agent" && <AgentPage />}
					{page === "library" && <LibraryPage onOpenReader={openReader} onTask={trackTask} />}
					{page === "tasks" && <TasksPage />}
					{page === "pdf" && <PdfWorkspacePage onTask={trackTask} />}
					{page === "quality" && <ArtifactEvaluationPage />}
					{page === "reader" && reader && (
						<ReaderPage reader={reader} onBack={() => go("library")} onTask={trackTask} />
					)}
					{page === "team" && <TeamPage />}
					{page === "research" && <ResearchPage />}
					{page === "settings" && <SettingsPage status={status} />}
				</div>
			</main>
		</div>
	);
}
