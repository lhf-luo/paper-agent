import { Bot, Check, FileStack, FolderOpen, NotebookPen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentPage } from "./agent-page";
import { api, apiBytes, jsonBody, launchPdfPath } from "./api";
import { BrowserPdfReader } from "./browser-pdf-reader";
import {
	ConsentCard,
	confirmOperation,
	EmptyState,
	JobProgress,
	LoadingBlock,
	PaperCard,
	PaperDetailDrawer,
	PdfViewer,
	SearchResultTable,
	StatusPill,
	useJob,
} from "./components";
import {
	ConfirmationPolicyProvider,
	requiresWebOperationConfirmation,
	useAutomaticOperationConfirmation,
	useConfirmationPolicy,
} from "./confirmation-policy";
import { CollectionSidebar } from "./library-collections";
import { MineruControl } from "./mineru-control";
import { PdfTranslationControl } from "./pdf-translation-control";
import { ReaderNoteCreatePanel, ReaderNotePanel } from "./reader-note-panels";
import { ResearchNotesPage } from "./research-notes-page";
import type {
	AgentSearchRun,
	AgentSearchRunSummary,
	BackgroundJob,
	CollectionMembershipIndex,
	ConfirmationGrant,
	LocalPdfImportBatchView,
	LocalPdfImportFilePreview,
	OperationConfirmationSettingsView,
	PaperAgentConfigView,
	PaperAsset,
	PaperCollection,
	PaperRecord,
	PaperVersionView,
	PdfTranslationEngineStatus,
	PreparedOperation,
	ResearchNote,
	ResearchNoteNavigation,
	ResearchNoteSummary,
	TeamAccessStatus,
	ZoteroCollectionEntry,
	ZoteroExportPreparation,
	ZoteroImportPreparation,
	ZoteroImportResult,
	ZoteroLibraryItem,
	ZoteroStatus,
} from "./types";
import { WikiPage } from "./wiki-page";
import {
	ALL_ZOTERO_ITEMS,
	allZoteroItemKeys,
	missingMetadataZoteroItems,
	UNCATEGORIZED_ZOTERO_ITEMS,
	zoteroItemsForCollection,
} from "./zotero-selection";

interface LocalPdfImportIssue {
	filename: string;
	message: string;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function zoteroActionLabel(action: ZoteroImportPreparation["items"][number]["action"]): string {
	return { create: "新建", update: "更新", unchanged: "无需更新", conflict: "冲突", skip: "跳过" }[action];
}

function zoteroMissingFields(fields: Array<"title" | "authors"> | undefined): string | undefined {
	if (!fields?.length) return undefined;
	const labels = { title: "标题", authors: "作者" };
	return `缺失信息：${fields.map((field) => labels[field]).join("、")}`;
}

function ZoteroSelectionCheckbox({
	label,
	itemKeys,
	selected,
	onToggle,
}: {
	label: string;
	itemKeys: string[];
	selected: ReadonlySet<string>;
	onToggle: (itemKeys: string[], checked: boolean) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedCount = itemKeys.reduce((count, key) => count + Number(selected.has(key)), 0);
	const checked = itemKeys.length > 0 && selectedCount === itemKeys.length;
	const indeterminate = selectedCount > 0 && !checked;
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<input
			ref={inputRef}
			type="checkbox"
			checked={checked}
			disabled={itemKeys.length === 0}
			aria-label={`选择${label}中的全部论文`}
			onChange={() => onToggle(itemKeys, !checked)}
		/>
	);
}

type Page =
	| "dashboard"
	| "search"
	| "agent"
	| "library"
	| "tasks"
	| "pdf"
	| "team"
	| "research"
	| "wiki"
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
	confirmations: OperationConfirmationSettingsView;
	jobs: { queued: number; running: number; failed: number };
}

interface ReaderState {
	title: string;
	url: string;
	pdfPath?: string;
	paperId?: string;
	namespace?: string;
	sha256?: string;
	bytes?: number;
	retrievedAt?: string;
	versionKind?: "published" | "preprint" | "supplement" | "translation" | "unknown";
	versionLabel?: string;
}

type ReaderWorkspaceTab =
	| { id: "agent"; kind: "agent"; title: string }
	| { id: string; kind: "note"; noteId: string; title: string }
	| { id: "new-note"; kind: "new-note"; title: string };

interface ReaderPaperDetails {
	paper: PaperRecord;
	versions: PaperVersionView[];
}

function readerVersionState(paper: PaperRecord, namespace: string, version: PaperVersionView): ReaderState {
	return {
		title: paper.title,
		url: `/api/papers/${encodeURIComponent(paper.id)}/pdf/${version.sha256}?namespace=${encodeURIComponent(namespace)}`,
		pdfPath: version.blobPath,
		paperId: paper.id,
		namespace,
		sha256: version.sha256,
		bytes: version.bytes,
		retrievedAt: version.retrievedAt,
		versionKind: version.versionKind,
		versionLabel: version.versionLabel,
	};
}

function readerVersionName(version: Pick<ReaderState, "versionKind" | "versionLabel">): string {
	if (version.versionKind === "translation") return version.versionLabel ? `译文 · ${version.versionLabel}` : "译文";
	if (version.versionKind === "published") return version.versionLabel || "正式版本";
	if (version.versionKind === "preprint") return version.versionLabel || "预印本";
	if (version.versionKind === "supplement") return version.versionLabel || "补充材料";
	return version.versionLabel || "其他版本";
}

function readerTabsStorageKey(reader: ReaderState): string | undefined {
	return reader.namespace && reader.paperId
		? `paper-agent-reader-tabs:${reader.namespace}:${reader.paperId}`
		: undefined;
}

function restoredReaderTabs(reader: ReaderState): { tabs: ReaderWorkspaceTab[]; activeId?: string } {
	const key = readerTabsStorageKey(reader);
	if (!key) return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
		const parsed = JSON.parse(raw) as { tabs?: ReaderWorkspaceTab[]; activeId?: string };
		const tabs = (parsed.tabs ?? []).filter(
			(tab): tab is ReaderWorkspaceTab =>
				tab?.kind === "agent" ||
				(tab?.kind === "note" && typeof tab.noteId === "string" && typeof tab.title === "string"),
		);
		return { tabs, activeId: tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : tabs[0]?.id };
	} catch {
		return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
	}
}

const navigation: Array<{ id: Page; label: string; icon: string; section?: string }> = [
	{ id: "dashboard", label: "总览", icon: "⌂" },
	{ id: "search", label: "搜索论文", icon: "⌕" },
	{ id: "agent", label: "Agent 对话", icon: "✦" },
	{ id: "library", label: "个人库", icon: "▤" },
	{ id: "tasks", label: "任务中心", icon: "◷" },
	{ id: "pdf", label: "PDF 与 Artifact", icon: "▧", section: "研究工具" },
	{ id: "team", label: "团队知识库", icon: "◎" },
	{ id: "research", label: "调研工作区", icon: "◇" },
	{ id: "wiki", label: "知识库", icon: "◫" },
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
	const [detailPaper, setDetailPaper] = useState<PaperRecord | undefined>();
	const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
	const [pending, setPending] = useState<PreparedOperation>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const runRequestSequence = useRef(0);
	const [providerCatalog, setProviderCatalog] = useState<
		Array<{
			id: string;
			label: string;
			description: string;
			capabilities: string[];
			searchConstraints?: {
				exactYear?: boolean;
				singleVenue?: boolean;
				supportedVenues?: string[];
			};
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
		const requestSequence = ++runRequestSequence.current;
		setBusy(true);
		setError("");
		try {
			const response = await api<{ run: AgentSearchRun }>(
				`/api/search/runs/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`,
			);
			if (requestSequence === runRequestSequence.current) setSelectedRun(response.run);
		} catch (reason) {
			if (requestSequence === runRequestSequence.current) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		} finally {
			if (requestSequence === runRequestSequence.current) setBusy(false);
		}
	};
	useEffect(() => {
		void Promise.all([
			api<{ providers: typeof providerCatalog }>("/api/providers"),
			api<PaperAgentConfigView>("/api/config"),
			api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces"),
		])
			.then(([catalogResponse, config, namespaceResponse]) => {
				setProviderCatalog(catalogResponse.providers);
				const available = new Set(
					catalogResponse.providers
						.filter(
							(provider) => provider.credentialsAvailable && provider.capabilities.includes("keyword-search"),
						)
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
	useEffect(() => {
		const controller = new AbortController();
		runRequestSequence.current += 1;
		setAgentRuns([]);
		setSelectedRun(undefined);
		setSelectedRunId("");
		setSelected(new Set());
		setDetailPaper(undefined);
		setPending(undefined);
		setSearchJobId(undefined);
		setBusy(false);
		setError("");
		void api<{ runs: AgentSearchRunSummary[] }>(`/api/search/runs?namespace=${encodeURIComponent(namespace)}`, {
			signal: controller.signal,
		})
			.then((response) => {
				if (!controller.signal.aborted) setAgentRuns(response.runs);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [namespace]);
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
			const selectedVenues = listValues(venues);
			for (const providerId of providers) {
				const constraints = providerCatalog.find((provider) => provider.id === providerId)?.searchConstraints;
				if (constraints?.exactYear && (!yearFrom || yearFrom !== yearTo)) {
					throw new Error("ACL Anthology 需要填写相同的起始年份和结束年份");
				}
				if (constraints?.singleVenue && selectedVenues.length !== 1) {
					throw new Error("ACL Anthology 需要且只能填写一个会议，例如 ACL 或 EMNLP");
				}
				if (
					constraints?.supportedVenues?.length &&
					selectedVenues.length === 1 &&
					!constraints.supportedVenues.includes(selectedVenues[0].toLowerCase())
				) {
					throw new Error(`ACL Anthology 不支持会议：${selectedVenues[0]}`);
				}
			}
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
						venues: selectedVenues,
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
		if (!job && !selectedRun) return;
		if (!selected.size) return;
		setBusy(true);
		setError("");
		try {
			setPending(
				await api(
					"/api/library/import/prepare",
					jsonBody({
						...(selectedRun ? { searchRunId: selectedRun.id } : { searchJobId: job?.id }),
						paperIds: [...selected],
						namespace,
					}),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const confirmSave = async () => {
		if (!pending || (!job && !selectedRun)) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/library/import/execute",
				jsonBody({
					...(selectedRun ? { searchRunId: selectedRun.id } : { searchJobId: job?.id }),
					paperIds: [...selected],
					namespace,
					grant,
				}),
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
									? providerCatalog.filter((provider) => provider.capabilities.includes("keyword-search"))
									: ["arxiv", "openalex", "crossref", "semanticscholar"].map((id) => ({
											id,
											label: id,
											description: id,
											capabilities: ["keyword-search"],
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
										title={`${provider.description}${provider.requiresEnvironmentVariable && !provider.credentialsAvailable ? `；未找到 ${provider.requiresEnvironmentVariable}` : ""}`}
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
					onConfirm={confirmSave}
				/>
			)}
			{agentRuns.length > 0 && (
				<div className="agent-run-picker">
					<label htmlFor="agent-run-select">
						<span>当前空间的搜索记录</span>
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
									{(entry.queries[0] ?? "").slice(0, 40)} · {entry.resultCount} 条 ·{" "}
									{timeLabel(entry.completedAt)}
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
								className={`button ${viewMode === "table" ? "primary" : "secondary"}`}
								type="button"
								onClick={() => setViewMode("table")}
							>
								表格视图
							</button>
							<button
								className={`button ${viewMode === "cards" ? "primary" : "secondary"}`}
								type="button"
								onClick={() => setViewMode("cards")}
							>
								卡片视图
							</button>
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
					{viewMode === "table" ? (
						<SearchResultTable
							papers={results}
							selected={selected}
							onSelect={(id, checked) =>
								setSelected((current) => {
									const next = new Set(current);
									if (checked) next.add(id);
									else next.delete(id);
									return next;
								})
							}
							onOpenAbstract={(paper) => setDetailPaper(paper)}
						/>
					) : (
						<div className="paper-list">
							{results.map((paper) => (
								<PaperCard
									key={paper.id}
									paper={paper}
									selected={selected.has(paper.id)}
									truncateAbstract
									onSelect={(checked) =>
										setSelected((current) => {
											const next = new Set(current);
											if (checked) next.add(paper.id);
											else next.delete(paper.id);
											return next;
										})
									}
									onOpen={() => setDetailPaper(paper)}
								/>
							))}
						</div>
					)}
				</section>
			)}
			{detailPaper && <PaperDetailDrawer paper={detailPaper} onClose={() => setDetailPaper(undefined)} />}
		</>
	);
}

function LibraryPage({
	onOpenReader,
	onTask,
	toolbarTarget,
	onOpenResearchNote,
}: {
	onOpenReader: (state: ReaderState) => void;
	onTask: (job: BackgroundJob) => void;
	toolbarTarget: HTMLDivElement | null;
	onOpenResearchNote: (target: ResearchNoteNavigation) => void;
}) {
	const confirmationSettings = useConfirmationPolicy();
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
	const [removalPending, setRemovalPending] = useState<PreparedOperation>();
	const [removalPayload, setRemovalPayload] = useState<Record<string, unknown>>();
	const [removalCardCollapsed, setRemovalCardCollapsed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [namespace, setNamespace] = useState("default");
	const [namespaces, setNamespaces] = useState<string[]>(["default"]);
	const [collections, setCollections] = useState<PaperCollection[]>([]);
	const [collectionMemberships, setCollectionMemberships] = useState<CollectionMembershipIndex>();
	const [collectionMembershipsLoading, setCollectionMembershipsLoading] = useState(true);
	const [activeCollection, setActiveCollection] = useState<string>("all");
	const [annotationTags, setAnnotationTags] = useState("");
	const [annotationNote, setAnnotationNote] = useState("");
	const [screeningStatus, setScreeningStatus] = useState("unreviewed");
	const [screeningReason, setScreeningReason] = useState("");
	const [screeningFilter, setScreeningFilter] = useState("all");
	const [exportFormat, setExportFormat] = useState("markdown");
	const [exportFilename, setExportFilename] = useState("");
	const [activeLibraryTool, setActiveLibraryTool] = useState<"curation" | "export">();
	const [localUploadingPaperId, setLocalUploadingPaperId] = useState<string>();
	const [importMenuOpen, setImportMenuOpen] = useState(false);
	const [localImportBatch, setLocalImportBatch] = useState<LocalPdfImportBatchView>();
	const [localImportIssues, setLocalImportIssues] = useState<LocalPdfImportIssue[]>([]);
	const [localImportProgress, setLocalImportProgress] = useState<{
		completed: number;
		total: number;
		filename: string;
	}>();
	const [localImportBusy, setLocalImportBusy] = useState(false);
	const [zoteroImportOpen, setZoteroImportOpen] = useState(false);
	const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus>();
	const [zoteroCollections, setZoteroCollections] = useState<ZoteroCollectionEntry[]>([]);
	const [zoteroItems, setZoteroItems] = useState<ZoteroLibraryItem[]>([]);
	const [zoteroItemKeys, setZoteroItemKeys] = useState<Set<string>>(new Set());
	const [activeZoteroCollection, setActiveZoteroCollection] = useState(ALL_ZOTERO_ITEMS);
	const [zoteroImportPrepared, setZoteroImportPrepared] = useState<ZoteroImportPreparation>();
	const [zoteroImportFinished, setZoteroImportFinished] = useState(false);
	const [zoteroImportProgress, setZoteroImportProgress] = useState<{ completed: number; total: number }>();
	const [zoteroExportPrepared, setZoteroExportPrepared] = useState<ZoteroExportPreparation>();
	const [zoteroBusy, setZoteroBusy] = useState(false);
	const [artifactFolderOpening, setArtifactFolderOpening] = useState(false);
	const [noteIndex, setNoteIndex] = useState<Record<string, ResearchNoteSummary[]>>({});
	const visibleZoteroItems = useMemo(
		() => zoteroItemsForCollection(zoteroCollections, zoteroItems, activeZoteroCollection, false),
		[zoteroCollections, zoteroItems, activeZoteroCollection],
	);
	const zoteroCollectionRows = useMemo(
		() => [
			{
				key: ALL_ZOTERO_ITEMS,
				label: "全部论文",
				depth: 0,
				itemKeys: allZoteroItemKeys(zoteroItems),
			},
			{
				key: UNCATEGORIZED_ZOTERO_ITEMS,
				label: "未分类",
				depth: 0,
				itemKeys: allZoteroItemKeys(
					zoteroItemsForCollection(zoteroCollections, zoteroItems, UNCATEGORIZED_ZOTERO_ITEMS, false),
				),
			},
			...zoteroCollections.map((collection) => ({
				key: collection.key,
				label: collection.name,
				depth: collection.path.length,
				itemKeys: allZoteroItemKeys(zoteroItemsForCollection(zoteroCollections, zoteroItems, collection.key, true)),
			})),
		],
		[zoteroCollections, zoteroItems],
	);
	const importButtonRef = useRef<HTMLButtonElement>(null);
	const importMenuRef = useRef<HTMLDivElement>(null);
	const localImportInputRef = useRef<HTMLInputElement>(null);
	const curationButtonRef = useRef<HTMLButtonElement>(null);
	const exportButtonRef = useRef<HTMLButtonElement>(null);
	const inlineToolRef = useRef<HTMLElement>(null);
	const localFileRef = useRef<HTMLInputElement>(null);
	const localPdfTargetRef = useRef<PaperRecord | undefined>(undefined);
	const localImportBatchIdRef = useRef<string | undefined>(undefined);
	const zoteroNamespaceRef = useRef(namespace);
	const zoteroImportOperationIdRef = useRef<string | undefined>(undefined);
	const zoteroExportOperationIdRef = useRef<string | undefined>(undefined);
	const cancelLocalImport = useCallback(async (returnFocus = true) => {
		const batchId = localImportBatchIdRef.current;
		setImportMenuOpen(false);
		setLocalImportBatch(undefined);
		setLocalImportIssues([]);
		setLocalImportProgress(undefined);
		localImportBatchIdRef.current = undefined;
		if (localImportInputRef.current) localImportInputRef.current.value = "";
		if (batchId) {
			try {
				await api(`/api/library/local-imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		}
		if (returnFocus) window.setTimeout(() => importButtonRef.current?.focus(), 0);
	}, []);
	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(() => {
			setMessage((current) => (current === message ? "" : current));
		}, 5_000);
		return () => window.clearTimeout(timer);
	}, [message]);
	useEffect(() => {
		localImportBatchIdRef.current = localImportBatch?.id;
	}, [localImportBatch?.id]);
	useEffect(() => {
		zoteroImportOperationIdRef.current = zoteroImportPrepared?.operation.operationId;
		zoteroExportOperationIdRef.current = zoteroExportPrepared?.operation.operationId;
	}, [zoteroImportPrepared?.operation.operationId, zoteroExportPrepared?.operation.operationId]);
	useEffect(
		() => () => {
			const batchId = localImportBatchIdRef.current;
			if (batchId) void fetch(`/api/library/local-imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
		},
		[],
	);
	useEffect(() => {
		if (!importMenuOpen) return;
		const closeMenu = (event: MouseEvent) => {
			if (!importMenuRef.current?.contains(event.target as Node)) setImportMenuOpen(false);
		};
		document.addEventListener("mousedown", closeMenu);
		return () => document.removeEventListener("mousedown", closeMenu);
	}, [importMenuOpen]);
	useEffect(() => {
		if (!importMenuOpen && !localImportBatch) return;
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (importMenuOpen) {
				setImportMenuOpen(false);
				importButtonRef.current?.focus();
				return;
			}
			if (!localImportBusy) void cancelLocalImport();
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [importMenuOpen, localImportBatch, localImportBusy, cancelLocalImport]);
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
			if (activeCollection !== "all") params.append("collection", activeCollection);
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
	}, [namespace, query, screeningFilter, activeCollection]);
	useEffect(() => {
		setSelected(new Set());
		setDetails(undefined);
		void load();
	}, [load]);
	useEffect(() => {
		if (!selected.size) setActiveLibraryTool(undefined);
	}, [selected.size]);
	useEffect(() => {
		if (!removalPending) setRemovalCardCollapsed(false);
	}, [removalPending]);
	useEffect(() => {
		if (!activeLibraryTool || annotationPending || exportPending) return;
		const timer = window.setTimeout(() => {
			inlineToolRef.current
				?.querySelector<HTMLElement>(
					".library-curation-form input, .library-curation-form select, .library-export-form select, .library-export-form input",
				)
				?.focus();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [activeLibraryTool, annotationPending, exportPending]);
	useEffect(() => {
		if (!activeLibraryTool || annotationPending || exportPending) return;
		const currentTool = activeLibraryTool;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setActiveLibraryTool(undefined);
			window.setTimeout(
				() => (currentTool === "curation" ? curationButtonRef.current : exportButtonRef.current)?.focus(),
				0,
			);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [activeLibraryTool, annotationPending, exportPending]);
	const loadCollectionData = useCallback(async () => {
		setCollectionMemberships(undefined);
		setCollectionMembershipsLoading(true);
		const [collectionsResult, membershipsResult] = await Promise.allSettled([
			api<PaperCollection[]>(`/api/library/collections?namespace=${encodeURIComponent(namespace)}`),
			api<CollectionMembershipIndex>(
				`/api/library/collection-memberships?namespace=${encodeURIComponent(namespace)}`,
			),
		]);
		if (collectionsResult.status === "fulfilled") setCollections(collectionsResult.value);
		else
			setError(
				collectionsResult.reason instanceof Error
					? collectionsResult.reason.message
					: String(collectionsResult.reason),
			);
		if (membershipsResult.status === "fulfilled") setCollectionMemberships(membershipsResult.value);
		else
			setError(
				membershipsResult.reason instanceof Error
					? membershipsResult.reason.message
					: String(membershipsResult.reason),
			);
		setCollectionMembershipsLoading(false);
	}, [namespace]);
	useEffect(() => {
		void loadCollectionData();
	}, [loadCollectionData]);
	useEffect(() => {
		let cancelled = false;
		void api<{ byPaperId: Record<string, ResearchNoteSummary[]> }>(
			`/api/research/note-index?namespace=${encodeURIComponent(namespace)}`,
		)
			.then((value) => {
				if (!cancelled) setNoteIndex(value.byPaperId);
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => {
			cancelled = true;
		};
	}, [namespace]);
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
	const openArtifactFolder = async () => {
		if (!details?.paper?.id || artifactFolderOpening) return;
		setArtifactFolderOpening(true);
		setError("");
		try {
			await api(
				`/api/papers/${encodeURIComponent(details.paper.id)}/artifacts/open?namespace=${encodeURIComponent(namespace)}`,
				{ method: "POST" },
			);
			setMessage("已打开 Artifact 文件夹。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setArtifactFolderOpening(false);
		}
	};
	const loadZotero = async () => {
		setImportMenuOpen(false);
		setActiveLibraryTool(undefined);
		setZoteroImportOpen(true);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroCollections([]);
		setZoteroItems([]);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		setZoteroBusy(true);
		setError("");
		try {
			const status = await api<ZoteroStatus>("/api/zotero/status");
			setZoteroStatus(status);
			if (!status.localApiEnabled) return;
			const [nextCollections, nextItems] = await Promise.all([
				api<ZoteroCollectionEntry[]>("/api/zotero/collections"),
				api<ZoteroLibraryItem[]>("/api/zotero/items"),
			]);
			setZoteroCollections(nextCollections);
			setZoteroItems(nextItems);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	const closeZoteroImport = async () => {
		const operationId = zoteroImportPrepared?.operation.operationId;
		setZoteroImportOpen(false);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		if (operationId) {
			await api(`/api/zotero/imports/${encodeURIComponent(operationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
	};
	const prepareZoteroImport = async (itemKeys = [...zoteroItemKeys]) => {
		setZoteroBusy(true);
		setError("");
		try {
			if (zoteroImportFinished && zoteroImportPrepared) {
				await api(`/api/zotero/imports/${encodeURIComponent(zoteroImportPrepared.operation.operationId)}`, {
					method: "DELETE",
				}).catch(() => undefined);
			}
			setZoteroImportFinished(false);
			const prepared = await api<ZoteroImportPreparation>(
				"/api/zotero/imports/prepare",
				jsonBody({
					namespace,
					collectionKeys: [],
					itemKeys,
					includeSubcollections: false,
				}),
			);
			setZoteroImportPrepared(prepared);
			setZoteroImportFinished(prepared.acceptedCount === 0);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	const executeZoteroImport = async () => {
		if (!zoteroImportPrepared) return;
		const prepared = zoteroImportPrepared;
		const executableItems = prepared.items.filter((item) => item.action !== "conflict" && item.action !== "skip");
		setZoteroBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(prepared.operation)) as ConfirmationGrant;
			const failures: Record<string, string> = {};
			let importedCount = 0;
			let existingCount = 0;
			setZoteroImportProgress({ completed: 0, total: executableItems.length });
			for (const [index, item] of executableItems.entries()) {
				try {
					const result = await api<ZoteroImportResult>(
						`/api/zotero/imports/${encodeURIComponent(prepared.operation.operationId)}/items/${encodeURIComponent(item.itemKey)}`,
						jsonBody({ grant }),
					);
					if (result.failed.length) {
						failures[item.itemKey] = result.failed[0].error;
					} else {
						importedCount += result.outcomes.filter((outcome) => outcome.status !== "unchanged").length;
						existingCount += result.outcomes.filter((outcome) => outcome.status === "unchanged").length;
						setZoteroImportPrepared((current) =>
							current
								? { ...current, items: current.items.filter((entry) => entry.itemKey !== item.itemKey) }
								: current,
						);
					}
				} catch (reason) {
					failures[item.itemKey] = reason instanceof Error ? reason.message : String(reason);
				}
				setZoteroImportProgress({ completed: index + 1, total: executableItems.length });
			}
			await Promise.all([load(), loadCollectionData()]);
			const unresolvedItems = missingMetadataZoteroItems(prepared.items);
			if (unresolvedItems.length) {
				setZoteroImportPrepared({ ...prepared, items: unresolvedItems, acceptedCount: 0 });
				setZoteroImportFinished(true);
				setMessage(
					`已保存 ${importedCount} 篇，已存在 ${existingCount} 篇；${unresolvedItems.length} 篇缺失信息。`,
				);
			} else {
				await closeZoteroImport();
				setMessage(`已保存 ${importedCount} 篇，个人库已存在 ${existingCount} 篇。`);
			}
			if (Object.keys(failures).length) {
				const details = Object.values(failures).slice(0, 2).join("；");
				setError(`${Object.keys(failures).length} 篇因执行错误未保存：${details}`);
			}
		} catch (reason) {
			await closeZoteroImport();
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroImportProgress(undefined);
			setZoteroBusy(false);
		}
	};
	const refreshZoteroStatus = async () => {
		try {
			setZoteroStatus(await api<ZoteroStatus>("/api/zotero/status"));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const authorizeZotero = async () => {
		setZoteroBusy(true);
		setError("");
		try {
			setZoteroStatus(await api<ZoteroStatus>("/api/zotero/authorize", { method: "POST" }));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	useEffect(() => {
		if (zoteroNamespaceRef.current === namespace) return;
		zoteroNamespaceRef.current = namespace;
		const importOperationId = zoteroImportOperationIdRef.current;
		const exportOperationId = zoteroExportOperationIdRef.current;
		setZoteroImportOpen(false);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		setZoteroExportPrepared(undefined);
		if (exportOperationId) {
			setExportPending(undefined);
			setExportPayload(undefined);
		}
		if (importOperationId) {
			void api(`/api/zotero/imports/${encodeURIComponent(importOperationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
		if (exportOperationId) {
			void api(`/api/zotero/exports/${encodeURIComponent(exportOperationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
	}, [namespace]);
	const prepareDownload = async () => {
		setActiveLibraryTool(undefined);
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
			setActiveLibraryTool(undefined);
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
			setActiveLibraryTool(undefined);
			setSelected(new Set());
			setDetails(undefined);
			setAnnotationTags("");
			setAnnotationNote("");
			setScreeningStatus("unreviewed");
			setScreeningReason("");
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareExport = async () => {
		if (!selected.size) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			if (exportFormat === "zotero") {
				const prepared = await api<ZoteroExportPreparation>(
					"/api/zotero/exports/prepare",
					jsonBody({ paperIds: [...selected], namespace }),
				);
				setZoteroExportPrepared(prepared);
				setExportPayload({ zotero: true, operationId: prepared.operation.operationId });
				setExportPending(prepared.operation);
				setActiveLibraryTool(undefined);
				return;
			}
			const payload: Record<string, unknown> = {
				paperIds: [...selected],
				namespace,
				format: exportFormat,
				filename: exportFilename.trim() || undefined,
			};
			setExportPayload(payload);
			setExportPending(await api("/api/library/export/prepare", jsonBody(payload)));
			setActiveLibraryTool(undefined);
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
			if (exportPayload.zotero && typeof exportPayload.operationId === "string") {
				const result = await api<{
					created: number;
					updated: number;
					unchanged: number;
					failed: Array<{ paperId: string; error: string }>;
				}>(`/api/zotero/exports/${encodeURIComponent(exportPayload.operationId)}`, jsonBody({ grant }));
				if (result.created + result.updated + result.unchanged > 0) {
					setMessage(
						`Zotero 导出完成：新建 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}。`,
					);
				}
				if (result.failed.length > 0) {
					setError(
						`Zotero 导出失败：${result.failed.map((failure) => `${failure.paperId}：${failure.error}`).join("；")}`,
					);
				}
				setExportPending(undefined);
				setExportPayload(undefined);
				setZoteroExportPrepared(undefined);
				setActiveLibraryTool(undefined);
				return;
			}
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
			setActiveLibraryTool(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const hasAnnotationChanges = Boolean(
		annotationTags.trim() || annotationNote.trim() || screeningStatus !== "unreviewed",
	);
	const closeLibraryTool = () => {
		const currentTool = activeLibraryTool;
		setActiveLibraryTool(undefined);
		window.setTimeout(
			() => (currentTool === "curation" ? curationButtonRef.current : exportButtonRef.current)?.focus(),
			0,
		);
	};
	const chooseLocalPdf = (paper: PaperRecord) => {
		if (localUploadingPaperId) return;
		setError("");
		setMessage("");
		localPdfTargetRef.current = paper;
		localFileRef.current?.click();
	};
	async function handleAddLocalPdf(file: File) {
		const target = localPdfTargetRef.current;
		if (!target) return;
		setLocalUploadingPaperId(target.id);
		setError("");
		setMessage("");
		try {
			await api(`/api/papers/${encodeURIComponent(target.id)}/pdf?namespace=${encodeURIComponent(namespace)}`, {
				method: "POST",
				headers: { "content-type": "application/pdf" },
				body: file,
			});
			setMessage(`已将本地 PDF 关联到《${target.title}》。`);
			await load();
			if (details?.paper?.id === target.id) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "关联本地 PDF 失败");
		} finally {
			setLocalUploadingPaperId(undefined);
			localPdfTargetRef.current = undefined;
			if (localFileRef.current) localFileRef.current.value = "";
		}
	}
	async function handleLocalImportFiles(files: File[]) {
		setImportMenuOpen(false);
		setError("");
		setMessage("");
		setLocalImportIssues([]);
		if (files.length === 0) return;
		if (files.length > 20) {
			setError("一次最多导入 20 个 PDF 文件。");
			return;
		}
		const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
		if (totalBytes > 500 * 1024 * 1024) {
			setError("所选 PDF 总大小超过 500 MB。");
			return;
		}
		setLocalImportBusy(true);
		try {
			const collectionId = !["all", "__uncategorized__"].includes(activeCollection) ? activeCollection : undefined;
			const created = await api<LocalPdfImportBatchView>(
				"/api/library/local-imports",
				jsonBody({ namespace, collectionId }),
			);
			setLocalImportBatch(created);
			localImportBatchIdRef.current = created.id;
			const uploaded: LocalPdfImportFilePreview[] = [];
			const issues: LocalPdfImportIssue[] = [];
			for (const [index, file] of files.entries()) {
				setLocalImportProgress({ completed: index, total: files.length, filename: file.name });
				try {
					const preview = await api<LocalPdfImportFilePreview>(
						`/api/library/local-imports/${encodeURIComponent(created.id)}/files`,
						{
							method: "POST",
							headers: {
								"content-type": "application/pdf",
								"x-filename": encodeURIComponent(file.name),
							},
							body: file,
						},
					);
					uploaded.push(preview);
					setLocalImportBatch((current) => (current ? { ...current, files: [...uploaded] } : current));
				} catch (reason) {
					issues.push({
						filename: file.name,
						message: reason instanceof Error ? reason.message : String(reason),
					});
					setLocalImportIssues([...issues]);
				}
			}
			setLocalImportProgress({ completed: files.length, total: files.length, filename: "" });
			if (uploaded.length) {
				setLocalImportBatch(
					await api<LocalPdfImportBatchView>(
						`/api/library/local-imports/${encodeURIComponent(created.id)}/prepare`,
						{ method: "POST" },
					),
				);
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLocalImportBusy(false);
			setLocalImportProgress(undefined);
			if (localImportInputRef.current) localImportInputRef.current.value = "";
		}
	}

	async function executeLocalImport() {
		if (!localImportBatch?.operation) return;
		setLocalImportBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(localImportBatch.operation)) as ConfirmationGrant;
			const result = await api<{
				records: PaperRecord[];
				outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
			}>(`/api/library/local-imports/${encodeURIComponent(localImportBatch.id)}/execute`, jsonBody({ grant }));
			const created = result.outcomes.filter((outcome) => outcome.status === "created").length;
			const updated = result.outcomes.filter((outcome) => outcome.status === "updated").length;
			const unchanged = result.outcomes.filter((outcome) => outcome.status === "unchanged").length;
			setMessage(`已导入 ${result.records.length} 篇论文：新建 ${created}，更新 ${updated}，未变更 ${unchanged}。`);
			setLocalImportBatch(undefined);
			setLocalImportIssues([]);
			localImportBatchIdRef.current = undefined;
			await Promise.all([load(), loadCollectionData()]);
		} catch (reason) {
			setLocalImportBatch(undefined);
			setLocalImportIssues([]);
			localImportBatchIdRef.current = undefined;
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLocalImportBusy(false);
		}
	}
	async function addPapersToCollection(paperIds: string[], collectionId: string) {
		if (!paperIds.length) return;
		if (
			requiresWebOperationConfirmation("personal-corpus-write", confirmationSettings) &&
			!window.confirm(`将 ${paperIds.length} 篇论文添加到所选分类？`)
		)
			return;
		setBusy(true);
		setError("");
		try {
			await api(
				`/api/library/collections/${encodeURIComponent(collectionId)}/papers`,
				jsonBody({ paperIds, mode: "assign", namespace }, "PATCH"),
			);
			setMessage(paperIds.length === 1 ? "已添加到分类" : `已将 ${paperIds.length} 篇论文添加到分类`);
			await Promise.all([load(), loadCollectionData()]);
			const detailPaperId = details?.paper?.id;
			const target = detailPaperId ? papers.find((paper) => paper.id === detailPaperId) : undefined;
			if (detailPaperId && paperIds.includes(detailPaperId) && target) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function addPaperToCollection(paperId: string, collectionId: string) {
		await addPapersToCollection([paperId], collectionId);
	}
	async function movePaperToCollection(paperId: string, collectionId: string | null) {
		if (
			requiresWebOperationConfirmation("personal-collection-remove", confirmationSettings) &&
			!window.confirm(collectionId ? "移动后会替换这篇论文当前的分类归属。" : "将这篇论文移出当前分类？")
		)
			return;
		setBusy(true);
		setError("");
		try {
			const next = collectionId ? [collectionId] : [];
			await api(
				`/api/papers/${encodeURIComponent(paperId)}/collections`,
				jsonBody({ collectionIds: next, namespace }, "PATCH"),
			);
			setMessage(collectionId ? "已移动到分类" : "已移出分类(未分类)");
			await Promise.all([load(), loadCollectionData()]);
			const target = papers.find((paper) => paper.id === paperId);
			if (details?.paper?.id === paperId && target) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function preparePaperRemoval(target: PaperRecord | string[]) {
		if (Array.isArray(target) && !target.length) return;
		setActiveLibraryTool(undefined);
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const payload = Array.isArray(target)
				? { paperIds: target, namespace }
				: {
						paperId: target.id,
						namespace,
						...(activeCollection !== "all" && activeCollection !== "__uncategorized__"
							? { collectionId: activeCollection }
							: {}),
					};
			setRemovalPayload(payload);
			setRemovalPending(await api<PreparedOperation>("/api/library/papers/remove/prepare", jsonBody(payload)));
		} catch (reason) {
			setRemovalPayload(undefined);
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function executePaperRemoval() {
		if (!removalPending || !removalPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(removalPending)) as ConfirmationGrant;
			const result = await api<{ mode: string; deleted?: string[]; removedFromCollection?: string[] }>(
				"/api/library/papers/remove/execute",
				jsonBody({ ...removalPayload, grant }),
			);
			const paperIds = Array.isArray(removalPayload.paperIds)
				? removalPayload.paperIds.filter((id): id is string => typeof id === "string")
				: typeof removalPayload.paperId === "string"
					? [removalPayload.paperId]
					: [];
			setSelected((current) => {
				const next = new Set(current);
				for (const paperId of paperIds) next.delete(paperId);
				return next;
			});
			if (paperIds.includes(details?.paper?.id)) setDetails(undefined);
			setMessage(
				result.mode === "remove-from-collection"
					? `已从当前分类中移除 ${result.removedFromCollection?.length ?? paperIds.length} 篇论文。`
					: `已删除 ${result.deleted?.length ?? paperIds.length} 篇论文及其本地 PDF、Artifact、派生数据和笔记关联。`,
			);
			setRemovalPending(undefined);
			setRemovalPayload(undefined);
			await Promise.all([load(), loadCollectionData()]);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	const otherLibraryActionLocked = busy || Boolean(pending || annotationPending || exportPending || removalPending);
	const libraryActionLocked =
		otherLibraryActionLocked || localImportBusy || Boolean(localImportBatch) || zoteroBusy || zoteroImportOpen;
	const membershipPaperIds = {
		all: collectionMemberships?.allPaperIds ?? [],
		__uncategorized__: collectionMemberships?.uncategorizedPaperIds ?? [],
		...(collectionMemberships?.collectionPaperIds ?? {}),
	};
	const toggleCollectionSelection = (paperIds: string[], checked: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			for (const paperId of paperIds) checked ? next.add(paperId) : next.delete(paperId);
			return next;
		});
	};
	const toggleZoteroItemSelection = (itemKeys: string[], checked: boolean) => {
		setZoteroItemKeys((current) => {
			const next = new Set(current);
			for (const itemKey of itemKeys) checked ? next.add(itemKey) : next.delete(itemKey);
			return next;
		});
	};
	const localImportConfirmation = useAutomaticOperationConfirmation(
		localImportBatch?.operation,
		localImportBusy,
		executeLocalImport,
	);
	const zoteroImportConfirmation = useAutomaticOperationConfirmation(
		zoteroImportPrepared?.operation,
		zoteroBusy,
		executeZoteroImport,
	);
	const selectCollection = (collectionId: string) => {
		if (localImportBusy) {
			setError("请等待当前 PDF 解析完成后再切换分类。");
			return;
		}
		if (localImportBatch) void cancelLocalImport(false);
		setActiveCollection(collectionId);
	};
	const libraryToolbar = (
		<div className="library-main-sticky-head">
			<div className="library-action-toolbar">
				<div className="library-import-menu-wrap" ref={importMenuRef}>
					<button
						ref={importButtonRef}
						className={`button secondary library-import-trigger${importMenuOpen ? " active" : ""}`}
						type="button"
						disabled={
							otherLibraryActionLocked ||
							localImportBusy ||
							Boolean(localImportBatch) ||
							zoteroBusy ||
							zoteroImportOpen
						}
						aria-haspopup="menu"
						aria-expanded={importMenuOpen}
						onClick={() => setImportMenuOpen((current) => !current)}
					>
						<span aria-hidden="true">+</span> 导入
					</button>
					{importMenuOpen && (
						<div className="library-import-menu" role="menu">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setImportMenuOpen(false);
									localImportInputRef.current?.click();
								}}
							>
								本地文件导入
							</button>
							<button type="button" role="menuitem" onClick={() => void loadZotero()}>
								从 Zotero 导入
							</button>
						</div>
					)}
				</div>
				<button
					className="button primary"
					type="button"
					disabled={!selected.size || libraryActionLocked}
					onClick={() => void prepareDownload()}
				>
					下载所选 PDF
				</button>
				<button
					ref={curationButtonRef}
					className={`button secondary library-tool-trigger${activeLibraryTool === "curation" ? " active" : ""}`}
					type="button"
					disabled={!selected.size || libraryActionLocked}
					aria-expanded={activeLibraryTool === "curation"}
					aria-controls="library-curation-tool"
					onClick={() => setActiveLibraryTool((current) => (current === "curation" ? undefined : "curation"))}
				>
					批量整理
				</button>
				<button
					ref={exportButtonRef}
					className={`button secondary library-tool-trigger${activeLibraryTool === "export" ? " active" : ""}`}
					type="button"
					disabled={!selected.size || libraryActionLocked}
					aria-expanded={activeLibraryTool === "export"}
					aria-controls="library-export-tool"
					onClick={() => setActiveLibraryTool((current) => (current === "export" ? undefined : "export"))}
				>
					导出
				</button>
				<button
					className="button danger"
					type="button"
					disabled={!selected.size || libraryActionLocked}
					onClick={() => void preparePaperRemoval([...selected])}
				>
					删除
				</button>
			</div>
		</div>
	);
	const librarySearch = (
		<div className="library-toolbar library-local-search">
			<label className="library-search-control">
				<span>⌕</span>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索标题、作者、摘要、标签或笔记"
				/>
			</label>
			<label className="library-namespace-control">
				<span>Namespace</span>
				<select
					value={namespace}
					disabled={localImportBusy}
					onChange={(event) => {
						if (localImportBatch) void cancelLocalImport(false);
						setNamespace(event.target.value);
						setActiveCollection("all");
					}}
				>
					{namespaces.map((item) => (
						<option value={item} key={item}>
							{item}
						</option>
					))}
				</select>
			</label>
			<label className="library-screening-control">
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
	);
	return (
		<div className="library-page-layout">
			<CollectionSidebar
				collections={collections}
				activeCollection={activeCollection}
				namespace={namespace}
				membershipPaperIds={membershipPaperIds}
				membershipLoading={collectionMembershipsLoading}
				selectedPaperIds={selected}
				onSelect={selectCollection}
				onToggleSelection={toggleCollectionSelection}
				onCreated={(collection) => {
					setCollections((current) =>
						current.some((item) => item.id === collection.id) ? current : [...current, collection],
					);
					setCollectionMemberships((current) =>
						current
							? {
									...current,
									collectionPaperIds: { ...current.collectionPaperIds, [collection.id]: [] },
								}
							: current,
					);
					setActiveCollection(collection.id);
				}}
				onDeleted={(ids) => {
					const deleted = new Set(ids);
					setCollections((current) => current.filter((item) => !deleted.has(item.id)));
					if (deleted.has(activeCollection)) setActiveCollection("all");
					void Promise.all([load(), loadCollectionData()]);
				}}
				onUpdated={(collection) =>
					setCollections((current) => current.map((item) => (item.id === collection.id ? collection : item)))
				}
				onAssignPapers={addPapersToCollection}
				onError={setError}
			/>
			<div className="library-page-main">
				{toolbarTarget ? createPortal(libraryToolbar, toolbarTarget) : libraryToolbar}
				{librarySearch}
				<input
					ref={localImportInputRef}
					type="file"
					accept="application/pdf,.pdf"
					multiple
					hidden
					onChange={(event) => void handleLocalImportFiles([...(event.target.files ?? [])])}
				/>
				<input
					ref={localFileRef}
					type="file"
					accept="application/pdf,.pdf"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleAddLocalPdf(file);
					}}
				/>
				{error && <div className="error-banner">{error}</div>}
				{message && <div className="success-banner">{message}</div>}
				{localImportBatch && (
					<section
						className="panel library-inline-tool library-import-panel"
						aria-labelledby="library-import-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-import-title">导入本地 PDF</h2>
								<span>
									{localImportBatch.collection
										? `目标分类：${localImportBatch.collection.name}`
										: `目标空间：${localImportBatch.namespace} · 未分类`}
								</span>
							</div>
							<button
								className="text-button"
								type="button"
								disabled={localImportBusy}
								onClick={() => void cancelLocalImport()}
							>
								关闭
							</button>
						</div>
						{localImportProgress && (
							<output className="library-import-progress">
								<div>
									<span>
										{localImportProgress.filename
											? `正在解析 ${localImportProgress.filename}`
											: "正在准备导入预览"}
									</span>
									<strong>
										{localImportProgress.completed}/{localImportProgress.total}
									</strong>
								</div>
								<div className="progress-track small">
									<span
										style={{
											width: `${Math.max(4, (localImportProgress.completed / localImportProgress.total) * 100)}%`,
										}}
									/>
								</div>
							</output>
						)}
						<ul className="library-import-list" aria-label="本地 PDF 导入预览">
							{localImportBatch.files.map((file) => (
								<li className={`library-import-row ${file.status}`} key={file.id}>
									<div className="library-import-row-main">
										<div className="library-import-row-title">
											<strong>{file.record?.title ?? file.filename}</strong>
											<span className={`library-import-state ${file.status}`}>
												{file.status === "needs_metadata"
													? "需要元数据"
													: file.action === "created"
														? "新建"
														: file.action === "updated"
															? "更新"
															: file.action === "unchanged"
																? "已存在"
																: "已解析"}
											</span>
										</div>
										{file.record ? (
											<p>{file.record.authors.join("、")}</p>
										) : (
											<p>缺少：{file.needsMetadata?.missingFields.join("、") ?? "标题或作者"}</p>
										)}
										<small>
											{file.filename} · {formatFileSize(file.bytes)}
											{file.metadataSource ? ` · ${file.metadataSource}` : ""}
										</small>
									</div>
									{file.warnings.filter((warning) => warning.stage === "provider").length > 0 && (
										<span className="library-import-warning">Provider 未完整补全</span>
									)}
								</li>
							))}
							{localImportIssues.map((issue) => (
								<li className="library-import-row rejected" key={`${issue.filename}-${issue.message}`}>
									<div className="library-import-row-main">
										<div className="library-import-row-title">
											<strong>{issue.filename}</strong>
											<span className="library-import-state rejected">无法导入</span>
										</div>
										<p>{issue.message}</p>
									</div>
								</li>
							))}
							{localImportBatch.files.length === 0 && localImportIssues.length === 0 && (
								<p className="library-import-empty">正在读取所选 PDF…</p>
							)}
						</ul>
						<div className="library-import-summary">
							<span>
								可导入 {localImportBatch.acceptedCount} 篇
								{localImportBatch.needsMetadataCount
									? ` · ${localImportBatch.needsMetadataCount} 篇缺少元数据`
									: ""}
								{localImportBatch.possibleDuplicates.length
									? ` · ${localImportBatch.possibleDuplicates.length} 个疑似重复项`
									: ""}
							</span>
							<div className="button-row">
								<button
									className="button secondary"
									type="button"
									disabled={localImportBusy}
									onClick={() => void cancelLocalImport()}
								>
									取消
								</button>
								{(localImportConfirmation.confirmationRequired ||
									localImportConfirmation.automaticAttemptFailed) && (
									<button
										className="button primary"
										type="button"
										disabled={
											localImportBusy || !localImportBatch.operation || localImportBatch.acceptedCount === 0
										}
										onClick={() => void executeLocalImport()}
									>
										{localImportBusy ? "正在处理…" : "确认并导入"}
									</button>
								)}
							</div>
						</div>
					</section>
				)}
				{zoteroImportOpen && (
					<section
						className="panel library-inline-tool zotero-transfer-panel"
						aria-labelledby="zotero-import-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="zotero-import-title">从 Zotero 导入</h2>
								<span>{zoteroStatus?.message ?? "正在检查 Zotero…"}</span>
							</div>
							<button
								className="text-button"
								type="button"
								disabled={zoteroBusy}
								onClick={() => void closeZoteroImport()}
							>
								关闭
							</button>
						</div>
						{zoteroBusy && !zoteroImportPrepared ? (
							<LoadingBlock text="正在读取 Zotero 文库…" />
						) : !zoteroStatus?.localApiEnabled ? (
							<div className="zotero-connection-empty">
								<p>请在 Zotero 的“设置 → 高级”中启用“允许其他应用与 Zotero 通信”。</p>
								<button className="button secondary" type="button" onClick={() => void loadZotero()}>
									重新检测
								</button>
							</div>
						) : zoteroImportPrepared ? (
							<>
								<ul className="library-import-list" aria-label="Zotero 导入预览">
									{zoteroImportPrepared.items.map((item) => {
										const missingReason = zoteroMissingFields(item.missingFields);
										return (
											<li
												className={`library-import-row ${missingReason ? "failed" : item.action}`}
												key={item.itemKey}
											>
												<div className="library-import-row-main">
													<div className="library-import-row-title">
														<strong>{item.record?.title ?? item.itemKey}</strong>
														<span className={`library-import-state${missingReason ? " rejected" : ""}`}>
															{missingReason ? "无法导入" : zoteroActionLabel(item.action)}
														</span>
													</div>
													<p>
														{item.collectionPaths.map((path) => path.join(" / ")).join("；") || "未分类"}
													</p>
													<small>
														{[
															missingReason,
															item.pdf ? `PDF：${item.pdf.filename}` : undefined,
															item.conflict,
															...item.warnings,
														]
															.filter(Boolean)
															.join("；") || "仅导入元数据"}
													</small>
												</div>
											</li>
										);
									})}
								</ul>
								<div className="library-import-summary">
									<span>
										{zoteroImportProgress
											? `正在导入 ${zoteroImportProgress.completed}/${zoteroImportProgress.total}，成功后会从清单移除`
											: zoteroImportFinished
												? `还有 ${zoteroImportPrepared.items.length} 篇未导入`
												: `可导入 ${zoteroImportPrepared.acceptedCount} 篇，分类会保留完整祖先路径`}
									</span>
									<div className="button-row">
										<button
											className="button secondary"
											type="button"
											disabled={zoteroBusy}
											onClick={() => void closeZoteroImport()}
										>
											{zoteroImportFinished ? "关闭" : "取消"}
										</button>
										{!zoteroImportFinished &&
											(zoteroImportConfirmation.confirmationRequired ||
												zoteroImportConfirmation.automaticAttemptFailed) && (
												<button
													className="button primary"
													type="button"
													disabled={zoteroBusy}
													onClick={() => void executeZoteroImport()}
												>
													{zoteroBusy ? "正在导入…" : "确认并导入"}
												</button>
											)}
									</div>
								</div>
							</>
						) : (
							<>
								<div className="zotero-picker-grid">
									<div>
										<h3>分类</h3>
										<div className="zotero-picker-list zotero-collection-picker">
											{zoteroCollectionRows.map((row) => (
												<div
													className={`zotero-collection-row${activeZoteroCollection === row.key ? " is-active" : ""}`}
													key={row.key}
												>
													<ZoteroSelectionCheckbox
														label={row.label}
														itemKeys={row.itemKeys}
														selected={zoteroItemKeys}
														onToggle={toggleZoteroItemSelection}
													/>
													<button
														type="button"
														className="zotero-collection-name"
														style={{ paddingLeft: `${8 + Math.max(0, row.depth - 1) * 16}px` }}
														onClick={() => setActiveZoteroCollection(row.key)}
													>
														<span>{row.label}</span>
														<small>{row.itemKeys.length}</small>
													</button>
												</div>
											))}
										</div>
									</div>
									<div>
										<h3>论文</h3>
										<div className="zotero-picker-list">
											{visibleZoteroItems.map((item) => (
												<label className={!item.valid ? "is-disabled" : ""} key={item.key}>
													<input
														type="checkbox"
														disabled={!item.valid}
														checked={zoteroItemKeys.has(item.key)}
														onChange={(event) =>
															setZoteroItemKeys((current) => {
																const next = new Set(current);
																event.target.checked ? next.add(item.key) : next.delete(item.key);
																return next;
															})
														}
													/>
													<span>
														<strong>{item.title}</strong>
														<small>{item.authors.join("，") || "缺少作者"}</small>
													</span>
												</label>
											))}
											{visibleZoteroItems.length === 0 && (
												<p className="zotero-picker-empty">该分类暂无论文</p>
											)}
										</div>
									</div>
								</div>
								<div className="library-action-footer">
									<span>已选 {zoteroItemKeys.size} 篇论文</span>
									<button
										className="button primary"
										type="button"
										disabled={zoteroBusy || !zoteroItemKeys.size}
										onClick={() => void prepareZoteroImport()}
									>
										预览导入
									</button>
								</div>
							</>
						)}
					</section>
				)}
				{annotationPending ? (
					<ConsentCard
						operation={annotationPending}
						busy={busy}
						onCancel={() => {
							setAnnotationPending(undefined);
							setAnnotationPayload(undefined);
							setActiveLibraryTool("curation");
						}}
						onConfirm={executeAnnotation}
					/>
				) : exportPending ? (
					<>
						{zoteroExportPrepared && (
							<ul className="library-import-list" aria-label="Zotero 导出预览">
								{zoteroExportPrepared.items.map((item) => (
									<li className={`library-import-row ${item.action}`} key={item.paperId}>
										<div className="library-import-row-main">
											<div className="library-import-row-title">
												<strong>{item.title}</strong>
												<span className="library-import-state">{zoteroActionLabel(item.action)}</span>
											</div>
											<p>
												{item.collectionPaths.map((path) => path.join(" / ")).join("；") || "Zotero 根目录"}
											</p>
											<small>
												{[
													item.pdf ? `PDF：${item.pdf.filename}` : undefined,
													item.conflict,
													...item.warnings,
												]
													.filter(Boolean)
													.join("；") || "仅同步元数据"}
											</small>
										</div>
									</li>
								))}
							</ul>
						)}
						<ConsentCard
							operation={exportPending}
							busy={busy}
							onCancel={() => {
								if (zoteroExportPrepared) {
									void api(
										`/api/zotero/exports/${encodeURIComponent(zoteroExportPrepared.operation.operationId)}`,
										{ method: "DELETE" },
									).catch(() => undefined);
								}
								setExportPending(undefined);
								setExportPayload(undefined);
								setZoteroExportPrepared(undefined);
								setActiveLibraryTool("export");
							}}
							onConfirm={executeExport}
						/>
					</>
				) : activeLibraryTool === "curation" ? (
					<section
						id="library-curation-tool"
						ref={inlineToolRef}
						className="panel library-inline-tool"
						aria-labelledby="library-curation-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-curation-title">批量整理</h2>
								<span>{selected.size} 篇已选</span>
							</div>
							<button className="text-button" type="button" onClick={closeLibraryTool}>
								关闭
							</button>
						</div>
						<fieldset className="library-curation-form" disabled={busy}>
							<label>
								<span>标签</span>
								<input
									value={annotationTags}
									onChange={(event) => setAnnotationTags(event.target.value)}
									placeholder="多个标签用逗号分隔"
								/>
							</label>
							<label>
								<span>筛选状态</span>
								<select
									value={screeningStatus}
									onChange={(event) => {
										setScreeningStatus(event.target.value);
										if (event.target.value === "unreviewed") setScreeningReason("");
									}}
								>
									<option value="unreviewed">保持原状态</option>
									<option value="include">纳入</option>
									<option value="maybe">待定</option>
									<option value="exclude">排除</option>
								</select>
							</label>
							<label className="wide">
								<span>筛选理由</span>
								<input
									value={screeningReason}
									onChange={(event) => setScreeningReason(event.target.value)}
									disabled={screeningStatus === "unreviewed"}
									placeholder={screeningStatus === "unreviewed" ? "选择筛选状态后填写" : "可选"}
								/>
							</label>
							<label className="wide">
								<span>个人笔记</span>
								<textarea
									value={annotationNote}
									onChange={(event) => setAnnotationNote(event.target.value)}
									placeholder="仅保存在个人库"
									rows={3}
								/>
							</label>
						</fieldset>
						<div className="library-action-footer">
							<span>{hasAnnotationChanges ? "有待保存的整理内容" : "尚未填写整理内容"}</span>
							<button
								className="button primary"
								type="button"
								disabled={!selected.size || busy || !hasAnnotationChanges}
								onClick={() => void prepareAnnotation()}
							>
								预览整理
							</button>
						</div>
					</section>
				) : activeLibraryTool === "export" ? (
					<section
						id="library-export-tool"
						ref={inlineToolRef}
						className="panel library-inline-tool library-export-panel"
						aria-labelledby="library-export-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-export-title">导出所选论文</h2>
								<span>{selected.size} 篇已选</span>
							</div>
							<button className="text-button" type="button" onClick={closeLibraryTool}>
								关闭
							</button>
						</div>
						<div className="library-export-form">
							<label>
								<span>文件格式</span>
								<select
									value={exportFormat}
									onChange={(event) => {
										setExportFormat(event.target.value);
										if (event.target.value === "zotero") void refreshZoteroStatus();
									}}
								>
									<option value="markdown">Markdown 清单</option>
									<option value="csv">CSV 表格</option>
									<option value="bibtex">BibTeX 引用</option>
									<option value="json">JSON 完整元数据</option>
									<option value="zotero">Zotero</option>
								</select>
							</label>
							{exportFormat !== "zotero" && (
								<label>
									<span>文件名</span>
									<input
										value={exportFilename}
										onChange={(event) => setExportFilename(event.target.value)}
										placeholder="使用默认文件名"
									/>
								</label>
							)}
						</div>
						{exportFormat === "zotero" && (
							<div className="zotero-export-status">
								<div>
									<strong>{zoteroStatus?.message ?? "尚未检测 Zotero"}</strong>
									<span>将复制 {selected.size} 篇论文的元数据、完整分类路径、标签和首选 PDF。</span>
								</div>
								{zoteroStatus?.localApiEnabled && !zoteroStatus.writeAuthorized ? (
									<button
										className="button secondary"
										type="button"
										disabled={zoteroBusy}
										onClick={() => void authorizeZotero()}
									>
										授权写入
									</button>
								) : (
									<button
										className="text-button"
										type="button"
										disabled={zoteroBusy}
										onClick={() => void refreshZoteroStatus()}
									>
										重新检测
									</button>
								)}
							</div>
						)}
						<button
							className="button secondary library-export-button"
							type="button"
							disabled={
								busy ||
								zoteroBusy ||
								!selected.size ||
								(exportFormat === "zotero" && !zoteroStatus?.writeAuthorized)
							}
							onClick={() => void prepareExport()}
						>
							预览导出
						</button>
					</section>
				) : null}
				{pending && (
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => setPending(undefined)}
						onConfirm={executeDownload}
					/>
				)}
				{removalPending && (
					<div className={`library-removal-consent${removalCardCollapsed ? " is-collapsed" : ""}`}>
						<ConsentCard
							operation={removalPending}
							busy={busy}
							onCancel={() => {
								setRemovalPending(undefined);
								setRemovalPayload(undefined);
							}}
							onConfirm={executePaperRemoval}
						/>
					</div>
				)}
				<div className="library-layout">
					<div
						className="library-paper-pane"
						onScroll={(event) => {
							if (!removalPending) return;
							const collapsed = event.currentTarget.scrollTop > 8;
							setRemovalCardCollapsed((current) => (current === collapsed ? current : collapsed));
						}}
					>
						{loading ? (
							<LoadingBlock />
						) : papers.length ? (
							<div className="paper-list">
								{papers.map((paper) => (
									<div key={paper.id} className="library-record">
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
											collections={collections}
											onAddToCollection={(paperId, collectionId) =>
												void addPaperToCollection(paperId, collectionId)
											}
											onMoveToCollection={(paperId, collectionId) =>
												void movePaperToCollection(paperId, collectionId)
											}
											onLoadLocalPdf={chooseLocalPdf}
											localPdfUploading={localUploadingPaperId === paper.id}
											localPdfBusy={Boolean(localUploadingPaperId)}
											onDelete={(selectedPaper) => void preparePaperRemoval(selectedPaper)}
											deleteLabel="删除"
											deleteBusy={libraryActionLocked}
											researchNotes={noteIndex[paper.id] ?? []}
											onOpenResearchNote={(noteId) => onOpenResearchNote({ namespace, noteId })}
											onCreateResearchNote={() => onOpenResearchNote({ namespace, paperId: paper.id })}
											dragPaperIds={
												libraryActionLocked
													? undefined
													: selected.has(paper.id)
														? [...selected]
														: [paper.id]
											}
										/>
									</div>
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
									{details.artifact?.available && (
										<button
											type="button"
											title="在文件管理器中打开 Artifact 文件夹"
											disabled={artifactFolderOpening}
											onClick={() => void openArtifactFolder()}
										>
											<span>Artifact</span>
											<strong>{details.artifact.count}</strong>
											<small>{artifactFolderOpening ? "正在打开" : "打开文件夹"}</small>
										</button>
									)}
									<MineruControl
										source={details.versions.length ? { paperId: details.paper.id, namespace } : undefined}
										compact
									/>
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
													paperId: details.paper.id,
													namespace,
													sha256: version.sha256,
													bytes: version.bytes,
													retrievedAt: version.retrievedAt,
													versionKind: version.versionKind,
													versionLabel: version.versionLabel,
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
			</div>
		</div>
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
				eyebrow="Background work"
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
	const [availablePdfs, setAvailablePdfs] = useState<
		Array<{
			paperId: string;
			title: string;
			sha256: string;
			blobPath: string;
			sourceUrl?: string;
			hasPdf: boolean;
		}>
	>([]);
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
	useEffect(() => {
		void api<{ pdfs: typeof availablePdfs }>("/api/library/pdfs")
			.then((value) => setAvailablePdfs(value.pdfs))
			.catch(() => setAvailablePdfs([]));
	}, []);
	const [pdfPickerOpen, setPdfPickerOpen] = useState(false);
	const pdfPickerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (pdfPickerRef.current && !pdfPickerRef.current.contains(event.target as Node)) setPdfPickerOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, []);
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
	const resolvePdfValue = useCallback(
		(value: string): { pdfPath: string; pdf?: (typeof availablePdfs)[number] } => {
			const trimmed = value.trim();
			if (!trimmed) return { pdfPath: "" };
			const byPath = availablePdfs.find((pdf) => pdf.hasPdf && pdf.blobPath === trimmed);
			if (byPath) return { pdfPath: byPath.blobPath, pdf: byPath };
			const byTitle = availablePdfs.find((pdf) => pdf.title === trimmed);
			if (byTitle) return { pdfPath: byTitle.hasPdf ? byTitle.blobPath : "", pdf: byTitle };
			const byId = availablePdfs.find((pdf) => pdf.paperId === trimmed);
			if (byId) return { pdfPath: byId.hasPdf ? byId.blobPath : "", pdf: byId };
			return { pdfPath: trimmed };
		},
		[availablePdfs],
	);

	const resolvePdfHint = useCallback(
		(value: string): string => {
			const { pdfPath, pdf } = resolvePdfValue(value);
			if (pdf && !pdf.hasPdf) return "该论文尚未下载 PDF，请先到个人库下载后再分析。";
			if (pdf && pdfPath) return `将使用个人库 PDF：${pdf.paperId}`;
			if (pdfPath) return "将作为本地路径直接使用。";
			return "";
		},
		[resolvePdfValue],
	);

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
			const resolved = resolvePdfValue(path);
			if (!resolved.pdfPath) {
				setError(resolved.pdf ? "该论文尚未下载 PDF，请先到个人库下载后再分析。" : "请输入本地 PDF 路径或选择论文");
				return;
			}
			const created = await api<BackgroundJob>(
				kind === "analysis" ? "/api/pdf/analyze" : "/api/artifacts/discover",
				jsonBody(kind === "analysis" ? { pdfPath: resolved.pdfPath, refine: true } : { pdfPath: resolved.pdfPath }),
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
					<span>本地 PDF 路径（可直接输入，或从个人库选择论文）</span>
					<div className="pdf-combobox" ref={pdfPickerRef}>
						<input
							value={path}
							onChange={(event) => setPath(event.target.value)}
							onFocus={() => setPdfPickerOpen(true)}
							placeholder="输入路径，或点击选择已入库论文…"
						/>
						{pdfPickerOpen && availablePdfs.length > 0 && (
							<ul className="pdf-combobox-list">
								{availablePdfs.map((pdf) => (
									<li key={pdf.paperId}>
										<button
											type="button"
											className="pdf-combobox-option"
											title={pdf.title}
											onClick={() => {
												setPath(pdf.hasPdf ? pdf.blobPath : "");
												setError(pdf.hasPdf ? "" : "该论文尚未下载 PDF，请先到个人库下载后再分析。");
												setPdfPickerOpen(false);
											}}
										>
											<span className="pdf-combobox-title">{pdf.title}</span>
											<span className="pdf-combobox-meta">
												{pdf.hasPdf ? "已下载" : "未下载PDF"} · {pdf.paperId}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					{path && <small className="path-resolved-hint">{resolvePdfHint(path)}</small>}
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
					onConfirm={executeAcquire}
				/>
			)}
			{correctionPending && (
				<ConsentCard
					operation={correctionPending}
					busy={busy}
					onCancel={() => setCorrectionPending(undefined)}
					onConfirm={executeCorrection}
				/>
			)}
			{teamPending && (
				<ConsentCard
					operation={teamPending}
					busy={busy}
					onCancel={() => setTeamPending(undefined)}
					onConfirm={executeTeamManifest}
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

function ReaderPage({ reader, onBack }: { reader: ReaderState; onBack: () => void }) {
	const restored = useRef(restoredReaderTabs(reader));
	const [activeReader, setActiveReader] = useState(reader);
	const [versions, setVersions] = useState<PaperVersionView[]>([]);
	const [paper, setPaper] = useState<PaperRecord>();
	const [linkedNotes, setLinkedNotes] = useState<ResearchNoteSummary[]>([]);
	const [tabs, setTabs] = useState<ReaderWorkspaceTab[]>(restored.current.tabs);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(restored.current.activeId);
	const [railMenu, setRailMenu] = useState<"notes" | "versions">();
	const [mobilePane, setMobilePane] = useState<"pdf" | "workspace">("pdf");
	const [readerWorkspaceWidth, setReaderWorkspaceWidth] = useState(() => {
		const saved = Number(window.localStorage.getItem("paper-agent-reader-pane-width"));
		return Number.isFinite(saved) && saved >= 320 ? saved : 420;
	});
	const [folderOpening, setFolderOpening] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const readerLayoutRef = useRef<HTMLDivElement>(null);
	const railRef = useRef<HTMLElement>(null);
	const workspaceOpen = tabs.length > 0;

	const resizeReaderPane = useCallback((clientX: number) => {
		const bounds = readerLayoutRef.current?.getBoundingClientRect();
		if (!bounds) return;
		const maximum = Math.max(320, Math.min(720, bounds.width - 468));
		setReaderWorkspaceWidth(Math.max(320, Math.min(maximum, bounds.right - 46 - clientX)));
	}, []);
	const startReaderResize = useCallback(
		(event: React.PointerEvent<HTMLHRElement>) => {
			event.preventDefault();
			document.body.classList.add("paper-reader-resizing");
			const onMove = (move: PointerEvent) => resizeReaderPane(move.clientX);
			const onUp = (up: PointerEvent) => {
				resizeReaderPane(up.clientX);
				document.body.classList.remove("paper-reader-resizing");
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				const bounds = readerLayoutRef.current?.getBoundingClientRect();
				if (bounds) {
					const maximum = Math.max(320, Math.min(720, bounds.width - 468));
					const width = Math.max(320, Math.min(maximum, bounds.right - 46 - up.clientX));
					window.localStorage.setItem("paper-agent-reader-pane-width", String(Math.round(width)));
				}
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		},
		[resizeReaderPane],
	);
	useEffect(() => () => document.body.classList.remove("paper-reader-resizing"), []);

	const loadReaderData = useCallback(async () => {
		if (!reader.paperId || !reader.namespace) return;
		setError("");
		try {
			const [details, notes] = await Promise.all([
				api<ReaderPaperDetails>(
					`/api/papers/${encodeURIComponent(reader.paperId)}?namespace=${encodeURIComponent(reader.namespace)}`,
				),
				api<{ notes: ResearchNoteSummary[] }>(
					`/api/research/notes?namespace=${encodeURIComponent(reader.namespace)}&paperId=${encodeURIComponent(reader.paperId)}`,
				),
			]);
			setPaper(details.paper);
			setVersions(details.versions);
			setLinkedNotes(notes.notes);
			setTabs((current) => {
				const linked = new Map(notes.notes.map((note) => [note.id, note]));
				return current
					.filter((tab) => tab.kind !== "note" || linked.has(tab.noteId))
					.map((tab) =>
						tab.kind === "note" ? { ...tab, title: linked.get(tab.noteId)?.title ?? tab.title } : tab,
					);
			});
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [reader.namespace, reader.paperId]);

	useEffect(() => {
		setActiveReader(reader);
		void loadReaderData();
	}, [loadReaderData, reader]);

	useEffect(() => {
		if (!tabs.some((tab) => tab.id === activeTabId)) setActiveTabId(tabs[0]?.id);
		if (!tabs.length) setMobilePane("pdf");
	}, [activeTabId, tabs]);

	useEffect(() => {
		const key = readerTabsStorageKey(reader);
		if (!key) return;
		const persistedTabs = tabs.filter((tab) => tab.kind !== "new-note");
		const persistedActive = persistedTabs.some((tab) => tab.id === activeTabId) ? activeTabId : persistedTabs[0]?.id;
		window.localStorage.setItem(key, JSON.stringify({ tabs: persistedTabs, activeId: persistedActive }));
	}, [activeTabId, reader, tabs]);

	useEffect(() => {
		if (!railMenu) return;
		const close = (event: PointerEvent) => {
			if (!railRef.current?.contains(event.target as Node)) setRailMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRailMenu(undefined);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [railMenu]);

	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(() => setMessage(""), 4_000);
		return () => window.clearTimeout(timer);
	}, [message]);
	useEffect(() => {
		if (!error) return;
		const timer = window.setTimeout(() => setError(""), 7_000);
		return () => window.clearTimeout(timer);
	}, [error]);

	const activateTab = (id: string) => {
		setActiveTabId(id);
		setMobilePane("workspace");
		setRailMenu(undefined);
	};

	const openAgent = () => {
		setTabs((current) =>
			current.some((tab) => tab.id === "agent")
				? current
				: [{ id: "agent", kind: "agent", title: "AI 对话" }, ...current],
		);
		activateTab("agent");
	};

	const openNote = (note: ResearchNoteSummary) => {
		const id = `note:${note.id}`;
		setTabs((current) =>
			current.some((tab) => tab.id === id)
				? current
				: [...current, { id, kind: "note", noteId: note.id, title: note.title }],
		);
		activateTab(id);
	};

	const openNewNote = () => {
		setTabs((current) =>
			current.some((tab) => tab.id === "new-note")
				? current
				: [...current, { id: "new-note", kind: "new-note", title: "新建笔记" }],
		);
		activateTab("new-note");
	};

	const closeTab = (id: string) => {
		setTabs((current) => {
			const index = current.findIndex((tab) => tab.id === id);
			const next = current.filter((tab) => tab.id !== id);
			if (activeTabId === id) setActiveTabId(next[Math.min(index, next.length - 1)]?.id);
			return next;
		});
	};

	const updateNote = (note: ResearchNote) => {
		setLinkedNotes((current) => current.map((item) => (item.id === note.id ? note : item)));
		setTabs((current) =>
			current.map((tab) => (tab.kind === "note" && tab.noteId === note.id ? { ...tab, title: note.title } : tab)),
		);
	};

	const finishNoteCreation = (note: ResearchNote) => {
		const id = `note:${note.id}`;
		setLinkedNotes((current) => [...current.filter((item) => item.id !== note.id), note]);
		setTabs((current) => [
			...current.filter((tab) => tab.id !== "new-note" && tab.id !== id),
			{ id, kind: "note", noteId: note.id, title: note.title },
		]);
		setActiveTabId(id);
	};

	const selectVersion = (version: PaperVersionView) => {
		if (paper && reader.namespace) setActiveReader(readerVersionState(paper, reader.namespace, version));
		setRailMenu(undefined);
	};

	const openPdfFolder = async () => {
		if (!activeReader.paperId || !activeReader.sha256 || !activeReader.namespace || folderOpening) return;
		setFolderOpening(true);
		setError("");
		try {
			await api(
				`/api/papers/${encodeURIComponent(activeReader.paperId)}/pdf/${activeReader.sha256}/folder/open?namespace=${encodeURIComponent(activeReader.namespace)}`,
				{ method: "POST" },
			);
			setMessage("已打开当前 PDF 文件夹");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setFolderOpening(false);
		}
	};

	const paperContext =
		activeReader.paperId && activeReader.namespace && activeReader.pdfPath
			? {
					paperId: activeReader.paperId,
					namespace: activeReader.namespace,
					title: activeReader.title,
					pdfPath: activeReader.pdfPath,
					pdfSha256: activeReader.sha256,
				}
			: undefined;
	const readerVersionSummary = [
		activeReader.versionLabel,
		activeReader.retrievedAt ? new Date(activeReader.retrievedAt).toLocaleDateString() : undefined,
		activeReader.bytes ? formatFileSize(activeReader.bytes) : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<section className="paper-reader-workspace">
			<header className="paper-reader-toolbar">
				<button
					className="paper-reader-back"
					type="button"
					onClick={onBack}
					aria-label="返回个人库"
					title="返回个人库"
				>
					←
				</button>
				<div className="paper-reader-title">
					<strong>{activeReader.title}</strong>
					{readerVersionSummary && <span>{readerVersionSummary}</span>}
				</div>
				<div className="paper-reader-mobile-tabs" role="tablist" aria-label="阅读视图">
					<button
						type="button"
						role="tab"
						aria-selected={mobilePane === "pdf"}
						onClick={() => setMobilePane("pdf")}
					>
						PDF
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mobilePane === "workspace"}
						disabled={!workspaceOpen}
						onClick={() => setMobilePane("workspace")}
					>
						工作区
					</button>
				</div>
				<PdfTranslationControl
					key={`${activeReader.namespace ?? ""}:${activeReader.paperId ?? ""}:${activeReader.sha256 ?? ""}`}
					source={
						activeReader.paperId &&
						activeReader.namespace &&
						activeReader.sha256 &&
						activeReader.versionKind !== "translation"
							? {
									title: activeReader.title,
									paperId: activeReader.paperId,
									namespace: activeReader.namespace,
									sha256: activeReader.sha256,
								}
							: undefined
					}
					onOpenResult={(result) => {
						setActiveReader({
							...activeReader,
							url: `/api/papers/${encodeURIComponent(result.paperId)}/pdf/${result.version.sha256}?namespace=${encodeURIComponent(result.namespace)}`,
							pdfPath: result.version.blobPath,
							sha256: result.version.sha256,
							bytes: result.version.bytes,
							retrievedAt: result.version.retrievedAt,
							versionKind: result.version.versionKind,
							versionLabel: result.version.versionLabel,
						});
						void loadReaderData();
					}}
				/>
				<MineruControl
					source={
						activeReader.paperId && activeReader.namespace
							? { paperId: activeReader.paperId, namespace: activeReader.namespace }
							: undefined
					}
				/>
				<a className="paper-reader-open" href={activeReader.url} target="_blank" rel="noreferrer">
					在新标签页打开 ↗
				</a>
			</header>
			{error && (
				<div className="paper-reader-notice error" role="alert">
					<span>{error}</span>
					<button type="button" aria-label="关闭错误提示" onClick={() => setError("")}>
						<X size={14} />
					</button>
				</div>
			)}
			{message && (
				<div className="paper-reader-notice success">
					<span>{message}</span>
					<button type="button" aria-label="关闭提示" onClick={() => setMessage("")}>
						<X size={14} />
					</button>
				</div>
			)}
			<div
				className={`paper-reader-layout ${workspaceOpen ? "has-workspace" : "workspace-collapsed"} show-${mobilePane}`}
				ref={readerLayoutRef}
				style={{ "--paper-agent-pane-width": `${readerWorkspaceWidth}px` } as React.CSSProperties}
			>
				<div className="browser-pdf-shell">
					<BrowserPdfReader url={activeReader.url} title={activeReader.title} />
				</div>
				{workspaceOpen && (
					<>
						<hr
							className="paper-reader-divider"
							aria-label="调整 PDF 与工作区域宽度"
							aria-orientation="vertical"
							aria-valuemin={320}
							aria-valuemax={720}
							aria-valuenow={Math.round(readerWorkspaceWidth)}
							tabIndex={0}
							onPointerDown={startReaderResize}
							onKeyDown={(event) => {
								if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
								event.preventDefault();
								const delta = event.key === "ArrowLeft" ? 24 : -24;
								setReaderWorkspaceWidth((width) => {
									const next = Math.max(320, Math.min(720, width + delta));
									window.localStorage.setItem("paper-agent-reader-pane-width", String(next));
									return next;
								});
							}}
						/>
						<aside className="paper-reader-side-workspace" aria-label="论文工作区">
							<div className="reader-tab-strip" role="tablist" aria-label="工作区标签">
								{tabs.map((tab) => (
									<div className={`reader-tab${activeTabId === tab.id ? " active" : ""}`} key={tab.id}>
										<button
											type="button"
											role="tab"
											aria-selected={activeTabId === tab.id}
											onClick={() => activateTab(tab.id)}
										>
											{tab.kind === "agent" ? <Bot size={14} /> : <NotebookPen size={14} />}
											<span>{tab.title}</span>
										</button>
										<button
											type="button"
											className="reader-tab-close"
											aria-label={`关闭 ${tab.title}`}
											onClick={() => closeTab(tab.id)}
										>
											<X size={13} />
										</button>
									</div>
								))}
							</div>
							<div className="reader-tab-content">
								{tabs.some((tab) => tab.kind === "agent") && (
									<div className="reader-workspace-view" hidden={activeTabId !== "agent"}>
										<AgentPage embedded paperContext={paperContext} />
									</div>
								)}
								{tabs
									.filter((tab): tab is Extract<ReaderWorkspaceTab, { kind: "note" }> => tab.kind === "note")
									.map((tab) => (
										<div className="reader-workspace-view" hidden={activeTabId !== tab.id} key={tab.id}>
											<ReaderNotePanel
												namespace={reader.namespace ?? "default"}
												noteId={tab.noteId}
												onSaved={updateNote}
											/>
										</div>
									))}
								{tabs.some((tab) => tab.kind === "new-note") && reader.paperId && (
									<div className="reader-workspace-view" hidden={activeTabId !== "new-note"}>
										<ReaderNoteCreatePanel
											namespace={reader.namespace ?? "default"}
											paperId={reader.paperId}
											onCreated={finishNoteCreation}
											onCancel={() => closeTab("new-note")}
										/>
									</div>
								)}
							</div>
						</aside>
					</>
				)}
				<aside className="reader-tool-rail" aria-label="阅读工具" ref={railRef}>
					<button
						type="button"
						className={activeTabId === "agent" ? "active" : ""}
						onClick={openAgent}
						title="AI 对话"
						aria-label="AI 对话"
					>
						<Bot size={19} />
					</button>
					<button
						type="button"
						className={activeTabId?.startsWith("note:") || activeTabId === "new-note" ? "active" : ""}
						onClick={() => setRailMenu((current) => (current === "notes" ? undefined : "notes"))}
						title="笔记"
						aria-label="笔记"
					>
						<NotebookPen size={19} />
						{linkedNotes.length > 0 && <span className="reader-tool-count">{linkedNotes.length}</span>}
					</button>
					<button
						type="button"
						className={railMenu === "versions" ? "active" : ""}
						onClick={() => setRailMenu((current) => (current === "versions" ? undefined : "versions"))}
						title="PDF 版本"
						aria-label="PDF 版本"
					>
						<FileStack size={19} />
						{versions.length > 1 && <span className="reader-tool-count">{versions.length}</span>}
					</button>
					<button
						type="button"
						disabled={folderOpening || !activeReader.sha256}
						onClick={() => void openPdfFolder()}
						title="打开当前 PDF 文件夹"
						aria-label="打开当前 PDF 文件夹"
					>
						<FolderOpen size={19} />
					</button>
					{railMenu === "notes" && (
						<div className="reader-rail-popover reader-note-menu">
							<header>
								<strong>论文笔记</strong>
								<span>{linkedNotes.length} 篇</span>
							</header>
							<div className="reader-rail-list">
								{linkedNotes.map((note) => (
									<button type="button" key={note.id} onClick={() => openNote(note)}>
										<NotebookPen size={15} />
										<span>
											<strong>{note.title}</strong>
											<small>{new Date(note.updatedAt).toLocaleDateString()}</small>
										</span>
										{tabs.some((tab) => tab.kind === "note" && tab.noteId === note.id) && <Check size={15} />}
									</button>
								))}
								{!linkedNotes.length && <p>当前论文还没有关联笔记。</p>}
							</div>
							<button type="button" className="reader-rail-create" onClick={openNewNote}>
								<Plus size={15} />
								新建笔记
							</button>
						</div>
					)}
					{railMenu === "versions" && (
						<div className="reader-rail-popover reader-version-menu">
							<header>
								<strong>PDF 版本</strong>
								<span>{versions.length} 个</span>
							</header>
							<div className="reader-rail-list">
								{versions.map((version) => (
									<button
										type="button"
										key={version.sha256}
										className={version.sha256 === activeReader.sha256 ? "selected" : ""}
										onClick={() => selectVersion(version)}
									>
										<FileStack size={15} />
										<span>
											<strong>{readerVersionName(version)}</strong>
											<small>
												{new Date(version.retrievedAt).toLocaleDateString()} ·{" "}
												{formatFileSize(version.bytes)}
											</small>
										</span>
										{version.sha256 === activeReader.sha256 && <Check size={15} />}
									</button>
								))}
							</div>
						</div>
					)}
				</aside>
			</div>
		</section>
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
			if (typeof result.invite === "string") setOneTimeToken(result.invite);
			if (typeof result.backupPath === "string") setBackupPath(result.backupPath);
			setMessage(
				result.invite
					? "团队接入串仅显示这一次，请立即复制并交给对应成员。"
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
			setMessage("团队接入串已复制并从界面隐藏。");
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
							<span>在“设置与诊断”中粘贴管理员提供的 pateam1. 编码接入串并完成验证。</span>
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
					<strong>一次性团队接入串</strong>
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
					onConfirm={execute}
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
								<p className="muted">暂无已批准的团队派生记录。</p>
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
								placeholder="新成员名称"
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
									void prepare("/api/team/identities/prepare", "/api/team/identities/execute", {
										action: "create",
										name: identityName,
										roles: identityRoles,
										namespaces: identityRoles.includes("admin") ? [] : [overview.namespace],
									})
								}
							>
								创建成员
							</button>
						</div>
						<div className="identity-list">
							{overview.identities?.map((identity: any) => (
								<div key={identity.id}>
									<div>
										<strong>{identity.name}</strong>
										<small>
											{identity.roles.join(", ")}
											{identity.roles.includes("admin")
												? " · 所有空间"
												: ` · ${identity.namespaces?.join(", ") || "未授权空间"}`}
											{identity.revokedAt
												? ` · 已撤销 ${new Date(identity.revokedAt).toLocaleDateString()}`
												: ""}
										</small>
									</div>
									{identity.id !== overview.identity.id && !identity.revokedAt && (
										<button
											type="button"
											onClick={() =>
												void prepare("/api/team/identities/prepare", "/api/team/identities/execute", {
													action: "revoke",
													id: identity.id,
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
							<span>本地服务从受保护的团队接入文件读取凭据；GUI 只看到连接结果与角色。</span>
						</div>
					</section>
				)}
			</div>
		</>
	);
}

function configuredPdfTranslationModels(config: PaperAgentConfigView) {
	const options = new Map<string, { key: string; label: string }>();
	for (const model of [config.model, ...(config.models ?? [])]) {
		if (!model || model.api !== "openai-completions") continue;
		const key = `${model.providerId}/${model.modelId}`;
		options.set(key, { key, label: `${model.name ?? model.modelId} (${model.providerId})` });
	}
	return [...options.values()];
}

function SettingsPage({ onConfigurationSaved }: { onConfigurationSaved: () => Promise<void> }) {
	const [config, setConfig] = useState<PaperAgentConfigView>();
	const [pdfTranslationStatus, setPdfTranslationStatus] = useState<PdfTranslationEngineStatus>();
	const [teamAccess, setTeamAccess] = useState<TeamAccessStatus>();
	const [teamInvite, setTeamInvite] = useState("");
	const [teamNamespace, setTeamNamespace] = useState("");
	const [teamPending, setTeamPending] = useState<PreparedOperation>();
	const [teamBusy, setTeamBusy] = useState(false);
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingConfig, setPendingConfig] = useState<unknown>();
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [dirty, setDirty] = useState(false);
	const load = useCallback(async () => {
		const loaded = await api<PaperAgentConfigView>("/api/config");
		setConfig(loaded);
		void api<TeamAccessStatus>("/api/team/access")
			.then((status) => {
				setTeamAccess(status);
				setTeamNamespace(status.namespace ?? "");
			})
			.catch((reason) =>
				setTeamAccess({
					configured: true,
					connected: false,
					source: "access-file",
					reason: reason instanceof Error ? reason.message : String(reason),
				}),
			);
		void api<PdfTranslationEngineStatus>("/api/pdf-translations/status")
			.then(setPdfTranslationStatus)
			.catch((reason) =>
				setPdfTranslationStatus({
					available: false,
					engine: "pdf2zh-next",
					command: loaded.pdfTranslation.command || "pdf2zh_next",
					reason: reason instanceof Error ? reason.message : String(reason),
				}),
			);
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
	const serializable = () => {
		if (!config) return undefined;
		const next: any = structuredClone(config);
		delete next.path;
		if (next.model) delete next.model.credentialsAvailable;
		return next;
	};
	const prepareTeamAccess = async (input: Record<string, unknown>) => {
		setError("");
		setMessage("");
		try {
			setTeamPending(await api<PreparedOperation>("/api/team/access/prepare", jsonBody(input)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const executeTeamAccess = async () => {
		if (!teamPending) return;
		setTeamBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(teamPending)) as ConfirmationGrant;
			const result = await api<{ status: TeamAccessStatus }>("/api/team/access/execute", jsonBody({ grant }));
			setTeamAccess(result.status);
			setTeamNamespace(result.status.namespace ?? "");
			setTeamInvite("");
			setTeamPending(undefined);
			setMessage(result.status.connected ? "团队接入已保存并生效。" : "本地团队接入已清除。");
			await onConfigurationSaved();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setTeamBusy(false);
		}
	};
	const prepareSave = async () => {
		const candidate = serializable();
		if (!candidate) return;
		setError("");
		setMessage("");
		try {
			setPendingConfig(candidate);
			setPending(await api<PreparedOperation>("/api/config/prepare", jsonBody({ config: candidate })));
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
			const result = await api<{ restartRequired: boolean }>(
				"/api/config/execute",
				jsonBody({ config: pendingConfig, grant }),
			);
			setMessage(
				result.restartRequired
					? "设置已保存。存储路径或 namespace 已改变，请重启 Paper Agent。"
					: "设置已保存并立即生效。服务级选项会在下次启动时应用。",
			);
			setPending(undefined);
			setPendingConfig(undefined);
			await load();
			await onConfigurationSaved();
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
	const pdfTranslationModels = configuredPdfTranslationModels(config);
	const selectedPdfTranslationModel = config.pdfTranslation.modelKey ?? pdfTranslationModels[0]?.key ?? "";
	return (
		<>
			<PageHeading
				eyebrow="Environment"
				title="设置与诊断"
				description="管理本地工作区、操作确认、搜索与团队连接。"
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
					onConfirm={executePending}
				/>
			)}
			{teamPending && (
				<ConsentCard
					operation={teamPending}
					busy={teamBusy}
					onCancel={() => setTeamPending(undefined)}
					onConfirm={executeTeamAccess}
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
						<label className="wide">
							<span>外部命令目录</span>
							<input
								value={config.externalTools.commandDirectories.join(";")}
								placeholder="D:\\Tools\\poppler\\Library\\bin;D:\\Tools\\tesseract"
								onChange={(event) =>
									update((next) => {
										next.externalTools.commandDirectories = event.target.value
											.split(";")
											.map((path) => path.trim())
											.filter(Boolean);
									})
								}
							/>
							<small>多个目录用分号分隔。填写可执行文件所在目录，不填写具体 exe 文件。</small>
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
					<span className="eyebrow">Research Wiki</span>
					<h2>知识库与 Obsidian</h2>
					<div className="form-grid">
						<label className="wide">
							<span>Obsidian 路径</span>
							<input
								value={config.wiki.obsidianPath ?? ""}
								placeholder="D:\\Tools\\obsidian"
								onChange={(event) =>
									update((next) => {
										next.wiki.obsidianPath = event.target.value || undefined;
									})
								}
							/>
							<small>可填写 Obsidian 安装目录或可执行文件路径；Wiki 仓库仍保存在 Paper Agent 数据目录中。</small>
						</label>
					</div>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">PDF translation</span>
					<h2>PDF 翻译引擎</h2>
					<div className="form-grid">
						<label className="wide">
							<span>PDF2zh Next 命令</span>
							<input
								value={config.pdfTranslation.command ?? ""}
								placeholder="pdf2zh_next"
								onChange={(event) =>
									update((next) => {
										next.pdfTranslation.command = event.target.value || undefined;
									})
								}
							/>
							<small>可填写命令名或可执行文件的完整路径；留空时从 PATH 调用 pdf2zh_next。</small>
						</label>
					</div>
					{pdfTranslationStatus && (
						<p className={pdfTranslationStatus.available ? "form-hint" : "error-text"}>
							{pdfTranslationStatus.available ? "命令可用" : "命令不可用"}：
							<code>{pdfTranslationStatus.command}</code>
							{pdfTranslationStatus.version ? `（${pdfTranslationStatus.version}）` : ""}
							{!pdfTranslationStatus.available && pdfTranslationStatus.reason
								? `；${pdfTranslationStatus.reason}`
								: ""}
						</p>
					)}
					<div className="translation-engine-options" role="radiogroup" aria-label="PDF 翻译引擎">
						<label className={config.pdfTranslation.engine === "siliconflowfree" ? "active" : ""}>
							<input
								type="radio"
								name="pdf-translation-engine"
								value="siliconflowfree"
								checked={config.pdfTranslation.engine === "siliconflowfree"}
								onChange={() =>
									update((next) => {
										next.pdfTranslation.engine = "siliconflowfree";
									})
								}
							/>
							<strong>SiliconFlowFree</strong>
							<span>无需配置模型密钥</span>
						</label>
						<label className={config.pdfTranslation.engine === "active-model" ? "active" : ""}>
							<input
								type="radio"
								name="pdf-translation-engine"
								value="active-model"
								checked={config.pdfTranslation.engine === "active-model"}
								onChange={() =>
									update((next) => {
										next.pdfTranslation.engine = "active-model";
									})
								}
							/>
							<strong>Paper Agent 模型</strong>
							<span>使用下方指定模型的接口与密钥</span>
						</label>
					</div>
					{config.pdfTranslation.engine === "active-model" && (
						<div className="form-grid">
							<label className="wide">
								<span>PDF 翻译模型</span>
								<select
									value={selectedPdfTranslationModel}
									disabled={pdfTranslationModels.length === 0}
									onChange={(event) =>
										update((next) => {
											next.pdfTranslation.modelKey = event.target.value;
										})
									}
								>
									{pdfTranslationModels.length === 0 && <option value="">没有兼容的模型</option>}
									{pdfTranslationModels.map((model) => (
										<option key={model.key} value={model.key}>
											{model.label}
										</option>
									))}
								</select>
							</label>
						</div>
					)}
					<p className="form-hint">
						仅列出 PDF2zh Next 支持的 OpenAI Completions 兼容模型；切换只影响之后创建的翻译任务。
					</p>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">MinerU</span>
					<h2>论文解析材料</h2>
					<div className="form-grid two">
						<label className="wide">
							<span>API 地址</span>
							<input
								value={config.mineru.baseUrl}
								onChange={(event) =>
									update((next) => {
										next.mineru.baseUrl = event.target.value;
									})
								}
							/>
						</label>
						<label>
							<span>解析模型</span>
							<select
								value={config.mineru.modelVersion}
								onChange={(event) =>
									update((next) => {
										next.mineru.modelVersion = event.target.value as "pipeline" | "vlm";
									})
								}
							>
								<option value="vlm">VLM</option>
								<option value="pipeline">Pipeline</option>
							</select>
						</label>
						<label>
							<span>文档语言</span>
							<input
								value={config.mineru.language}
								onChange={(event) =>
									update((next) => {
										next.mineru.language = event.target.value;
									})
								}
							/>
						</label>
						<label className="wide">
							<span>MinerU API Key</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.mineruApiKey ?? ""}
								placeholder="在此填写 MinerU API Key"
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.mineruApiKey = event.target.value || undefined;
									})
								}
							/>
						</label>
					</div>
					<p className="form-hint">
						材料按需生成，并保存在论文 PDF 同级的 mineru 目录中。系统优先使用 unzip，缺少时回退到 tar。
					</p>
				</section>
				<section className="panel form-panel confirmation-settings-panel">
					<span className="eyebrow">Operation confirmation</span>
					<h2>操作确认</h2>
					<p className="muted">关闭后会自动授权并执行对应操作，manifest 指纹和一次性授权校验仍然保留。</p>
					<div className="confirmation-setting-list">
						{[
							{
								key: "requireAgentWriteConfirmation" as const,
								label: "Agent 普通写入前询问",
								description: "保存论文、导入、整理、创建或调整分类以及 Zotero 传输。",
							},
							{
								key: "requirePersonalLibraryWriteConfirmation" as const,
								label: "个人库普通操作前询问",
								description: "Web 保存、导入、整理、导出以及 Zotero 传输。",
							},
							{
								key: "requirePersonalLibraryDeleteConfirmation" as const,
								label: "个人库删除前询问",
								description: "删除论文、移出分类、取消分类归属以及删除分类树。",
							},
							{
								key: "requireResearchConfirmation" as const,
								label: "调研区写入和删除前询问",
								description: "Markdown 调研笔记的创建、修改、关联和删除。",
							},
							{
								key: "requireWikiWriteConfirmation" as const,
								label: "知识库写入前询问",
								description: "Agent 向研究 Wiki 新建或更新知识页面。",
							},
							{
								key: "requirePdfArtifactConfirmation" as const,
								label: "PDF 与 Artifact 操作前询问",
								description: "PDF 下载与修正、Artifact 获取和检查。",
							},
						].map((item) => (
							<div className="confirmation-setting-row" key={item.key}>
								<div>
									<strong>{item.label}</strong>
									<p>{item.description}</p>
								</div>
								<label className="switch">
									<input
										type="checkbox"
										checked={config.confirmations[item.key]}
										onChange={(event) =>
											update((next) => {
												next.confirmations[item.key] = event.target.checked;
											})
										}
										aria-label={item.label}
									/>
									<span />
								</label>
							</div>
						))}
					</div>
					<p className="form-hint">团队操作、令牌、备份恢复、配置修改和系统文件操作始终需要确认。</p>
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
						<label className="wide">
							<span>DOI 补全数据源（逗号分隔）</span>
							<input
								value={config.search.doiEnrichmentProviders.join(", ")}
								onChange={(event) =>
									update((next) => {
										next.search.doiEnrichmentProviders = event.target.value
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
				<section className="panel form-panel team-access-panel">
					<span className="eyebrow">Team access</span>
					<h2>团队接入</h2>
					{teamAccess?.connected ? (
						<>
							<div className="team-access-summary">
								<StatusPill status="succeeded" />
								<div>
									<strong>{teamAccess.identity?.name ?? "已连接"}</strong>
									<p>{teamAccess.serverUrl}</p>
									<small>{teamAccess.identity?.roles.join("、") || "身份已验证"}</small>
								</div>
							</div>
							<div className="form-grid two">
								<label>
									<span>当前团队空间</span>
									<input
										list="team-namespace-options"
										value={teamNamespace}
										onChange={(event) => setTeamNamespace(event.target.value)}
									/>
									<datalist id="team-namespace-options">
										{[
											...new Set(
												[teamAccess.namespace, ...(teamAccess.identity?.namespaces ?? [])].filter(Boolean),
											),
										].map((namespace) => (
											<option key={namespace} value={namespace} />
										))}
									</datalist>
								</label>
								<div className="team-access-actions">
									<button
										className="button secondary"
										type="button"
										disabled={!teamNamespace.trim() || teamNamespace === teamAccess.namespace || teamBusy}
										onClick={() =>
											void prepareTeamAccess({ action: "switch", namespace: teamNamespace.trim() })
										}
									>
										切换空间
									</button>
									<button
										className="button danger"
										type="button"
										disabled={teamBusy}
										onClick={() => void prepareTeamAccess({ action: "clear" })}
									>
										断开连接
									</button>
								</div>
							</div>
						</>
					) : (
						<>
							{teamAccess?.reason && <div className="error-banner">{teamAccess.reason}</div>}
							<label className="team-invite-field">
								<span>编码接入串</span>
								<textarea
									value={teamInvite}
									placeholder="pateam1."
									onChange={(event) => setTeamInvite(event.target.value)}
								/>
							</label>
							<div className="team-access-actions">
								<button
									className="button primary"
									type="button"
									disabled={!teamInvite.trim() || teamBusy}
									onClick={() => void prepareTeamAccess({ action: "connect", invite: teamInvite.trim() })}
								>
									验证并接入
								</button>
								{teamAccess?.hasLocalAccess && (
									<button
										className="button danger"
										type="button"
										disabled={teamBusy}
										onClick={() => void prepareTeamAccess({ action: "clear" })}
									>
										清除失效接入
									</button>
								)}
							</div>
							<p className="form-hint">
								接入串包含服务器地址、团队空间、身份凭据和自签 CA；它只是编码，不是加密。
							</p>
						</>
					)}
				</section>
			</div>
		</>
	);
}

export default function App() {
	const initialPdf = useMemo(() => launchPdfPath(), []);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => window.localStorage.getItem("paper-agent-sidebar-collapsed") === "true",
	);
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
	const [libraryToolbarTarget, setLibraryToolbarTarget] = useState<HTMLDivElement | null>(null);
	const [researchTarget, setResearchTarget] = useState<ResearchNoteNavigation>();
	const refreshStatus = useCallback(async () => {
		try {
			setStatus(await api<ApplicationStatus>("/api/status"));
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, []);
	useEffect(() => {
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
	const openResearchNote = (target: ResearchNoteNavigation) => {
		setResearchTarget(target);
		setPage("research");
	};
	const title = useMemo(() => navigation.find((item) => item.id === page)?.label ?? "论文阅读器", [page]);
	let lastSection = "";
	return (
		<ConfirmationPolicyProvider settings={status?.confirmations}>
			<div
				className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${page === "reader" ? " reader-active" : ""}`}
			>
				{page !== "reader" && (
					<aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
						<button
							className="sidebar-collapse-button"
							type="button"
							onClick={() =>
								setSidebarCollapsed((current) => {
									const next = !current;
									window.localStorage.setItem("paper-agent-sidebar-collapsed", String(next));
									return next;
								})
							}
							aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
							title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
						>
							{sidebarCollapsed ? "›" : "‹"}
						</button>
						<div className="brand">
							<div className="brand-mark">P</div>
							<div className="brand-copy">
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
										<button
											className={page === item.id ? "active" : ""}
											type="button"
											onClick={() => go(item.id)}
											title={sidebarCollapsed ? item.label : undefined}
										>
											<span className="nav-icon">{item.icon}</span>
											<span className="nav-label">{item.label}</span>
										</button>
									</div>
								);
							})}
						</nav>
						<div className="sidebar-footer">
							<span className="health-dot" />
							<div className="sidebar-footer-copy">
								<strong>本地服务已连接</strong>
								<small>{status?.defaultRecordCount ?? 0} 篇个人论文</small>
							</div>
						</div>
					</aside>
				)}
				<main
					className={`main-area${page === "library" ? " main-area-library" : ""}${page === "reader" ? " main-area-reader" : ""}${page === "research" ? " main-area-research" : ""}${page === "wiki" ? " main-area-wiki" : ""}`}
				>
					{page !== "agent" && page !== "reader" && (
						<div className={`topbar${page === "library" ? " topbar-library" : ""}`}>
							<div className="topbar-breadcrumb">
								<span className="breadcrumb">Paper Agent /</span> {title}
							</div>
							{page === "library" && <div className="library-topbar-slot" ref={setLibraryToolbarTarget} />}
							<div className="topbar-actions">
								{lastTask && (
									<button type="button" onClick={() => go("tasks")}>
										<StatusPill status={lastTask.status} />
										{lastTask.type}
									</button>
								)}
							</div>
						</div>
					)}
					<div
						className={`page-content${page === "agent" ? " page-content-full" : page === "library" ? " page-content-library" : page === "reader" ? " page-content-reader" : page === "research" ? " page-content-research" : page === "wiki" ? " page-content-wiki" : ""}`}
					>
						{error && <div className="error-banner">{error}</div>}
						{page === "dashboard" && <DashboardPage status={status} go={go} />}
						{page === "search" && <SearchPage onTask={trackTask} />}
						{page === "agent" && <AgentPage />}
						{page === "library" && (
							<LibraryPage
								onOpenReader={openReader}
								onTask={trackTask}
								toolbarTarget={libraryToolbarTarget}
								onOpenResearchNote={openResearchNote}
							/>
						)}
						{page === "tasks" && <TasksPage />}
						{page === "pdf" && <PdfWorkspacePage onTask={trackTask} />}
						{page === "reader" && reader && <ReaderPage reader={reader} onBack={() => go("library")} />}
						{page === "team" && <TeamPage />}
						{page === "research" && <ResearchNotesPage target={researchTarget} />}
						{page === "wiki" && <WikiPage defaultNamespace={status?.defaultNamespace ?? "default"} />}
						{page === "settings" && <SettingsPage onConfigurationSaved={refreshStatus} />}
					</div>
				</main>
			</div>
		</ConfirmationPolicyProvider>
	);
}
