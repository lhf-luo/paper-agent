import {
	ArrowRight,
	ArrowUpRight,
	Bell,
	BookOpen,
	Building,
	Calendar,
	Check,
	CheckCheck,
	ChevronDown,
	ChevronUp,
	ClipboardCheck,
	Clock,
	Copy,
	Download,
	ExternalLink,
	Eye,
	FileText,
	FolderOpen,
	Info,
	Layers,
	MessageSquare,
	MessagesSquare,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Save,
	Search,
	Send,
	ShieldCheck,
	SlidersHorizontal,
	Trash2,
	Undo2,
	Unlock,
	UploadCloud,
	UserCheck,
	Users,
	X,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	TeamActor,
	TeamContentRef,
	TeamContentSummary,
	TeamDiscussion,
	TeamListPage,
	TeamNotification,
	TeamReviewResource,
	TeamReviewSnapshot,
	TeamSubmission,
	TeamTopic,
} from "../../src/team/domain/team-corpus-types";
import { api, jsonBody } from "./api";
import { AccessibleModal, confirmOperation, EmptyState, StatusPill } from "./components";
import { showDerivedAndArtifactFeatures } from "./team-feature-flags";
import { TeamOperationModal, TeamSnapshotBody } from "./team-operation-preview";
import type { PaperRecord, PreparedOperation } from "./types";
import "./team-collaboration-panel.css";

const names: Record<TeamReviewResource, string> = {
	papers: "论文",
	pages: "知识页面",
	derived: "派生记录",
	artifacts: "材料清单",
};
const outcomes: Record<string, string> = {
	pending: "待审核",
	approved: "已批准",
	rejected: "已拒绝",
	"changes-requested": "退回修改",
	withdrawn: "已撤回",
	superseded: "已被后续版本替换",
};
type Tab = "published" | "review" | "mine" | "topics" | "notifications";
const refKey = (ref: TeamContentRef) => `${ref.resource}:${ref.id}`;

export function TeamCollaborationPanel({
	canRead,
	canContribute,
	canReview,
	personalNamespace,
	onChanged,
	autoSync = true,
	onPreviewPaper,
}: {
	canRead: boolean;
	canContribute: boolean;
	canReview: boolean;
	personalNamespace: string;
	onChanged: () => void;
	autoSync?: boolean;
	/** 打开团队页的论文详情弹窗（合并检索中心后由论文卡片调用）。 */
	onPreviewPaper?: (paper: PaperRecord) => void;
}) {
	const [tab, setTab] = useState<Tab>(canRead || canReview ? "published" : "mine");
	// 默认展示论文检索（原检索控制台/已共享论文面板合并至此）。
	const [kind, setKind] = useState<TeamReviewResource>("papers");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [topicId, setTopicId] = useState("");
	const [status, setStatus] = useState("");
	const [content, setContent] = useState<TeamContentSummary[]>([]);
	const [submissions, setSubmissions] = useState<TeamSubmission[]>([]);
	const [topics, setTopics] = useState<TeamTopic[]>([]);
	const [notifications, setNotifications] = useState<TeamNotification[]>([]);
	const [unread, setUnread] = useState(0);
	const [total, setTotal] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [active, setActive] = useState<TeamReviewSnapshot>();
	const [discussion, setDiscussion] = useState<TeamDiscussion>();
	const [reviewers, setReviewers] = useState<TeamActor[]>([]);
	const [comment, setComment] = useState("");
	const [assignee, setAssignee] = useState("");
	const [pending, setPending] = useState<{
		operation: PreparedOperation;
		path: string;
		payload: Record<string, unknown>;
	}>();
	const [editingTopic, setEditingTopic] = useState<{
		id: string;
		title: string;
		description: string;
		entries: TeamContentRef[];
		expectedVersion?: string;
	}>();
	const [topicChoices, setTopicChoices] = useState<TeamContentSummary[]>([]);
	const [choiceCursor, setChoiceCursor] = useState<string>();
	const [artifactSources, setArtifactSources] =
		useState<
			Array<{
				paperId: string;
				title: string;
				pdfSha256: string;
				discoveredAt: string;
				candidates: number;
				acquisitions: number;
			}>
		>();
	const [artifactCursor, setArtifactCursor] = useState<string>();

	// ---- 合并检索中心：论文结构化检索（原 team-page 检索控制台能力）----
	const [showPaperFilters, setShowPaperFilters] = useState(false);
	const [paperFilters, setPaperFilters] = useState<{
		author: string;
		venue: string;
		yearFrom: string;
		yearTo: string;
		type: string;
		openAccess: "all" | "true" | "false";
		status: string;
		/** 团队共享分类（TeamTopic）id；空串表示不按分类筛选。 */
		topicId: string;
	}>({ author: "", venue: "", yearFrom: "", yearTo: "", type: "", openAccess: "all", status: "", topicId: "" });
	// load 是 useCallback 缓存的，过滤器经 ref 读取，避免输入时频繁触发请求；点「搜索/刷新」后生效。
	const paperFiltersRef = useRef(paperFilters);
	paperFiltersRef.current = paperFilters;
	const [paperHits, setPaperHits] = useState<PaperRecord[]>([]);
	const paperHitsRef = useRef<PaperRecord[]>([]);
	const [pullIncludePdf, setPullIncludePdf] = useState(true);
	const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());
	const toggleAbstract = (id: string) =>
		setExpandedAbstracts((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const resetPaperFilters = () =>
		setPaperFilters({
			author: "",
			venue: "",
			yearFrom: "",
			yearTo: "",
			type: "",
			openAccess: "all",
			status: "",
			topicId: "",
		});

	// 分类筛选需要分类清单，而清单原先只在「专题集合」页签加载；打开筛选抽屉时补一次。
	useEffect(() => {
		if (!showPaperFilters || (!canRead && !canReview)) return;
		let cancelled = false;
		void (async () => {
			try {
				const result = await api<TeamListPage<TeamTopic>>("/api/team/topics?limit=200");
				if (!cancelled) setTopics(result.entries);
			} catch {
				// 分类清单取不到时筛选退化为「全部分类」，不影响论文检索本身。
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [showPaperFilters, canRead, canReview]);

	// ---- 分页状态：游标栈记录每一页的取数位置，页码翻页代替"加载更多"追加 ----
	const PAGE_SIZE = 10;
	const [pageIndex, setPageIndex] = useState(0);
	const pageIndexRef = useRef(0);
	const pageCursorsRef = useRef<(string | undefined)[]>([undefined]);
	const [hasNextPage, setHasNextPage] = useState(false);

	const load = useCallback(
		async (opts?: { cursor?: string; index?: number; filters?: typeof paperFilters }) => {
			const index = opts?.index ?? pageIndexRef.current;
			const cursor = opts?.cursor ?? pageCursorsRef.current[index];
			setLoading(true);
			setError("");
			try {
				const params = new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
				let page: TeamListPage<unknown>;
				if (tab === "published" && kind === "papers" && !topicId) {
					// 合并检索中心：论文走结构化检索（作者/会议/年份/类型/OA/审核状态 + 游标分页）。
					if (search) params.set("q", search);
					const filters = opts?.filters ?? paperFiltersRef.current;
					if (filters.author.trim()) params.set("author", filters.author.trim());
					if (filters.venue.trim()) params.set("venue", filters.venue.trim());
					if (filters.yearFrom.trim()) params.set("yearFrom", filters.yearFrom.trim());
					if (filters.yearTo.trim()) params.set("yearTo", filters.yearTo.trim());
					if (filters.type) params.set("type", filters.type);
					if (filters.openAccess !== "all") params.set("openAccess", filters.openAccess);
					if (canReview && filters.status) params.set("status", filters.status);
					// 分类筛选下推到服务端检索，避免客户端过滤与游标分页互相矛盾。
					if (filters.topicId) params.set("topic", filters.topicId);
					const result = await api<{ hits: Array<{ record: PaperRecord }>; nextCursor?: string }>(
						`/api/team/search?${params.toString()}`,
					);
					const hits = result.hits.map((hit) => hit.record);
					paperHitsRef.current = hits;
					setPaperHits(hits);
					// 检索接口没有全量 total，仅以"已见条数"展示。
					page = {
						nextCursor: result.nextCursor,
						total: (index * PAGE_SIZE + hits.length) as number,
					} as TeamListPage<unknown>;
				} else if (tab === "published" || tab === "review") {
					params.set("resource", kind);
					if (search) params.set("q", search);
					if (tab === "review") params.set("pending", "true");
					if (topicId && tab === "published") params.set("topicId", topicId);
					const result = await api<TeamListPage<TeamContentSummary>>(`/api/team/content?${params}`);
					setContent(result.entries);
					page = result;
				} else if (tab === "mine") {
					params.set("mine", "true");
					if (status) params.set("status", status);
					const result = await api<TeamListPage<TeamSubmission>>(`/api/team/contributions?${params}`);
					setSubmissions(result.entries);
					page = result;
				} else if (tab === "topics") {
					const result = await api<TeamListPage<TeamTopic>>(`/api/team/topics?${params}`);
					setTopics(result.entries);
					page = result;
				} else {
					const result = await api<TeamListPage<TeamNotification> & { unread: number }>(
						`/api/team/notifications?${params}`,
					);
					setNotifications(result.entries);
					setUnread(result.unread);
					page = result;
				}
				// 记录下一页游标，并截断回退/换页后失效的前向游标。
				pageCursorsRef.current[index + 1] = page.nextCursor;
				pageCursorsRef.current.length = index + 2;
				setHasNextPage(Boolean(page.nextCursor));
				setTotal(page.total);
				setSelected(new Set());
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				setLoading(false);
			}
		},
		[tab, kind, search, topicId, status, canReview],
	);
	useEffect(() => {
		// 筛选/类型/关键词变化：回到第 1 页重新加载。
		pageIndexRef.current = 0;
		setPageIndex(0);
		pageCursorsRef.current = [undefined];
		setHasNextPage(false);
		void load({ cursor: undefined, index: 0 });
	}, [load]);
	const goToPage = (target: number) => {
		if (target < 0 || target === pageIndexRef.current) return;
		const cursor = pageCursorsRef.current[target];
		if (target > 0 && !cursor) return;
		pageIndexRef.current = target;
		setPageIndex(target);
		void load({ cursor, index: target });
	};
	useEffect(() => {
		if (!autoSync) return;
		const timer = window.setInterval(() => {
			if (
				document.visibilityState === "visible" &&
				!pending &&
				!active &&
				!discussion &&
				!editingTopic &&
				!selected.size
			)
				void load();
		}, 30_000);
		return () => window.clearInterval(timer);
	}, [autoSync, load, pending, active, discussion, editingTopic, selected.size]);

	const prepare = async (path: string, payload: Record<string, unknown>) => {
		setError("");
		setBusy(true);
		try {
			const operation = await api<PreparedOperation>(`${path}/prepare`, jsonBody(payload));
			setPending({ operation, path: `${path}/execute`, payload });
			setActive(undefined);
			setDiscussion(undefined);
			setEditingTopic(undefined);
			setArtifactSources(undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};
	const execute = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = await confirmOperation(pending.operation);
			const result = await api<{
				created?: string[];
				unchanged?: string[];
				preserved?: string[];
				pulled?: number;
				pdfs?: Array<{ paperId: string; status: string; reason?: string }>;
			}>(pending.path, jsonBody({ ...pending.payload, grant }));
			const pdfFailures = result.pdfs?.filter((entry) => entry.status === "failed") ?? [];
			setMessage(
				typeof result.pulled === "number"
					? `已拉取 ${result.pulled} 篇论文。${pdfFailures.length ? `PDF 未保存：${pdfFailures.map((entry) => `${entry.paperId}（${entry.reason ?? "下载失败"}）`).join("；")}` : "PDF 获取已完成。"}`
					: result.created
						? `已保存 ${result.created.length} 份快照，复用 ${result.unchanged?.length ?? 0} 份，保留个人编辑 ${result.preserved?.length ?? 0} 份。`
						: "操作已完成。",
			);
			setPending(undefined);
			setReason("");
			setComment("");
			await load();
			onChanged();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setPending(undefined);
		} finally {
			setBusy(false);
		}
	};
	const open = async (ref: TeamContentRef, pendingContent = false, version?: string) => {
		setError("");
		try {
			const query = new URLSearchParams({
				...(pendingContent ? { pending: "true" } : {}),
				...(version ? { version } : {}),
			});
			setActive(
				await api<TeamReviewSnapshot>(`/api/team/content/${ref.resource}/${encodeURIComponent(ref.id)}?${query}`),
			);
			setDiscussion(undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const openDiscussion = async (ref: TeamContentRef) => {
		setError("");
		try {
			const value = await api<TeamDiscussion>(`/api/team/discussions/${ref.resource}/${encodeURIComponent(ref.id)}`);
			setDiscussion(value);
			setAssignee(value.assignedTo?.id ?? "");
			setComment("");
			if (canReview) setReviewers((await api<{ entries: TeamActor[] }>("/api/team/reviewers")).entries);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const review = (
		entries: Array<TeamContentRef & { version: string }>,
		decision: "team-approved" | "team-rejected",
	) => {
		if (!entries.length) return;
		void prepare("/api/team/reviews", {
			resource: entries[0].resource,
			ids: entries.map((entry) => entry.id),
			expectedVersions: Object.fromEntries(entries.map((entry) => [entry.id, entry.version])),
			decision,
			reason: reason.trim() || undefined,
		});
	};
	const chooseTopic = async (topic?: TeamTopic) => {
		setError("");
		try {
			const available = await api<TeamListPage<TeamContentSummary>>("/api/team/content?limit=100");
			setTopicChoices(available.entries);
			setChoiceCursor(available.nextCursor);
			setEditingTopic({
				id: topic?.id ?? `topic-${crypto.randomUUID()}`,
				title: topic?.title ?? "",
				description: topic?.description ?? "",
				entries: topic?.entries ?? [],
				expectedVersion: topic?.version,
			});
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const selectedContent = content.filter((entry) => selected.has(refKey(entry)));
	// 论文检索卡片的勾选存在 selected 里（键 papers:<id>），与内容行的勾选合并成可操作条目。
	const selectedEntries: Array<TeamContentRef> = [
		...selectedContent.map(({ resource, id }) => ({ resource, id })),
		...[...selected]
			.filter((key) => key.startsWith("papers:"))
			.map((key) => ({ resource: "papers" as const, id: key.slice("papers:".length) })),
	];
	// 派生记录与材料清单暂时整体隐藏：我的提案列表与专题候选不再展示这两类。
	const visibleSubmissions = showDerivedAndArtifactFeatures
		? submissions
		: submissions.filter((entry) => entry.resource !== "derived" && entry.resource !== "artifacts");
	const visibleTopicChoices = showDerivedAndArtifactFeatures
		? topicChoices
		: topicChoices.filter((entry) => entry.resource !== "derived" && entry.resource !== "artifacts");
	const activePaperIds =
		!active || active.resource === "papers"
			? []
			: active.resource === "pages"
				? (active.content as { snapshot: { paperIds: string[] } }).snapshot.paperIds
				: active.resource === "derived"
					? [(active.content as { record: { paperId: string } }).record.paperId]
					: [(active.content as { paperId: string }).paperId];
	const activePending =
		active &&
		(active.resource === "papers"
			? (active.content as { record: PaperRecord }).record.curation?.teamReview?.status
			: (active.content as { review: { status: string } }).review.status) === "team-proposed";
	const loadArtifacts = async (next?: string) => {
		try {
			const page = await api<
				TeamListPage<{
					paperId: string;
					title: string;
					pdfSha256: string;
					discoveredAt: string;
					candidates: number;
					acquisitions: number;
				}>
			>(
				`/api/team/artifacts/personal?namespace=${encodeURIComponent(personalNamespace)}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
			);
			setArtifactSources((previous) => (next ? [...(previous ?? []), ...page.entries] : page.entries));
			setArtifactCursor(page.nextCursor);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const tabs: Array<{ id: Tab; label: string; icon: typeof Search }> = [
		...(canRead || canReview
			? [
					{ id: "published" as const, label: "知识检索", icon: Search },
					{ id: "topics" as const, label: "专题集合", icon: FolderOpen },
				]
			: []),
		...(canReview ? [{ id: "review" as const, label: "完整审核队列", icon: ClipboardCheck }] : []),
		...(canContribute ? [{ id: "mine" as const, label: "我的提案与反馈", icon: Send }] : []),
		{ id: "notifications", label: "站内通知", icon: Bell },
	];
	return (
		<section className="avant-panel team-collaboration-panel" id="team-collaboration-workspace">
			<div className="panel-header-editorial">
				<div className="panel-title-block">
					<span className="avant-eyebrow">SHARED INTELLIGENCE · 协同阅览</span>
					<h2>团队知识与协作</h2>
					<p>全文检索、逐项阅读、提案反馈和知识复用。列表按页加载，正文在打开时读取。</p>
				</div>
			</div>
			<nav className="team-collaboration-tabs" aria-label="团队协作功能">
				{tabs.map((item) => {
					const TabIcon = item.icon;
					return (
						<button
							type="button"
							className={`collab-tab-btn ${tab === item.id ? "active" : ""}`}
							aria-current={tab === item.id ? "page" : undefined}
							key={item.id}
							onClick={() => {
								setTab(item.id);
								setMessage("");
							}}
						>
							<TabIcon size={13} />
							{item.label}
							{item.id === "notifications" && unread > 0 && (
								<span className="collab-tab-count">{unread > 99 ? "99+" : unread}</span>
							)}
						</button>
					);
				})}
			</nav>
			{error && (
				<p role="alert" className="team-collaboration-error">
					<XCircle size={15} />
					{error}
				</p>
			)}
			{message && (
				<output className="collab-message">
					<Info size={15} />
					{message}
				</output>
			)}
			<div className="team-collaboration-toolbar">
				{canContribute && showDerivedAndArtifactFeatures && (
					<button
						type="button"
						className="avant-btn avant-btn-secondary"
						disabled={busy}
						onClick={() => void loadArtifacts()}
					>
						<UploadCloud size={14} />
						提交个人材料清单
					</button>
				)}
				{(tab === "published" || tab === "review") && (
					<>
						<label className="collab-field">
							<span>
								<Layers size={12} /> 内容类型
							</span>
							<select
								className="avant-select"
								value={kind}
								onChange={(event) => setKind(event.target.value as TeamReviewResource)}
							>
								{Object.entries(names)
									.filter(
										([value]) =>
											showDerivedAndArtifactFeatures || (value !== "derived" && value !== "artifacts"),
									)
									.map(([value, label]) => (
										<option key={value} value={value}>
											{label}
										</option>
									))}
							</select>
						</label>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								setSearch(query);
							}}
						>
							<label className="collab-field">
								<span>
									<Search size={12} /> {kind === "papers" ? "论文关键词" : "全文关键词"}
								</span>
								<input
									className="avant-input"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={
										kind === "papers" ? "输入论文标题、摘要、作者或 DOI 关键词…" : "标题、正文或证据关键词"
									}
								/>
							</label>
							<button type="submit" className="avant-btn avant-btn-primary" disabled={loading}>
								<Search size={14} className={loading ? "spin" : ""} />
								搜索
							</button>
						</form>
						{tab === "published" && kind === "papers" && !topicId && (
							<button
								type="button"
								className={`avant-btn avant-btn-secondary ${showPaperFilters ? "active" : ""}`}
								onClick={() => setShowPaperFilters(!showPaperFilters)}
							>
								<SlidersHorizontal size={14} />
								高级过滤器
							</button>
						)}
						{topicId && (
							<button type="button" className="avant-btn avant-btn-subtle" onClick={() => setTopicId("")}>
								<X size={14} />
								清除专题筛选
							</button>
						)}
						{tab === "published" && kind === "papers" && !topicId && paperFilters.topicId && (
							<button
								type="button"
								className="avant-btn avant-btn-subtle"
								onClick={() => {
									// 显式传入清空后的筛选条件，避免 ref 尚未刷新就重新检索。
									const next = { ...paperFilters, topicId: "" };
									setPaperFilters(next);
									void load({ filters: next });
								}}
							>
								<X size={14} />
								分类：{topics.find((topic) => topic.id === paperFilters.topicId)?.title ?? "已选分类"}
							</button>
						)}
					</>
				)}
				{tab === "mine" && (
					<label className="collab-field">
						<span>
							<ClipboardCheck size={12} /> 提案状态
						</span>
						<select className="avant-select" value={status} onChange={(event) => setStatus(event.target.value)}>
							<option value="">全部状态</option>
							{Object.entries(outcomes).map(([value, label]) => (
								<option value={value} key={value}>
									{label}
								</option>
							))}
						</select>
					</label>
				)}
				<button
					type="button"
					className="avant-btn avant-btn-secondary"
					onClick={() => void load()}
					disabled={loading}
				>
					<RefreshCw size={14} className={loading ? "spin" : ""} />
					刷新列表
				</button>
				<span className="collab-total-tag">
					{tab === "published" && kind === "papers" && !topicId
						? `已浏览 ${total} 条`
						: `${total} 条${tab === "notifications" ? ` · ${unread} 条未读` : ""}`}
				</span>
			</div>
			{tab === "published" && kind === "papers" && !topicId && showPaperFilters && (
				<div className="advanced-filters-drawer">
					<label className="filter-field">
						<span>
							<Users size={12} /> 作者 (Author)
						</span>
						<input
							className="avant-input"
							value={paperFilters.author}
							onChange={(event) => setPaperFilters({ ...paperFilters, author: event.target.value })}
							placeholder="例如：Vaswani, Hinton"
						/>
					</label>
					<label className="filter-field">
						<span>
							<Building size={12} /> 会议 / 期刊 (Venue)
						</span>
						<input
							className="avant-input"
							value={paperFilters.venue}
							onChange={(event) => setPaperFilters({ ...paperFilters, venue: event.target.value })}
							placeholder="例如：NeurIPS, ICML, CVPR"
						/>
					</label>
					<label className="filter-field">
						<span>
							<Calendar size={12} /> 起始年份
						</span>
						<input
							type="number"
							className="avant-input"
							value={paperFilters.yearFrom}
							onChange={(event) => setPaperFilters({ ...paperFilters, yearFrom: event.target.value })}
							placeholder="例如：2020"
						/>
					</label>
					<label className="filter-field">
						<span>
							<Calendar size={12} /> 结束年份
						</span>
						<input
							type="number"
							className="avant-input"
							value={paperFilters.yearTo}
							onChange={(event) => setPaperFilters({ ...paperFilters, yearTo: event.target.value })}
							placeholder="例如：2026"
						/>
					</label>
					<label className="filter-field">
						<span>
							<BookOpen size={12} /> 文献类型
						</span>
						<select
							className="avant-select"
							value={paperFilters.type}
							onChange={(event) => setPaperFilters({ ...paperFilters, type: event.target.value })}
						>
							<option value="">全部类型</option>
							<option value="journal-article">期刊论文 (Journal)</option>
							<option value="proceedings-article">会议论文 (Conference)</option>
							<option value="preprint">预印本 (Preprint)</option>
							<option value="book">著作 / 章节</option>
						</select>
					</label>
					<label className="filter-field">
						<span>
							<Unlock size={12} /> 开放获取 (OpenAccess)
						</span>
						<select
							className="avant-select"
							value={paperFilters.openAccess}
							onChange={(event) =>
								setPaperFilters({ ...paperFilters, openAccess: event.target.value as "all" | "true" | "false" })
							}
						>
							<option value="all">全部（含闭源）</option>
							<option value="true">仅开放获取 (OA Only)</option>
							<option value="false">仅限制访问 (Non-OA)</option>
						</select>
					</label>
					<label className="filter-field">
						<span>
							<FolderOpen size={12} /> 分类 (Category)
							{topics.length === 0 && <em style={{ marginLeft: 6, fontStyle: "normal", opacity: 0.7 }}>（暂无分类）</em>}
						</span>
						<select
							className="avant-select"
							value={paperFilters.topicId}
							onChange={(event) => setPaperFilters({ ...paperFilters, topicId: event.target.value })}
						>
							<option value="">全部分类</option>
							{topics.map((topic) => (
								<option key={topic.id} value={topic.id}>
									{topic.title}
								</option>
							))}
						</select>
					</label>
					{canReview && (
						<label className="filter-field">
							<span>
								<ShieldCheck size={12} /> 审核状态 (Review Status)
							</span>
							<select
								className="avant-select"
								value={paperFilters.status}
								onChange={(event) => setPaperFilters({ ...paperFilters, status: event.target.value })}
							>
								<option value="">默认（仅已批准）</option>
								<option value="team-approved">已批准 (Approved)</option>
								<option value="team-proposed">待审核 (Proposed)</option>
								<option value="team-rejected">已拒绝 (Rejected)</option>
							</select>
						</label>
					)}
					<div className="filter-field filter-reset-wrap">
						<button type="button" className="avant-btn avant-btn-secondary" onClick={resetPaperFilters}>
							<RotateCcw size={13} />
							重置筛选条件
						</button>
					</div>
				</div>
			)}
			{tab === "review" && (
				<div className="team-collaboration-toolbar">
					<label className="collab-field">
						<span>
							<MessageSquare size={12} /> 审核理由
						</span>
						<input
							className="avant-input"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="批准、拒绝或退回修改的依据"
						/>
					</label>
					<button
						type="button"
						className="avant-btn avant-btn-primary"
						disabled={!selectedContent.length || busy}
						onClick={() => review(selectedContent, "team-approved")}
					>
						<Check size={14} />
						批准所选（{selectedContent.length}）
					</button>
					<button
						type="button"
						className="avant-btn avant-btn-secondary danger-hover"
						disabled={!selectedContent.length || busy}
						onClick={() => review(selectedContent, "team-rejected")}
					>
						<X size={14} />
						拒绝所选
					</button>
				</div>
			)}
			{tab === "published" && (
				<div className="team-collaboration-toolbar">
					<button
						type="button"
						className="avant-btn avant-btn-primary"
						disabled={!selectedEntries.length || busy}
						onClick={() =>
							void prepare(
								kind === "papers" && !topicId ? "/api/team/pull" : "/api/team/knowledge-pull",
								kind === "papers" && !topicId
									? {
											paperIds: selectedEntries.map((entry) => entry.id),
											personalNamespace,
											includePdf: pullIncludePdf,
										}
									: {
											entries: selectedEntries.map(({ resource, id }) => ({ resource, id })),
											personalNamespace,
										},
							)
						}
					>
						<Download size={14} />
						{kind === "papers" && !topicId ? "拉取所选论文" : "将所选快照保存为个人笔记"} (
						{selectedEntries.length})
					</button>
					{kind === "papers" && !topicId && (
						<label className="checkbox-wrap">
							<input
								type="checkbox"
								checked={pullIncludePdf}
								onChange={(event) => setPullIncludePdf(event.target.checked)}
							/>
							<span>同步拉取 PDF 到本地</span>
						</label>
					)}
					<span className="collab-total-tag">目标个人空间：{personalNamespace}</span>
				</div>
			)}
			{(tab === "published" || tab === "review") && tab === "published" && kind === "papers" && !topicId && (
				<div className="team-collaboration-list">
					{paperHits.length > 0 && (
						<div className="results-action-bar">
							<div className="selection-toolbar-left">
								<label className="checkbox-wrap">
									<input
										type="checkbox"
										checked={paperHits.every((paper) => selected.has(`papers:${paper.id}`))}
										onChange={(event) =>
											setSelected(
												event.target.checked
													? new Set([...selected, ...paperHits.map((paper) => `papers:${paper.id}`)])
													: new Set(
															[...selected].filter(
																(key) =>
																	!key.startsWith("papers:") ||
																	!paperHits.some((paper) => `papers:${paper.id}` === key),
															),
														),
											)
										}
									/>
									<span>全选检索结果</span>
								</label>
								<span className="selected-count-tag">
									已选 {paperHits.filter((paper) => selected.has(`papers:${paper.id}`)).length} 篇
								</span>
							</div>
						</div>
					)}
					{paperHits.map((paper) => {
						const selectKey = `papers:${paper.id}`;
						const isAbstractExpanded = expandedAbstracts.has(paper.id);
						return (
							<article
								key={paper.id}
								className={`shared-paper-card ${selected.has(selectKey) ? "checked" : ""}`}
							>
								<div className="shared-card-header">
									<div className="card-select-and-badges">
										<input
											type="checkbox"
											aria-label={`选择拉取论文 ${paper.title}`}
											checked={selected.has(selectKey)}
											onChange={(event) =>
												setSelected((previous) => {
													const next = new Set(previous);
													if (event.target.checked) next.add(selectKey);
													else next.delete(selectKey);
													return next;
												})
											}
										/>
										<StatusPill status={paper.curation?.teamReview?.status ?? "team-approved"} />
										{paper.venueRank && (
											<span className={`ccf-badge ccf-${paper.venueRank.toLowerCase()}`}>
												CCF-{paper.venueRank}
											</span>
										)}
										{paper.publicationType && (
											<span className="avant-badge avant-badge-type">{paper.publicationType}</span>
										)}
										{paper.year && (
											<span className="avant-badge avant-badge-year">
												<Calendar size={11} />
												{paper.year}
											</span>
										)}
										{paper.citationCount != null && (
											<span className="avant-badge avant-badge-cite">引用: {paper.citationCount}</span>
										)}
									</div>
									{paper.curation?.teamReview?.proposedBy && (
										<div className="card-proposer-meta">
											<Users size={12} />
											<span>{paper.curation.teamReview.proposedBy}</span>
											{paper.curation.teamReview.proposedAt && (
												<>
													<Clock size={12} />
													<span>
														{new Date(paper.curation.teamReview.proposedAt).toLocaleDateString()}
													</span>
												</>
											)}
										</div>
									)}
								</div>

								<div className="card-headline">
									<h3 className="paper-title">
										<button
											type="button"
											className="title-link-button"
											onClick={() => onPreviewPaper?.(paper)}
											title="点击查看文献详情"
										>
											{paper.title}
										</button>
									</h3>
									{paper.venue && (
										<span className="paper-venue">
											<Building size={13} />
											{paper.venue}
										</span>
									)}
								</div>

								{paper.authors?.length > 0 && (
									<div className="card-authors-row">
										{paper.authors.slice(0, 8).map((author) => (
											<span key={author} className="author-pill">
												{author}
											</span>
										))}
										{paper.authors.length > 8 && (
											<span className="author-pill more">+{paper.authors.length - 8} 位作者</span>
										)}
									</div>
								)}

								{paper.abstract && (
									<div className={`paper-abstract-container ${isAbstractExpanded ? "expanded" : "collapsed"}`}>
										<p className="abstract-text">{paper.abstract}</p>
										<button
											type="button"
											className="abstract-toggle-btn"
											onClick={() => toggleAbstract(paper.id)}
										>
											{isAbstractExpanded ? (
												<>
													<ChevronUp size={12} /> 收起摘要
												</>
											) : (
												<>
													<ChevronDown size={12} /> 展开完整摘要
												</>
											)}
										</button>
									</div>
								)}

								<div className="card-identifiers-bar">
									{paper.identifiers?.doi && (
										<a
											href={`https://doi.org/${encodeURIComponent(paper.identifiers.doi)}`}
											target="_blank"
											rel="noopener noreferrer"
											className="identifier-link"
										>
											<code>DOI: {paper.identifiers.doi}</code>
											<ExternalLink size={11} />
										</a>
									)}
									{paper.identifiers?.arxivId && (
										<a
											href={`https://arxiv.org/abs/${encodeURIComponent(paper.identifiers.arxivId)}`}
											target="_blank"
											rel="noopener noreferrer"
											className="identifier-link"
										>
											<code>arXiv: {paper.identifiers.arxivId}</code>
											<ExternalLink size={11} />
										</a>
									)}
									{paper.identifiers?.openAlexId && (
										<button
											type="button"
											className="identifier-copy-btn"
											onClick={() => {
												void navigator.clipboard.writeText(paper.identifiers!.openAlexId!);
												setMessage("已复制 OpenAlex ID。");
											}}
										>
											<code>OA: {paper.identifiers.openAlexId}</code>
											<Copy size={11} />
										</button>
									)}
									{paper.identifiers?.semanticScholarId && (
										<button
											type="button"
											className="identifier-copy-btn"
											onClick={() => {
												void navigator.clipboard.writeText(paper.identifiers!.semanticScholarId!);
												setMessage("已复制 Semantic Scholar ID。");
											}}
										>
											<code>S2: {paper.identifiers.semanticScholarId.slice(0, 10)}…</code>
											<Copy size={11} />
										</button>
									)}
								</div>

								{paper.curation?.tags?.length ? (
									<div className="card-tags-row">
										{paper.curation.tags.map((tag) => (
											<span key={tag} className="avant-badge avant-badge-tag">
												#{tag}
											</span>
										))}
									</div>
								) : null}

								<div className="shared-card-actions-bar">
									<div className="shared-actions-left">
										{paper.links
											?.filter((link) => link.kind === "pdf")
											.map((link) => (
												<a
													key={`${link.kind}-${link.url}`}
													href={link.url}
													target="_blank"
													rel="noopener noreferrer"
													className="resource-chip pdf"
												>
													<FileText size={11} />
													<span>PDF {link.openAccess ? "(OA)" : ""}</span>
													<ArrowUpRight size={11} />
												</a>
											))}
									</div>
									<div className="shared-actions-right">
										<button
											type="button"
											className="avant-btn avant-btn-secondary"
											onClick={() => onPreviewPaper?.(paper)}
										>
											<Eye size={13} />
											查看详情
										</button>
										<button
											type="button"
											className="avant-btn avant-btn-primary"
											disabled={busy}
											onClick={() =>
												void prepare("/api/team/pull", {
													paperIds: [paper.id],
													personalNamespace,
													includePdf: pullIncludePdf,
												})
											}
										>
											<Download size={13} />
											拉取到个人库
										</button>
									</div>
								</div>
							</article>
						);
					})}
					{!loading && !paperHits.length && (
						<EmptyState title="暂无匹配的团队论文" text="调整关键词或高级过滤器后重新检索。" />
					)}
				</div>
			)}
			{(tab === "published" || tab === "review") && !(tab === "published" && kind === "papers" && !topicId) && (
				<div className="team-collaboration-list">
					{content.map((entry) => {
						const statusTag = entry.review.revision ? (
							<span className="collab-status-tag pending">待审修订</span>
						) : entry.review.status === "team-approved" ? (
							<span className="collab-status-tag published">已发布</span>
						) : (
							<span className="collab-status-tag pending">待审核</span>
						);
						return (
							<article key={refKey(entry)} className="team-collaboration-row">
								<input
									aria-label={`选择 ${entry.title}`}
									type="checkbox"
									checked={selected.has(refKey(entry))}
									onChange={(event) =>
										setSelected((previous) => {
											const next = new Set(previous);
											if (event.target.checked) next.add(refKey(entry));
											else next.delete(refKey(entry));
											return next;
										})
									}
								/>
								<div>
									<h3>
										{entry.title}
										{statusTag}
									</h3>
									<p>{entry.excerpt}</p>
									<small>
										{names[entry.resource]} · {entry.review.proposedBy}
									</small>
								</div>
								<div className="team-collaboration-actions">
									<button
										type="button"
										className="avant-btn avant-btn-sm avant-btn-secondary"
										onClick={() => void open(entry, tab === "review")}
									>
										<BookOpen size={12} />
										{entry.resource === "papers"
											? tab === "review"
												? "查看并审核"
												: "查看详情"
											: tab === "review"
												? "阅读并审核"
												: "阅读正文"}
									</button>
									{tab === "review" && (
										<button
											type="button"
											className="avant-btn avant-btn-sm avant-btn-secondary"
											onClick={() => void openDiscussion(entry)}
										>
											<MessagesSquare size={12} />
											评论与指派
										</button>
									)}
									{tab === "published" && (
										<a
											className="avant-btn avant-btn-sm avant-btn-subtle"
											href={`/api/team/content-export/${entry.resource}/${encodeURIComponent(entry.id)}`}
										>
											<Download size={12} />
											导出快照
										</a>
									)}
								</div>
							</article>
						);
					})}
					{!loading && !content.length && (
						<EmptyState
							title="暂无匹配内容"
							text={tab === "review" ? "当前类型没有待审提案。" : "尝试其他关键词或内容类型。"}
						/>
					)}
				</div>
			)}
			{tab === "mine" && (
				<div className="team-collaboration-list">
					{visibleSubmissions.map((entry) => {
						const outcomeTag =
							entry.status === "approved" ? (
								<span className="collab-status-tag published">{outcomes[entry.status]}</span>
							) : entry.status === "rejected" ? (
								<span className="collab-status-tag rejected">{outcomes[entry.status]}</span>
							) : entry.status === "pending" ? (
								<span className="collab-status-tag pending">{outcomes[entry.status]}</span>
							) : (
								<span className="collab-status-tag neutral">{outcomes[entry.status]}</span>
							);
						return (
							<article className="team-collaboration-row" key={`${refKey(entry)}:${entry.version}`}>
								<div>
									<h3>
										{entry.title}
										{outcomeTag}
									</h3>
									<p>
										{names[entry.resource]} · {new Date(entry.updatedAt).toLocaleString()}
									</p>
									{entry.reason && <p>审核反馈：{entry.reason}</p>}
								</div>
								<div className="team-collaboration-actions">
									<button
										type="button"
										className="avant-btn avant-btn-sm avant-btn-secondary"
										onClick={() => void open(entry, true, entry.version)}
									>
										<Eye size={12} />
										查看此版本
									</button>
									<button
										type="button"
										className="avant-btn avant-btn-sm avant-btn-secondary"
										onClick={() => void openDiscussion(entry)}
									>
										<MessagesSquare size={12} />
										讨论与历史
									</button>
									{entry.status === "pending" && (
										<button
											type="button"
											className="avant-btn avant-btn-sm avant-btn-secondary danger-hover"
											disabled={busy}
											onClick={() =>
												void prepare("/api/team/collaboration", {
													resource: entry.resource,
													id: entry.id,
													action: "withdraw",
													expectedVersion: entry.version,
												})
											}
										>
											<Undo2 size={12} />
											撤回提案
										</button>
									)}
								</div>
							</article>
						);
					})}
					{!loading && !visibleSubmissions.length && (
						<EmptyState title="还没有此状态的提案" text="在下方选择个人论文、笔记或材料，提交后可在这里跟踪。" />
					)}
				</div>
			)}
			{tab === "notifications" && (
				<>
					<div>
						<button
							type="button"
							className="avant-btn avant-btn-secondary"
							disabled={busy || !notifications.some((entry) => !entry.readAt)}
							onClick={() =>
								void prepare("/api/team/notifications/read", {
									ids: notifications.filter((entry) => !entry.readAt).map((entry) => entry.id),
								})
							}
						>
							<CheckCheck size={14} />
							将当前列表标为已读
						</button>
					</div>
					<div className="team-collaboration-list">
						{notifications.map((entry) => (
							<article className={`team-collaboration-row ${entry.readAt ? "" : "unread"}`} key={entry.id}>
								<div>
									<h3>
										{entry.title}
										{!entry.readAt && <span className="collab-unread-dot">未读</span>}
									</h3>
									<p>{entry.message}</p>
									<small>{new Date(entry.at).toLocaleString()}</small>
								</div>
								<div className="team-collaboration-actions">
									<button
										type="button"
										className="avant-btn avant-btn-sm avant-btn-secondary"
										onClick={() => void openDiscussion({ resource: entry.resource, id: entry.targetId })}
									>
										<MessageSquare size={12} />
										查看反馈
									</button>
								</div>
							</article>
						))}
						{!loading && !notifications.length && (
							<EmptyState title="暂无通知" text="审核结果、评论与指派动态会在此聚合展示。" />
						)}
					</div>
				</>
			)}
			{tab === "topics" && (
				<>
					{canReview && (
						<div>
							<button type="button" className="avant-btn avant-btn-primary" onClick={() => void chooseTopic()}>
								<Plus size={14} />
								创建专题
							</button>
						</div>
					)}
					<div className="team-collaboration-list">
						{topics.map((topic) => (
							<article className="team-collaboration-row" key={topic.id}>
								<div>
									<h3>
										<FolderOpen size={14} />
										{topic.title}
									</h3>
									<p>{topic.description}</p>
									<small>{topic.entries.length} 条已发布内容</small>
								</div>
								<div className="team-collaboration-actions">
									<button
										type="button"
										className="avant-btn avant-btn-sm avant-btn-secondary"
										onClick={() => {
											setTopicId(topic.id);
											setKind(topic.entries[0]?.resource ?? "pages");
											setTab("published");
										}}
									>
										<ArrowRight size={12} />
										浏览专题
									</button>
									{canReview && (
										<>
											<button
												type="button"
												className="avant-btn avant-btn-sm avant-btn-secondary"
												onClick={() => void chooseTopic(topic)}
											>
												<Pencil size={12} />
												编辑专题
											</button>
											<button
												type="button"
												className="avant-btn avant-btn-sm avant-btn-secondary danger-hover"
												onClick={() =>
													void prepare("/api/team/topics", {
														id: topic.id,
														expectedVersion: topic.version,
														delete: true,
													})
												}
											>
												<Trash2 size={12} />
												删除专题
											</button>
										</>
									)}
								</div>
							</article>
						))}
						{!loading && !topics.length && (
							<EmptyState title="暂无专题集合" text="专题用于把已发布内容组织成可分享的阅读合集。" />
						)}
					</div>
				</>
			)}
			{(pageIndex > 0 || hasNextPage) && (
				<div className="collab-load-more-wrap collab-pager">
					<button
						type="button"
						className="avant-btn avant-btn-secondary"
						disabled={loading || pageIndex === 0}
						onClick={() => goToPage(pageIndex - 1)}
					>
						上一页
					</button>
					<span className="collab-total-tag">
						第 {pageIndex + 1} 页{total > 0 ? ` · 共 ${Math.ceil(total / PAGE_SIZE)} 页` : ""}
					</span>
					<button
						type="button"
						className="avant-btn avant-btn-secondary"
						disabled={loading || !hasNextPage}
						onClick={() => goToPage(pageIndex + 1)}
					>
						下一页
					</button>
				</div>
			)}
			{active && (
				<AccessibleModal
					title={active.title}
					onClose={() => setActive(undefined)}
					maxWidth={1100}
					className="team-content-dialog"
				>
					<p className="collab-total-tag">
						内容版本：<code>{active.version}</code>
					</p>
					<div className={active.approvedContent ? "team-content-comparison" : ""}>
						{Boolean(active.approvedContent) && (
							<section>
								<h4>已发布版本</h4>
								<TeamSnapshotBody resource={active.resource} content={active.approvedContent} />
							</section>
						)}
						<section>
							<h4>
								{active.approvedContent ? "待审修订" : active.resource === "papers" ? "论文记录" : "内容正文"}
							</h4>
							<TeamSnapshotBody resource={active.resource} content={active.content} />
						</section>
					</div>
					{error && (
						<p role="alert" className="team-collaboration-error">
							<XCircle size={15} />
							{error}
						</p>
					)}
					{activePaperIds.length > 0 && (
						<div className="team-collaboration-toolbar">
							{activePaperIds.map((id) => (
								<button
									type="button"
									className="avant-btn avant-btn-sm avant-btn-secondary"
									key={id}
									onClick={() => void open({ resource: "papers", id })}
								>
									<FileText size={12} />
									关联论文：{id}
								</button>
							))}
						</div>
					)}
					{tab === "review" && canReview && activePending && (
						<div className="team-collaboration-toolbar">
							<label className="collab-field">
								<span>
									<MessageSquare size={12} /> 审核理由
								</span>
								<input
									className="avant-input"
									value={reason}
									onChange={(event) => setReason(event.target.value)}
								/>
							</label>
							<button
								type="button"
								className="avant-btn avant-btn-primary"
								disabled={busy}
								onClick={() => review([active], "team-approved")}
							>
								<Check size={14} />
								批准此版本
							</button>
							<button
								type="button"
								className="avant-btn avant-btn-danger"
								disabled={busy}
								onClick={() => review([active], "team-rejected")}
							>
								<X size={14} />
								拒绝此版本
							</button>
							<button
								type="button"
								className="avant-btn avant-btn-secondary"
								disabled={busy || !reason.trim()}
								onClick={() =>
									void prepare("/api/team/collaboration", {
										resource: active.resource,
										id: active.id,
										action: "request-changes",
										text: reason,
										expectedVersion: active.version,
									})
								}
							>
								<Undo2 size={14} />
								退回修改
							</button>
						</div>
					)}
				</AccessibleModal>
			)}
			{discussion && (
				<AccessibleModal
					title={`提案反馈 · ${discussion.current.title}`}
					onClose={() => setDiscussion(undefined)}
					maxWidth={900}
				>
					<p className="collab-total-tag">
						当前状态：{outcomes[discussion.current.status]} · 审核负责人：
						{discussion.assignedTo?.name ?? "未指派"}
					</p>
					{discussion.current.reason && (
						<p className="collab-message">
							<Info size={15} />
							审核反馈：{discussion.current.reason}
						</p>
					)}
					{canReview && (
						<div className="team-collaboration-toolbar">
							<label className="collab-field">
								<span>
									<UserCheck size={12} /> 指派审核者
								</span>
								<select
									className="avant-select"
									value={assignee}
									onChange={(event) => setAssignee(event.target.value)}
								>
									<option value="">未指派</option>
									{reviewers.map((member) => (
										<option value={member.id} key={member.id}>
											{member.name}
										</option>
									))}
								</select>
							</label>
							<button
								type="button"
								className="avant-btn avant-btn-primary"
								disabled={busy}
								onClick={() =>
									void prepare("/api/team/collaboration", {
										resource: discussion.resource,
										id: discussion.id,
										action: "assign",
										assigneeId: assignee || null,
										expectedVersion: discussion.version,
									})
								}
							>
								<UserCheck size={14} />
								保存指派
							</button>
						</div>
					)}
					{discussion.comments.map((entry) => (
						<article className="team-collaboration-comment" key={entry.id}>
							<span className="comment-avatar" aria-hidden="true">
								{entry.author.name.trim().charAt(0).toUpperCase() || "·"}
							</span>
							<div>
								<strong>{entry.author.name}</strong>
								<small>{new Date(entry.at).toLocaleString()}</small>
								<p>{entry.text}</p>
							</div>
						</article>
					))}
					<label className="collab-field">
						<span>
							<MessageSquare size={12} /> 添加评论
						</span>
						<textarea
							className="avant-input"
							value={comment}
							onChange={(event) => setComment(event.target.value)}
							maxLength={10000}
							rows={3}
						/>
					</label>
					<div>
						<button
							type="button"
							className="avant-btn avant-btn-primary"
							disabled={busy || !comment.trim()}
							onClick={() =>
								void prepare("/api/team/collaboration", {
									resource: discussion.resource,
									id: discussion.id,
									action: "comment",
									text: comment,
									expectedVersion: discussion.version,
								})
							}
						>
							<Send size={14} />
							预览评论
						</button>
					</div>
					<details className="collab-version-history">
						<summary>版本历史（{discussion.history.length + 1}）</summary>
						{[discussion.current, ...discussion.history].map((entry) => (
							<p key={entry.version}>
								<button
									type="button"
									className="avant-btn avant-btn-xs avant-btn-secondary"
									onClick={() => void open(entry, true, entry.version)}
								>
									{new Date(entry.proposedAt).toLocaleString()} · {outcomes[entry.status]}
								</button>{" "}
								{entry.reason}
							</p>
						))}
					</details>
				</AccessibleModal>
			)}
			{editingTopic && (
				<AccessibleModal
					title={editingTopic.expectedVersion ? "编辑团队专题" : "创建团队专题"}
					onClose={() => setEditingTopic(undefined)}
					maxWidth={900}
				>
					<label className="collab-field">
						<span>
							<FolderOpen size={12} /> 专题名称
						</span>
						<input
							className="avant-input"
							value={editingTopic.title}
							onChange={(event) => setEditingTopic({ ...editingTopic, title: event.target.value })}
							maxLength={200}
						/>
					</label>
					<label className="collab-field">
						<span>
							<FileText size={12} /> 专题说明
						</span>
						<textarea
							className="avant-input"
							value={editingTopic.description}
							onChange={(event) => setEditingTopic({ ...editingTopic, description: event.target.value })}
							maxLength={2000}
						/>
					</label>
					<p>选择已发布内容（已选 {editingTopic.entries.length} 条）</p>
					<div className="team-topic-choices">
						{visibleTopicChoices.map((entry) => (
							<label key={refKey(entry)}>
								<input
									type="checkbox"
									checked={editingTopic.entries.some((ref) => refKey(ref) === refKey(entry))}
									onChange={(event) =>
										setEditingTopic({
											...editingTopic,
											entries: event.target.checked
												? [...editingTopic.entries, { resource: entry.resource, id: entry.id }]
												: editingTopic.entries.filter((ref) => refKey(ref) !== refKey(entry)),
										})
									}
								/>
								{names[entry.resource]} · {entry.title}
							</label>
						))}
					</div>
					{choiceCursor && (
						<button
							type="button"
							className="avant-btn avant-btn-secondary"
							onClick={() =>
								void api<TeamListPage<TeamContentSummary>>(
									`/api/team/content?limit=100&cursor=${encodeURIComponent(choiceCursor)}`,
								)
									.then((page) => {
										setTopicChoices((previous) => [...previous, ...page.entries]);
										setChoiceCursor(page.nextCursor);
									})
									.catch((failure: Error) => setError(failure.message))
							}
						>
							<RefreshCw size={13} />
							加载更多可选内容
						</button>
					)}
					<div>
						<button
							type="button"
							className="avant-btn avant-btn-primary"
							disabled={busy || !editingTopic.title.trim()}
							onClick={() => void prepare("/api/team/topics", editingTopic)}
						>
							<Save size={14} />
							预览保存专题
						</button>
					</div>
				</AccessibleModal>
			)}
			{pending && (
				<TeamOperationModal
					key={pending.operation.operationId}
					operation={pending.operation}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={execute}
				/>
			)}
			{artifactSources && (
				<AccessibleModal title="提交个人材料清单" onClose={() => setArtifactSources(undefined)} maxWidth={900}>
					<p>个人空间：{personalNamespace}。选择已经完成发现或获取的材料清单，预览后提交审核。</p>
					{artifactSources.map((entry) => (
						<article className="team-collaboration-row" key={`${entry.paperId}:${entry.pdfSha256}`}>
							<div>
								<h3>{entry.title}</h3>
								<p>
									{entry.candidates} 个来源 · {entry.acquisitions} 个获取结果 ·{" "}
									{new Date(entry.discoveredAt).toLocaleString()}
								</p>
							</div>
							<div className="team-collaboration-actions">
								<button
									type="button"
									className="avant-btn avant-btn-sm avant-btn-primary"
									disabled={busy}
									onClick={() =>
										void prepare("/api/team/artifacts", {
											paperId: entry.paperId,
											manifestSha256: entry.pdfSha256,
											personalNamespace,
										})
									}
								>
									<UploadCloud size={12} />
									预览提交
								</button>
							</div>
						</article>
					))}
					{!artifactSources.length && (
						<EmptyState title="暂无已保存的材料清单" text="请先在 PDF 工作台发现或获取论文材料。" />
					)}
					{artifactCursor && (
						<div className="collab-load-more-wrap">
							<button
								type="button"
								className="avant-btn avant-btn-secondary"
								onClick={() => void loadArtifacts(artifactCursor)}
							>
								<RefreshCw size={13} />
								加载更多
							</button>
						</div>
					)}
				</AccessibleModal>
			)}
		</section>
	);
}
