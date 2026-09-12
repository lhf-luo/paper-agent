import "./team-page.css";
import {
	Activity,
	AlertCircle,
	ArrowUpRight,
	BookOpen,
	Building,
	Calendar,
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Clock,
	Compass,
	Copy,
	Database,
	Download,
	ExternalLink,
	Eye,
	FileCheck,
	FileCode,
	FileStack,
	FileText,
	GitCompare,
	GitPullRequest,
	Info,
	Key,
	Layers,
	Lock,
	Pause,
	Play,
	Radio,
	RefreshCw,
	RotateCcw,
	Search,
	Send,
	ShieldAlert,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Trash2,
	Unlock,
	UploadCloud,
	Users,
	X,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TeamPageSourcesInput, TeamReviewSnapshot } from "../../src/team/domain/team-corpus-types";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation, EmptyState, LoadingBlock, StatusPill } from "./components";
import { useRouterContext } from "./router";
import type { ConfirmationGrant, PaperRecord, PreparedOperation } from "./types";
import { TeamKnowledgeDialog, type TeamKnowledgeValue } from "./team-content-view";
import { useWorkspace } from "./workspace-context";
import { TeamCollaborationPanel } from "./team-collaboration-panel";
import { TeamOperationPreview } from "./team-operation-preview";
import { TeamMembersPanel } from "./team-members-panel";

interface ToastItem {
	id: string;
	type: "success" | "error" | "info" | "warning";
	title?: string;
	message: string;
	timestamp: number;
}

interface FieldDiffEntry {
	field: string;
	label: string;
	approved: string | string[];
	proposed: string | string[];
	changed: boolean;
}

function normalizeDoi(doi?: string): string | undefined {
	if (!doi) return undefined;
	const match = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/.exec(doi.trim());
	return match ? match[0].toLowerCase() : doi.trim().toLowerCase();
}

function normalizeArxivId(arxivId?: string): string | undefined {
	if (!arxivId) return undefined;
	return arxivId
		.trim()
		.replace(/^arxiv:\s*/i, "")
		.toLowerCase();
}

function normalizeSearchText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s\-_.:/]+/g, " ")
		.trim();
}

function formatConnectionReason(reason?: string, status?: number): { title: string; detail: string; hint: string } {
	if (!reason) {
		return {
			title: "未连接到团队协作服务",
			detail: "当前未检测到团队协作服务端连接。配置并验证接入凭证后方可开启团队跨设备文献共享与集中管理。",
			hint: "请在左侧导航“系统设置”中绑定团队接入凭证 (pateam1. 格式)。",
		};
	}
	const lower = reason.toLowerCase();
	if (lower.includes("method not allowed") || status === 405) {
		return {
			title: "服务端接口协议不匹配 (HTTP 405)",
			detail: "远程团队服务端正在运行，但部分新特性接口（如页面同步或扩展资产）在服务端未启用或服务端版本待升级。",
			hint: "系统已自动启用向下兼容模式；如需体验全部功能，建议联系服务端管理员更新版本。",
		};
	}
	if (lower.includes("not configured")) {
		return {
			title: "尚未配置团队接入信息",
			detail: "本机尚未配置团队服务器地址与接入凭据。个人文献库内容保存在本地。",
			hint: "请联系实验室管理员获取专属 pateam1. 接入串，在“设置”页中完成粘贴绑定。",
		};
	}
	if (
		lower.includes("fetch failed") ||
		lower.includes("econnrefused") ||
		lower.includes("failed to fetch") ||
		lower.includes("network")
	) {
		return {
			title: "远程服务器网络无法连通",
			detail: `无法与指定的团队服务器地址建立连接 (${reason})。可能因网络环境切换、服务器维护或端口限制导致。`,
			hint: "请确认当前设备可连通该服务器 IP/域名，且对应端口允许入站连接。",
		};
	}
	if (lower.includes("unauthorized") || lower.includes("invalid token") || status === 401) {
		return {
			title: "接入凭证无效或已过期 (HTTP 401)",
			detail: "当前持有的团队访问令牌已被注销、过期或与目标命名空间不匹配。",
			hint: "请联系管理员重新签发团队接入令牌并在“设置”中更新保存。",
		};
	}
	if (lower.includes("forbidden") || status === 403) {
		return {
			title: "团队命名空间访问受限 (HTTP 403)",
			detail: "当前身份认证成功，但未分配当前命名空间的读取或管理权限。",
			hint: "请联系团队管理员为您的用户分配 reader 或 contributor 角色。",
		};
	}
	return {
		title: "团队连接异常",
		detail: reason,
		hint: "请检查网络连接或在“设置”中重新检测团队接入配置。",
	};
}

function createDemoPaper(
	id: string,
	title: string,
	authors: string[],
	year: number,
	venue: string,
	abstract: string,
	tags: string[],
	arxivId: string,
	doi?: string,
): PaperRecord {
	return {
		id,
		title,
		authors,
		year,
		venue,
		abstract,
		identifiers: {
			arxivId,
			doi,
		},
		links: [{ url: `https://arxiv.org/abs/${arxivId}`, kind: "arxiv", openAccess: true }],
		provenance: [{ provider: "arxiv", query: id, retrievedAt: new Date().toISOString() }],
		curation: {
			tags,
			userNotes: [],
			screening: { status: "included" },
		},
	};
}

const MOCK_DEMO_OVERVIEW = {
	configured: true,
	connected: true,
	isDemoPreview: true,
	source: "demo",
	serverUrl: "https://hub.paper-agent.internal:14713",
	namespace: "lab-core",
	health: { status: "ok", version: "0.2.0" },
	identity: {
		id: "usr_demo",
		name: "Demo Researcher (交互式演示)",
		roles: ["admin", "reviewer", "contributor", "reader"],
	},
	capabilities: {
		canRead: true,
		canContribute: true,
		canReview: true,
		canAdmin: true,
	},
	unavailable: [] as string[],
	stats: {
		manifest: { recordCount: 3 },
		totalPapers: 128,
		derivedCount: 1,
		artifactCount: 1,
		pendingCount: 1,
	},
	papers: [
		createDemoPaper(
			"paper_transformer_2017",
			"Attention Is All You Need",
			["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones"],
			2017,
			"NeurIPS 2017",
			"The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
			["transformer", "nlp", "self-attention"],
			"1706.03762",
			"10.48550/arXiv.1706.03762",
		),
		createDemoPaper(
			"paper_resnet_2015",
			"Deep Residual Learning for Image Recognition",
			["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"],
			2015,
			"CVPR 2016",
			"Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.",
			["computer-vision", "resnet", "deep-learning"],
			"1512.03385",
			"10.1109/CVPR.2016.90",
		),
		createDemoPaper(
			"paper_gpt3_2020",
			"Language Models are Few-Shot Learners",
			["Tom B. Brown", "Benjamin Mann", "Nick Ryder", "Melanie Subbiah"],
			2020,
			"NeurIPS 2020",
			"Recent work has demonstrated substantial gains on many NLP tasks and benchmarks by pre-training on a large corpus of text followed by fine-tuning on a specific task.",
			["llm", "few-shot", "foundation-models"],
			"2005.14165",
		),
	],
	pendingPapers: [
		createDemoPaper(
			"paper_flash_attention_2022",
			"FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
			["Tri Dao", "Daniel Y. Fu", "Stefano Ermon", "Atri Rudra", "Christopher Ré"],
			2022,
			"NeurIPS 2022",
			"Transformers are slow and memory-hungry on long sequences. We propose FlashAttention, an IO-aware exact attention algorithm that uses tiling to reduce memory reads/writes.",
			["attention", "cuda", "hardware-efficiency"],
			"2205.14135",
		),
	],
	myProposals: [] as PaperRecord[],
	derived: [
		{
			key: "method_summary:transformer",
			operation: "method-summary",
			paperId: "paper_transformer_2017",
			createdAt: "2026-03-10T08:30:00.000Z",
			review: { status: "team-approved" },
		},
	],
	artifacts: [
		{
			key: "artifact:attention_visualizer",
			title: "Multi-Head Attention Heatmap Tool",
			paperId: "paper_transformer_2017",
			review: { status: "team-approved" },
			createdAt: "2026-03-11T10:00:00.000Z",
		},
	],
	pages: [
		{
			id: "page_notes_transformer",
			title: "Transformer 架构复现与关键超参数指南",
			type: "research-note",
			review: { status: "team-approved" },
			updatedAt: "2026-03-11T12:00:00.000Z",
		},
	],
	events: [
		{
			id: "evt_001",
			type: "paper.approved",
			paperId: "paper_transformer_2017",
			timestamp: "2026-03-10T09:00:00.000Z",
			actor: "admin",
		},
		{
			id: "evt_002",
			type: "proposal.submitted",
			paperId: "paper_flash_attention_2022",
			timestamp: "2026-03-11T14:20:00.000Z",
			actor: "contributor",
		},
	],
	identities: [
		{ id: "usr_001", name: "Alice (Principal Investigator)", roles: ["admin"] },
		{ id: "usr_002", name: "Bob (Postdoc Fellow)", roles: ["reviewer", "contributor"] },
		{ id: "usr_003", name: "Carol (PhD Student)", roles: ["contributor", "reader"] },
	],
};

export function TeamPage() {
	const [knowledge, setKnowledge] = useState<TeamKnowledgeValue>();
	const [knowledgePrevious, setKnowledgePrevious] = useState<TeamKnowledgeValue>();
	// Overview & identity state
	const [rawOverview, setOverview] = useState<any>();
	const [demoMode, setDemoMode] = useState(false);
	const overview = rawOverview;
	const [personal, setPersonal] = useState<PaperRecord[]>([]);
	const [personalPaperPdfs, setPersonalPaperPdfs] = useState<Record<string, number>>({});
	const [selectedPersonal, setSelectedPersonal] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingRequest, setPendingRequest] = useState<{ path: string; payload: Record<string, unknown> }>();
	const [busy, setBusy] = useState(false);

	// Multi-Toast notification system (replaces single global error/message banner)
	const [toasts, setToasts] = useState<ToastItem[]>([]);

	const pushToast = useCallback((type: ToastItem["type"], message: string, title?: string) => {
		const id = Math.random().toString(36).slice(2, 9);
		setToasts((prev) => [...prev, { id, type, title, message, timestamp: Date.now() }]);
		setTimeout(() => {
			setToasts((prev) => prev.filter((item) => item.id !== id));
		}, 6000);
	}, []);

	const removeToast = useCallback((id: string) => {
		setToasts((prev) => prev.filter((item) => item.id !== id));
	}, []);

	const { namespace: workspaceNamespace } = useWorkspace();
	const { params, updateParams, navigate } = useRouterContext();

	// Member identity administration
	const [oneTimeToken, setOneTimeToken] = useState("");
	const [personalNamespace, setPersonalNamespace] = useState(() => workspaceNamespace || "default");
	const [personalNamespaces, setPersonalNamespaces] = useState<string[]>(["default"]);

	useEffect(() => {
		if (workspaceNamespace) setPersonalNamespace(workspaceNamespace);
	}, [workspaceNamespace]);

	// Blob uploads & multi-modal asset proposals
	const [blobPaperId, setBlobPaperId] = useState("");
	const [blobVersions, setBlobVersions] = useState<any[]>([]);
	const [blobLoading, setBlobLoading] = useState(false);
	const [backupPath, setBackupPath] = useState("");
	const [assetTab, setAssetTab] = useState<"blob" | "derived" | "pages">("blob");

	// Search console state (P1: complete search filters)
	const [teamQuery, setTeamQuery] = useState("");
	const [teamAuthor, setTeamAuthor] = useState("");
	const [teamVenue, setTeamVenue] = useState("");
	const [teamYearFrom, setTeamYearFrom] = useState("");
	const [teamYearTo, setTeamYearTo] = useState("");
	const [teamType, setTeamType] = useState("");
	const [teamOpenAccess, setTeamOpenAccess] = useState<"all" | "true" | "false">("all");
	const [teamStatus, setTeamStatus] = useState<string>("");
	const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
	const [teamSearchResults, setTeamSearchResults] = useState<PaperRecord[]>([]);
	const [teamSearchCursor, setTeamSearchCursor] = useState<string>();
	const [teamSearchLoading, setTeamSearchLoading] = useState(false);

	// SEPARATE SELECTION SETS (P2: no more mutual wiping!)
	const [searchPullSelection, setSearchPullSelection] = useState<Set<string>>(new Set());
	const [sharedPullSelection, setSharedPullSelection] = useState<Set<string>>(new Set());
	const [includePdf, setIncludePdf] = useState(false);
	const [pullResult, setPullResult] = useState<any>();

	// Shared papers & pagination
	const [sharedPapers, setSharedPapers] = useState<PaperRecord[]>([]);
	const [sharedCursor, setSharedCursor] = useState<string>();

	// Derived memory
	const [personalDerived, setPersonalDerived] = useState<
		Array<{ key: string; operation: string; paperId: string; createdAt: string }>
	>([]);
	const [derivedSelection, setDerivedSelection] = useState<Set<string>>(new Set());

	// Personal knowledge pages (research notes + wiki pages) proposed as team snapshots
	const [personalPages, setPersonalPages] = useState<{
		notes: Array<{ id: string; title: string; revision: number; contentHash: string; updatedAt: string }>;
		wikiPages: Array<{ id: string; title: string; type: string; status: string; contentHash: string }>;
	}>({ notes: [], wikiPages: [] });
	const [pageSelection, setPageSelection] = useState<Set<string>>(new Set());

	// Review selection & individual reasons (P0 & P2)
	const [reviewSelection, setReviewSelection] = useState<Record<string, Set<string>>>({
		papers: new Set(),
		derived: new Set(),
		artifacts: new Set(),
		pages: new Set(),
	});
	const [itemReasons, setItemReasons] = useState<Record<string, string>>({});
	const [batchReason, setBatchReason] = useState("");

	// Review tab synchronized with URL (?queue=derived)
	const [reviewTab, setReviewTabState] = useState<"papers" | "derived" | "artifacts" | "pages">(() => {
		const q = params.queue;
		if (q === "derived" || q === "artifacts" || q === "pages") return q;
		return "papers";
	});

	const setReviewTab = useCallback(
		(next: "papers" | "derived" | "artifacts" | "pages") => {
			setReviewTabState(next);
			updateParams({ queue: next });
		},
		[updateParams],
	);

	// Revision Diff state synchronized with URL (?diffPaper=id)
	const [activeDiffPaper, setActiveDiffPaperState] = useState<PaperRecord | null>(null);
	const setActiveDiffPaper = useCallback(
		(paper: PaperRecord | null) => {
			setActiveDiffPaperState(paper);
			updateParams({ diffPaper: paper ? paper.id : null });
		},
		[updateParams],
	);
	const [approvedPaperCache, setApprovedPaperCache] = useState<Record<string, PaperRecord>>({});
	const [diffLoading, setDiffLoading] = useState(false);

	// Expanded abstract accordion state for paper cards
	const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());

	// Batch review confirmation modal state
	const [batchConfirm, setBatchConfirm] = useState<{
		resource: "papers" | "derived" | "artifacts" | "pages";
		decision: "team-approved" | "team-rejected";
		ids: string[];
		reason: string;
	} | null>(null);

	// Keyboard accessibility: Escape to close modals
	useEffect(() => {
		if (!activeDiffPaper && !batchConfirm) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (activeDiffPaper) setActiveDiffPaper(null);
				if (batchConfirm) setBatchConfirm(null);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [activeDiffPaper, batchConfirm, setActiveDiffPaper]);

	// LIVE SYNC POLLING ENGINE (P1: 30-45s real-time sync)
	const [autoSync, setAutoSync] = useState(true);
	const [, setLastSyncedAt] = useState<Date>(new Date());
	const [isSyncing, setIsSyncing] = useState(false);
	const syncTimerRef = useRef<number | null>(null);
	// Guards the "已共享论文" first-page seed so silent 30s polls never wipe "load more" progress.
	const sharedSeededRef = useRef(false);

	// Fetch team overview without wiping user form state or selections
	const load = useCallback(
		async (silent = false) => {
			if (!silent) setIsSyncing(true);
			try {
				const [team, library, namespaces] = await Promise.all([
					api<any>("/api/team/overview"),
					silent
						? Promise.resolve(null)
						: api<{ hits: Array<{ record: PaperRecord }> }>(
								`/api/library?namespace=${encodeURIComponent(personalNamespace)}&limit=100`,
							),
					silent
						? Promise.resolve(null)
						: api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces"),
				]);
				setOverview(team);
				if (library) {
					const records = library.hits.map((hit) => hit.record);
					setPersonal(records);
					setBlobPaperId((current) =>
						current && records.some((record) => record.id === current) ? current : (records[0]?.id ?? ""),
					);
				}
				if (namespaces) {
					setPersonalNamespaces(namespaces.personal);
					if (
						!namespaces.personal.includes(personalNamespace) &&
						namespaces.personal.includes(namespaces.defaultNamespace)
					) {
						setPersonalNamespace(namespaces.defaultNamespace);
					}
				}

				// Cache approved papers from overview into approvedPaperCache
				if (Array.isArray(team.papers)) {
					setApprovedPaperCache((prev) => {
						const next = { ...prev };
						for (const p of team.papers) {
							next[p.id] = p;
						}
						return next;
					});
					// Seed the shared-papers list on the first load and on explicit (non-silent) refresh,
					// but NOT on 30s background polls — otherwise "load more" progress is wiped every cycle.
					if (!silent || !sharedSeededRef.current) {
						setSharedPapers(team.papers);
						setSharedCursor(team.papers.length >= 50 ? "50" : undefined);
						sharedSeededRef.current = true;
					}
				}

				setLastSyncedAt(new Date());
			} catch (reason) {
				const msg = reason instanceof Error ? reason.message : String(reason);
				if (!silent) pushToast("error", msg, "同步失败");
			} finally {
				if (!silent) setIsSyncing(false);
			}
		},
		[personalNamespace, pushToast],
	);

	// Initial load
	useEffect(() => {
		void load();
	}, [load]);

	// Auto-polling interval (every 30 seconds when tab is active)
	useEffect(() => {
		if (!autoSync) {
			if (syncTimerRef.current) window.clearInterval(syncTimerRef.current);
			return;
		}
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void load(true);
			}
		}, 30_000);
		syncTimerRef.current = interval;
		return () => window.clearInterval(interval);
	}, [autoSync, load]);

	const enterDemoMode = useCallback(() => {
		setDemoMode(true);
		setSharedPapers(MOCK_DEMO_OVERVIEW.papers);
		pushToast("info", "已进入交互式演示导览模式，所有功能模块已填充沙箱数据。", "演示导览生效");
	}, [pushToast]);

	const exitDemoMode = useCallback(() => {
		setDemoMode(false);
		setSharedPapers(rawOverview?.papers ?? []);
		void load();
	}, [rawOverview, load]);

	// Detect PDF versions for selected personal papers to advise contributor (P2)
	const inspectPersonalPdfs = useCallback(
		async (papers: PaperRecord[]) => {
			for (const paper of papers.slice(0, 40)) {
				try {
					const res = await api<any>(
						`/api/papers/${encodeURIComponent(paper.id)}?namespace=${encodeURIComponent(personalNamespace)}`,
					);
					if (res?.versions && Array.isArray(res.versions)) {
						setPersonalPaperPdfs((prev) => ({ ...prev, [paper.id]: res.versions.length }));
					}
				} catch {
					// Non-critical background inspection
				}
			}
		},
		[personalNamespace],
	);

	useEffect(() => {
		if (personal.length) {
			void inspectPersonalPdfs(personal);
		}
	}, [personal, inspectPersonalPdfs]);

	// Operation preparation and execution
	const prepare = async (preparePath: string, executePath: string, payload: Record<string, unknown>) => {
		if (demoMode) {
			pushToast("info", "导览只展示示例，请接入团队服务后执行操作。");
			return;
		}
		setBusy(true);
		setPending(undefined);
		setPendingRequest(undefined);
		try {
			const prep = await api<PreparedOperation>(preparePath, jsonBody(payload));
			setPendingRequest({ path: executePath, payload });
			setPending(prep);
			setBatchConfirm(null);
			setActiveDiffPaper(null);
			setKnowledge(undefined);
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason), "操作预检失败");
		} finally {
			setBusy(false);
		}
	};

	const execute = async () => {
		if (!pending || !pendingRequest) return;
		setBusy(true);
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const result = await api<any>(pendingRequest.path, jsonBody({ ...pendingRequest.payload, grant }));
			if (typeof result.invite === "string") setOneTimeToken(result.invite);
			if (typeof result.backupPath === "string") setBackupPath(result.backupPath);
			if (typeof result.pulled === "number" && Array.isArray(result.pdfs)) setPullResult(result);

			const failedPdfs: any[] = Array.isArray(result.pdfs)
				? result.pdfs.filter((entry: any) => entry.status === "failed")
				: [];

			const successMessage = result.invite
				? "团队接入串仅显示这一次，请立即复制并交给对应成员。"
				: typeof result.pulled === "number"
					? `已拉取 ${result.pulled} 篇团队论文到个人库：新建 ${result.created?.length ?? 0}、更新 ${
							result.updated?.length ?? 0
						}、未变化 ${result.unchanged?.length ?? 0}${
							failedPdfs.length
								? `；${failedPdfs.length} 篇 PDF 失败：${failedPdfs
										.map((entry) => `${entry.paperId}（${entry.reason}）`)
										.join("、")}`
								: includePdf
									? "；PDF 已写入个人库。"
									: "。"
						}`
					: typeof result.withdrawn !== "undefined"
						? `已撤回 ${result.withdrawn.length} 条待审提案。`
						: result.validated
							? `恢复演练通过：${result.stats.recordCount} 篇论文、${result.stats.derivedCount} 条派生记忆、${result.stats.artifactCount} 份 artifact、${result.stats.blobCount} 个 blob。`
							: result.backupPath
								? `团队备份已创建：${result.backupPath}`
								: "团队操作已完成并已记入审计记录。";

			pushToast("success", successMessage, "操作成功");
			setPending(undefined);
			setPendingRequest(undefined);
			setSelectedPersonal(new Set());
			setSearchPullSelection(new Set());
			setSharedPullSelection(new Set());
			setDerivedSelection(new Set());
			setReviewSelection({ papers: new Set(), derived: new Set(), artifacts: new Set(), pages: new Set() });
			setPageSelection(new Set());
			setBatchReason("");
			setItemReasons({});
			await load(true);
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason), "操作执行失败");
			setPending(undefined);
			setPendingRequest(undefined);
			await load(true);
		} finally {
			setBusy(false);
		}
	};

	const copyAndHideToken = async () => {
		if (!oneTimeToken) return;
		try {
			await navigator.clipboard.writeText(oneTimeToken);
			setOneTimeToken("");
			pushToast("success", "团队接入串已复制到剪贴板并从界面隐藏。");
		} catch (reason) {
			pushToast("error", `复制失败：${reason instanceof Error ? reason.message : String(reason)}`);
		}
	};

	const loadBlobVersions = async () => {
		if (!blobPaperId) return;
		setBlobLoading(true);
		try {
			const details = await api<any>(
				`/api/papers/${encodeURIComponent(blobPaperId)}?namespace=${encodeURIComponent(personalNamespace)}`,
			);
			setBlobVersions(details.versions ?? []);
			pushToast("info", `读取到 ${details.versions?.length ?? 0} 个本地 PDF 版本`);
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBlobLoading(false);
		}
	};

	// Full multi-dimensional search (P1)
	const searchTeam = async (cursor?: string) => {
		setTeamSearchLoading(true);
		try {
			const params = new URLSearchParams();
			if (teamQuery.trim()) params.set("q", teamQuery.trim());
			if (teamAuthor.trim()) params.set("author", teamAuthor.trim());
			if (teamVenue.trim()) params.set("venue", teamVenue.trim());
			if (teamYearFrom.trim()) params.set("yearFrom", teamYearFrom.trim());
			if (teamYearTo.trim()) params.set("yearTo", teamYearTo.trim());
			if (teamType.trim()) params.set("type", teamType.trim());
			if (teamOpenAccess !== "all") params.set("openAccess", teamOpenAccess);
			if (teamStatus.trim()) params.set("status", teamStatus.trim());
			params.set("limit", "50");
			if (cursor) params.set("cursor", cursor);

			const result = await api<{ hits: Array<{ record: PaperRecord }>; nextCursor?: string }>(
				`/api/team/search?${params.toString()}`,
			);

			setTeamSearchResults((current) =>
				cursor ? [...current, ...result.hits.map((hit) => hit.record)] : result.hits.map((hit) => hit.record),
			);
			setTeamSearchCursor(result.nextCursor);
			if (!cursor) {
				pushToast("info", `找到 ${result.hits.length} 条检索结果`);
			}
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason), "检索团队论文失败");
		} finally {
			setTeamSearchLoading(false);
		}
	};

	const resetSearch = () => {
		setTeamQuery("");
		setTeamAuthor("");
		setTeamVenue("");
		setTeamYearFrom("");
		setTeamYearTo("");
		setTeamType("");
		setTeamOpenAccess("all");
		setTeamStatus("");
		setTeamSearchResults([]);
		setTeamSearchCursor(undefined);
	};

	const loadMoreShared = async () => {
		setTeamSearchLoading(true);
		try {
			const params = new URLSearchParams({ limit: "50" });
			if (sharedCursor) params.set("cursor", sharedCursor);
			const result = await api<{ hits: Array<{ record: PaperRecord }>; nextCursor?: string }>(
				`/api/team/search?${params.toString()}`,
			);
			setSharedPapers((current) => [...current, ...result.hits.map((hit) => hit.record)]);
			setSharedCursor(result.nextCursor);
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason));
		} finally {
			setTeamSearchLoading(false);
		}
	};

	const loadPersonalDerived = useCallback(async () => {
		try {
			const result = await api<{
				entries: Array<{ key: string; operation: string; paperId: string; createdAt: string }>;
			}>(`/api/team/derived/personal?namespace=${encodeURIComponent(personalNamespace)}`);
			setPersonalDerived(result.entries);
		} catch {
			// Handled quietly
		}
	}, [personalNamespace]);

	useEffect(() => {
		void loadPersonalDerived();
	}, [loadPersonalDerived]);

	const loadPersonalPages = useCallback(async () => {
		try {
			const result = await api<{
				notes: Array<{ id: string; title: string; revision: number; contentHash: string; updatedAt: string }>;
				wikiPages: Array<{ id: string; title: string; type: string; status: string; contentHash: string }>;
			}>(`/api/team/pages/personal?namespace=${encodeURIComponent(personalNamespace)}`);
			setPersonalPages({ notes: result.notes ?? [], wikiPages: result.wikiPages ?? [] });
		} catch {
			// The picker is optional; hide it quietly when the sources cannot be listed.
			setPersonalPages({ notes: [], wikiPages: [] });
		}
	}, [personalNamespace]);

	useEffect(() => {
		void loadPersonalPages();
	}, [loadPersonalPages]);

	// Review single item or batch (P0 & P2)
	const review = (
		resource: "papers" | "derived" | "artifacts" | "pages",
		ids: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
	) => prepare("/api/team/reviews/prepare", "/api/team/reviews/execute", { resource, ids, decision, reason });

	const toggleReview = (resource: "papers" | "derived" | "artifacts" | "pages", id: string, checked: boolean) =>
		setReviewSelection((current) => {
			const next = new Set(current[resource] ?? []);
			if (checked) next.add(id);
			else next.delete(id);
			return { ...current, [resource]: next };
		});

	const selectAllReview = (resource: "papers" | "derived" | "artifacts" | "pages", ids: string[]) =>
		setReviewSelection((current) => ({ ...current, [resource]: new Set(ids) }));

	const clearReviewSelection = (resource: "papers" | "derived" | "artifacts" | "pages") =>
		setReviewSelection((current) => ({ ...current, [resource]: new Set() }));

	// Safety check before batch review (P2)
	const initiateBatchReview = (
		resource: "papers" | "derived" | "artifacts" | "pages",
		decision: "team-approved" | "team-rejected",
	) => {
		const ids = [...(reviewSelection[resource] ?? [])];
		if (!ids.length) {
			pushToast("warning", "请先在审核列表中勾选要操作的条目。");
			return;
		}
		setBatchConfirm({
			resource,
			decision,
			ids,
			reason: batchReason.trim(),
		});
	};

	const pullPapers = (ids: string[]) => {
		if (!ids.length) {
			pushToast("warning", "请先勾选要拉取到个人库的团队论文。");
			return;
		}
		void prepare("/api/team/pull/prepare", "/api/team/pull/execute", {
			paperIds: ids,
			personalNamespace,
			includePdf,
		});
	};

	// Revision Diff Inspector (P0: Approved version vs Pending Revision)
	const openDiff = async (paper: PaperRecord) => {
		setActiveDiffPaper(paper);
		if (!approvedPaperCache[paper.id]) {
			setDiffLoading(true);
			try {
				const approved = await api<PaperRecord>(`/api/team/papers/${encodeURIComponent(paper.id)}`);
				setApprovedPaperCache((prev) => ({ ...prev, [paper.id]: approved }));
			} catch {
				pushToast("warning", "未能在已批准库中找到该论文的基础版本，可能为首发版本。");
			} finally {
				setDiffLoading(false);
			}
		}
	};

	const toggleAbstract = (id: string) => {
		setExpandedAbstracts((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const copyText = (text: string, label = "已复制") => {
		navigator.clipboard.writeText(text);
		pushToast("success", label);
	};

	const openKnowledge = async (value: TeamKnowledgeValue) => {
		const id =
			value.resource === "pages"
				? value.entry.snapshot.key
				: value.resource === "derived"
					? value.entry.record.key
					: value.entry.paperId;
		try {
			const snapshot = await api<TeamReviewSnapshot>(
				`/api/team/content/${value.resource}/${encodeURIComponent(id)}?pending=${value.entry.review.status === "team-proposed"}`,
			);
			setKnowledge({ resource: value.resource, entry: snapshot.content } as TeamKnowledgeValue);
			setKnowledgePrevious(
				snapshot.approvedContent
					? ({ resource: value.resource, entry: snapshot.approvedContent } as TeamKnowledgeValue)
					: undefined,
			);
		} catch (reason) {
			pushToast("error", reason instanceof Error ? reason.message : String(reason), "内容加载失败");
		}
	};

	// Roles & Capabilities
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

	// Field Diff calculation
	const fieldDiffs: FieldDiffEntry[] = useMemo(() => {
		if (!activeDiffPaper) return [];
		const approved = approvedPaperCache[activeDiffPaper.id];
		if (!approved) return [];

		const entries: FieldDiffEntry[] = [];

		// 1. Title
		const titleChanged = normalizeSearchText(approved.title) !== normalizeSearchText(activeDiffPaper.title);
		entries.push({
			field: "title",
			label: "论文标题 (Title)",
			approved: approved.title,
			proposed: activeDiffPaper.title,
			changed: titleChanged,
		});

		// 2. Abstract
		const normApprAbs = normalizeSearchText(approved.abstract ?? "");
		const normPropAbs = normalizeSearchText(activeDiffPaper.abstract ?? "");
		entries.push({
			field: "abstract",
			label: "内容摘要 (Abstract)",
			approved: approved.abstract ?? "（空）",
			proposed: activeDiffPaper.abstract ?? "（空）",
			changed: normApprAbs !== normPropAbs,
		});

		// 3. Year
		entries.push({
			field: "year",
			label: "出版年份 (Year)",
			approved: String(approved.year ?? "未知"),
			proposed: String(activeDiffPaper.year ?? "未知"),
			changed: approved.year !== activeDiffPaper.year,
		});

		// 4. Venue
		entries.push({
			field: "venue",
			label: "期刊/会议 (Venue)",
			approved: approved.venue ?? "未知",
			proposed: activeDiffPaper.venue ?? "未知",
			changed: approved.venue !== activeDiffPaper.venue,
		});

		// 5. Identifiers (DOI, arXiv, OpenAlex, Semantic Scholar)
		const apprId = approved.identifiers ?? {};
		const propId = activeDiffPaper.identifiers ?? {};
		const doiChanged = normalizeDoi(apprId.doi) !== normalizeDoi(propId.doi);
		const arxivChanged = normalizeArxivId(apprId.arxivId) !== normalizeArxivId(propId.arxivId);
		const oaChanged = (apprId.openAlexId ?? "").toLowerCase() !== (propId.openAlexId ?? "").toLowerCase();
		const s2Changed =
			(apprId.semanticScholarId ?? "").toLowerCase() !== (propId.semanticScholarId ?? "").toLowerCase();

		const idFormat = (idObj: typeof apprId) =>
			[
				idObj.doi ? `DOI: ${idObj.doi}` : "",
				idObj.arxivId ? `arXiv: ${idObj.arxivId}` : "",
				idObj.openAlexId ? `OpenAlex: ${idObj.openAlexId}` : "",
				idObj.semanticScholarId ? `S2: ${idObj.semanticScholarId}` : "",
			].filter(Boolean);

		entries.push({
			field: "identifiers",
			label: "权威标识符 (Identifiers)",
			approved: idFormat(apprId),
			proposed: idFormat(propId),
			changed: doiChanged || arxivChanged || oaChanged || s2Changed,
		});

		// 6. Download links (pdf / artifact)
		const apprLinks = (approved.links ?? [])
			.filter((l) => l.kind === "pdf" || l.kind === "artifact")
			.map((l) => `${l.kind.toUpperCase()}: ${l.url}`);
		const propLinks = (activeDiffPaper.links ?? [])
			.filter((l) => l.kind === "pdf" || l.kind === "artifact")
			.map((l) => `${l.kind.toUpperCase()}: ${l.url}`);

		entries.push({
			field: "links",
			label: "核心下载与资源链接 (Download Links)",
			approved: apprLinks.length ? apprLinks : ["（无下载链接）"],
			proposed: propLinks.length ? propLinks : ["（无下载链接）"],
			changed: apprLinks.sort().join(",") !== propLinks.sort().join(","),
		});

		return entries;
	}, [activeDiffPaper, approvedPaperCache]);

	if (demoMode) {
		return (
			<div className="team-page-canvas">
				<div className="demo-mode-banner">
					<span className="demo-mode-badge">示例导览 · 只读</span>
					<p>下方展示示例论文。连接团队服务后可提交、审核和管理真实内容。</p>
					<button type="button" className="avant-btn avant-btn-secondary" onClick={exitDemoMode}>
						退出导览模式
					</button>
				</div>
				<header className="team-editorial-header">
					<h1 className="team-hero-title">团队知识库导览</h1>
					<p>共享资料经过提案与审核后供成员检索、阅读和复用。</p>
				</header>
				<div className="team-bento-grid">
					{MOCK_DEMO_OVERVIEW.papers.map((paper) => (
						<article className="bento-card bento-hero" key={paper.id}>
							<h2>{paper.title}</h2>
							<p>
								{paper.authors.join(", ")} · {paper.year} · {paper.venue}
							</p>
							<p>{paper.abstract}</p>
							<small>示例数据，不代表当前团队库状态。</small>
						</article>
					))}
				</div>
			</div>
		);
	}
	if (!overview) {
		return (
			<div className="team-page-canvas">
				<div className="team-editorial-header">
					<div className="eyebrow-tag">
						<Users size={13} />
						SHARED CORPUS INTELLIGENCE
					</div>
					<h1 className="team-hero-title">团队知识库</h1>
					<p className="team-hero-desc">正在安全连接并读取团队协作服务状态…</p>
				</div>
				<LoadingBlock />
			</div>
		);
	}

	if (!overview.connected) {
		const diagnosis = formatConnectionReason(overview.reason, overview.status);
		return (
			<div className="team-page-canvas">
				{/* TOAST NOTIFICATION STACK */}
				<div className="avant-toast-stack" aria-live="polite">
					{toasts.map((toast) => (
						<div key={toast.id} className={`avant-toast avant-toast-${toast.type}`}>
							<div className="toast-icon">
								{toast.type === "success" && <CheckCircle2 size={16} />}
								{toast.type === "error" && <XCircle size={16} />}
								{toast.type === "warning" && <AlertCircle size={16} />}
								{toast.type === "info" && <Info size={16} />}
							</div>
							<div className="toast-body">
								{toast.title && <strong className="toast-title">{toast.title}</strong>}
								<span className="toast-message">{toast.message}</span>
							</div>
							<button
								type="button"
								className="toast-close"
								onClick={() => removeToast(toast.id)}
								aria-label="关闭通知"
							>
								<X size={13} />
							</button>
						</div>
					))}
				</div>

				<header className="team-editorial-header">
					<div className="eyebrow-tag">
						<ShieldAlert size={13} />
						COLLABORATIVE CORPUS / 离线待接入
					</div>
					<h1 className="team-hero-title">团队知识库</h1>
					<p className="team-hero-desc">
						个人文献默认完全单机私有；配置并验证团队接入凭证后方可开启受控协同流转与论文共享。
					</p>
					<div className="header-action-row">
						<button
							className="avant-btn avant-btn-primary"
							type="button"
							onClick={() => void load()}
							disabled={isSyncing}
						>
							<RefreshCw size={14} className={isSyncing ? "spin" : ""} />
							重新检测连接
						</button>
						<button className="avant-btn avant-btn-secondary" type="button" onClick={() => navigate("settings")}>
							<Key size={14} />
							前往设置接入凭证
						</button>
						<button className="avant-btn avant-btn-subtle" type="button" onClick={enterDemoMode}>
							<Compass size={14} />
							进入交互式演示导览
						</button>
					</div>
				</header>

				<div className="team-bento-grid">
					{/* Bento 1: 实时连接诊断卡片 (Hero) */}
					<div className="bento-card bento-hero">
						<div className="bento-card-header">
							<span className="bento-tag">
								<Activity size={12} />
								连接诊断
							</span>
							<span className="bento-status-badge offline">
								<Radio size={11} />
								离线 / 待连接
							</span>
						</div>

						<h2 className="bento-hero-title">{diagnosis.title}</h2>
						<p className="bento-desc">{diagnosis.detail}</p>

						{overview.serverUrl && (
							<div className="endpoint-pill">
								<div className="icon-badge">
									<Database size={13} />
								</div>
								<code>
									{overview.serverUrl} / {overview.namespace}
								</code>
							</div>
						)}

						<div className="guide-callout">
							<div className="guide-icon-box">
								<Key size={15} />
							</div>
							<div>
								<strong>快速排障建议</strong>
								<span>{diagnosis.hint}</span>
							</div>
						</div>
					</div>

					{/* Bento 2: 安全边界与隐私保障 */}
					<div className="bento-card bento-security">
						<div className="bento-card-header">
							<span className="bento-tag">
								<ShieldCheck size={12} />
								数据安全保障
							</span>
							<span className="bento-status-badge secure">
								<Lock size={11} />
								本地私有保护中
							</span>
						</div>

						<h2>个人数据绝不自动外泄</h2>
						<p className="bento-desc">文献知识库采用零信任本地优先原则，所有跨端流转需人工显式授权：</p>

						<ul className="safety-steps">
							<li>
								<span className="step-num">01</span>
								<div>
									<strong>本机自主选定</strong>
									<small>仅在个人库明确勾选的文献方可进入提案流，其余记录完全保留在本地 SQLite。</small>
								</div>
							</li>
							<li>
								<span className="step-num">02</span>
								<div>
									<strong>审查指纹收窄</strong>
									<small>论文提案会去掉私人备注与筛选意见；显式选定的笔记正文在预览确认后共享。</small>
								</div>
							</li>
							<li>
								<span className="step-num">03</span>
								<div>
									<strong>同行背书与审计</strong>
									<small>贡献者预览提交，Reviewer 阅读审核，操作保留追加式审计记录。</small>
								</div>
							</li>
						</ul>
					</div>

					{/* Bento 3: 协同流转能力展示 */}
					<div className="bento-features-row">
						<div className="bento-feature-item">
							<div className="bento-feature-icon">
								<FileStack size={16} />
							</div>
							<h3>集中式去重文献库</h3>
							<p>全团队 SHA-256 跨节点去重，论文 PDF 一键缓存复用，大幅减少重复下载与解析时间。</p>
						</div>

						<div className="bento-feature-item">
							<div className="bento-feature-icon">
								<GitPullRequest size={16} />
							</div>
							<h3>结构化知识提案流</h3>
							<p>支持对论文、核心方法切片与 Markdown 笔记发起提案，多版本差异精准比对。</p>
						</div>

						<div className="bento-feature-item">
							<div className="bento-feature-icon">
								<Users size={16} />
							</div>
							<h3>权责清晰的角色体系</h3>
							<p>Reader 检索阅读、Contributor 提交提案、Reviewer 终审裁决、Admin 管理凭据与生命周期。</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	const stats = overview.stats ?? {};

	return (
		<div className="team-page-canvas">
			{/* TOAST NOTIFICATION STACK */}
			<div className="avant-toast-stack" aria-live="polite">
				{toasts.map((toast) => (
					<div key={toast.id} className={`avant-toast avant-toast-${toast.type}`}>
						<div className="toast-icon">
							{toast.type === "success" && <CheckCircle2 size={16} />}
							{toast.type === "error" && <XCircle size={16} />}
							{toast.type === "warning" && <AlertCircle size={16} />}
							{toast.type === "info" && <Info size={16} />}
						</div>
						<div className="toast-body">
							{toast.title && <strong className="toast-title">{toast.title}</strong>}
							<span className="toast-message">{toast.message}</span>
						</div>
						<button
							type="button"
							className="toast-close"
							onClick={() => removeToast(toast.id)}
							aria-label="关闭通知"
						>
							<X size={13} />
						</button>
					</div>
				))}
			</div>

			{/* HERO EDITORIAL HEADER & TELEMETRY HUD */}
			<header className="team-editorial-header">
				<div className="header-meta-row">
					<div className="eyebrow-tag">
						<Users size={13} />
						TEAM COLLABORATIVE CORPUS
					</div>
					<div className="telemetry-chip-group">
						<span className="telemetry-chip endpoint">
							<Database size={12} />
							{overview.namespace}
						</span>
						{roles.map((r) => (
							<span key={r} className={`role-chip role-${r}`}>
								<ShieldCheck size={11} />
								{r.toUpperCase()}
							</span>
						))}
					</div>
				</div>

				<div className="header-main-layout">
					<div>
						<h1 className="team-hero-title">团队协作知识库</h1>
						<p className="team-hero-desc">
							严格背书与审计跟踪的学术知识中心。当前节点：<code>{overview.serverUrl}</code>
						</p>
					</div>

					<div className="header-action-cluster">
						{/* LIVE SYNC ENGINE INDICATOR (P1) */}
						<div className="sync-engine-widget">
							<button
								type="button"
								className={`sync-pulse-badge ${autoSync ? "live" : "paused"}`}
								onClick={() => setAutoSync(!autoSync)}
								title={autoSync ? "点击暂停自动同步" : "点击开启自动同步 (30s)"}
							>
								<span className="pulse-dot" />
								<span>{autoSync ? "实时同步中" : "同步已暂停"}</span>
								{autoSync ? <Pause size={11} /> : <Play size={11} />}
							</button>
							<button
								type="button"
								className="avant-icon-btn"
								onClick={() => void load()}
								disabled={isSyncing}
								title="立即拉取最新团队状态"
							>
								<RefreshCw size={14} className={isSyncing ? "spin" : ""} />
							</button>
						</div>

						{admin && (
							<button
								className="avant-btn avant-btn-primary"
								type="button"
								disabled={busy}
								onClick={() => void prepare("/api/team/backup/prepare", "/api/team/backup/execute", {})}
							>
								<Download size={14} />
								创建全量备份
							</button>
						)}
					</div>
				</div>
			</header>
			<TeamCollaborationPanel
				key={`${overview.serverUrl}:${overview.namespace}:${overview.identity?.id}`}
				canRead={canRead}
				canContribute={contributor}
				canReview={reviewer}
				personalNamespace={personalNamespace}
				autoSync={autoSync}
				onChanged={() => void load()}
			/>
			<p className="sub-empty-text">
				下方概览各显示已发布和待审知识的前 25 条。完整分页列表、正文阅读和提案反馈位于上方协作区。
			</p>

			{/* ONE-TIME TOKEN REVEAL MODAL */}
			{oneTimeToken && (
				<div className="secret-reveal-card">
					<div className="secret-reveal-header">
						<Key size={18} />
						<div>
							<h3>一次性团队接入串已生成</h3>
							<p>此凭据包含访问凭证与自签证书，出于安全考虑仅在当前界面显示一次，离开后无法再次查看。</p>
						</div>
					</div>
					<div className="secret-token-box">
						<code>{oneTimeToken}</code>
					</div>
					<div className="secret-actions">
						<button className="avant-btn avant-btn-primary" type="button" onClick={() => void copyAndHideToken()}>
							<Copy size={14} />
							复制并立即销毁视图
						</button>
						<button className="avant-btn avant-btn-secondary" type="button" onClick={() => setOneTimeToken("")}>
							<Eye size={14} />
							已记录，隐藏
						</button>
					</div>
				</div>
			)}

			{/* PREPARED OPERATION CONSENT MODAL */}
			{knowledge && (
				<TeamKnowledgeDialog
					value={knowledge}
					onClose={() => setKnowledge(undefined)}
					previous={knowledgePrevious}
				/>
			)}
			{pending && (
				<AccessibleModal
					title="确认团队操作"
					onClose={() => {
						if (!busy) {
							setPending(undefined);
							setPendingRequest(undefined);
						}
					}}
					maxWidth={1100}
					className="team-content-dialog"
				>
					<TeamOperationPreview key={pending.operationId} operation={pending} />
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => {
							setPending(undefined);
							setPendingRequest(undefined);
						}}
						onConfirm={execute}
					/>
				</AccessibleModal>
			)}

			{/* BATCH ACTION CONFIRMATION MODAL (P2: SAFETY FIRST) */}
			{batchConfirm && (
				<div className="avant-modal-overlay">
					<button
						className="modal-backdrop"
						type="button"
						tabIndex={-1}
						aria-label="关闭批量审核对话框"
						onClick={() => setBatchConfirm(null)}
					/>
					<div
						className="avant-modal-card"
						role="dialog"
						aria-modal="true"
						aria-labelledby="batch-confirm-modal-title"
					>
						<div className="modal-icon-badge warning">
							<ShieldAlert size={24} />
						</div>
						<h3 id="batch-confirm-modal-title">
							确认批量{batchConfirm.decision === "team-approved" ? "批准" : "拒绝"} {batchConfirm.ids.length}{" "}
							项条目？
						</h3>
						<p className="modal-sub">
							审核结果将即刻生效并记入不可篡改的追加式审计记录。
							{batchConfirm.decision === "team-rejected" && " 被拒绝的提案将被移出审核队列。"}
						</p>

						<div className="batch-preview-list">
							{batchConfirm.ids.slice(0, 5).map((id) => (
								<div key={id} className="batch-preview-item">
									<FileText size={13} />
									<span>{id}</span>
								</div>
							))}
							{batchConfirm.ids.length > 5 && (
								<div className="batch-preview-more">及其他 {batchConfirm.ids.length - 5} 项…</div>
							)}
						</div>

						{batchConfirm.reason && (
							<div className="batch-reason-box">
								<strong>附带审核理由：</strong>
								<span>{batchConfirm.reason}</span>
							</div>
						)}

						<div className="modal-actions">
							<button
								type="button"
								className="avant-btn avant-btn-secondary"
								onClick={() => setBatchConfirm(null)}
							>
								取消
							</button>
							<button
								type="button"
								className={`avant-btn ${batchConfirm.decision === "team-approved" ? "avant-btn-primary" : "avant-btn-danger"}`}
								onClick={() => {
									const { resource, ids, decision, reason } = batchConfirm;
									setBatchConfirm(null);
									void review(resource, ids, decision, reason || undefined);
								}}
							>
								确认执行审核
							</button>
						</div>
					</div>
				</div>
			)}

			{/* REVISION FIELD DIFF MODAL (P0: 核心字段级对比) */}
			{activeDiffPaper && (
				<div className="avant-modal-overlay">
					<button
						className="modal-backdrop"
						type="button"
						tabIndex={-1}
						aria-label="关闭修订对话框"
						onClick={() => setActiveDiffPaper(null)}
					/>
					<div className="diff-modal-container" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title">
						<header className="diff-modal-header">
							<div className="diff-title-wrap">
								<span className="avant-badge avant-badge-revision">
									<GitCompare size={12} />
									FIELD-LEVEL REVISION AUDIT
								</span>
								<h2 id="diff-modal-title">待审修订字段级比对</h2>
								<p>
									比对已被收纳的“当前线上已批准版本”与本次提案的“待审修订版本”。审核指纹聚焦核心元数据与资源。
								</p>
							</div>
							<button
								type="button"
								className="avant-icon-btn"
								onClick={() => setActiveDiffPaper(null)}
								aria-label="关闭比对"
							>
								<X size={18} />
							</button>
						</header>

						<div className="diff-modal-body">
							{diffLoading ? (
								<LoadingBlock />
							) : (
								<div className="diff-table">
									{fieldDiffs.map((entry) => (
										<div
											key={entry.field}
											className={`diff-row ${entry.changed ? "has-changes" : "no-changes"}`}
										>
											<div className="diff-field-name">
												<span className="field-title">{entry.label}</span>
												{entry.changed ? (
													<span className="change-tag changed">已变更</span>
												) : (
													<span className="change-tag same">一致</span>
												)}
											</div>
											<div className="diff-comparison-columns">
												<div className="diff-pane approved-pane">
													<div className="pane-header">
														<FileCheck size={13} />
														<span>当前线上已批准版本 (Approved)</span>
													</div>
													<div className="pane-content">
														{Array.isArray(entry.approved) ? (
															<ul>
																{entry.approved.map((item) => (
																	<li key={item}>
																		<code>{item}</code>
																	</li>
																))}
															</ul>
														) : (
															<p>{entry.approved}</p>
														)}
													</div>
												</div>
												<div className="diff-pane proposed-pane">
													<div className="pane-header">
														<GitPullRequest size={13} />
														<span>待审修订版本 (Proposed Revision)</span>
													</div>
													<div className="pane-content">
														{Array.isArray(entry.proposed) ? (
															<ul>
																{entry.proposed.map((item) => (
																	<li key={item}>
																		<code>{item}</code>
																	</li>
																))}
															</ul>
														) : (
															<p>{entry.proposed}</p>
														)}
													</div>
												</div>
											</div>
										</div>
									))}
								</div>
							)}
						</div>

						<footer className="diff-modal-footer">
							<div className="diff-footer-info">
								<Users size={14} />
								<span>提案人：{activeDiffPaper.curation?.teamReview?.proposedBy || "未知"}</span>
								<Clock size={14} />
								<span>
									提交时间：
									{activeDiffPaper.curation?.teamReview?.proposedAt
										? new Date(activeDiffPaper.curation.teamReview.proposedAt).toLocaleString()
										: "未知"}
								</span>
							</div>
							<div className="diff-footer-actions">
								<button
									type="button"
									className="avant-btn avant-btn-danger"
									disabled={busy}
									onClick={() => {
										const paper = activeDiffPaper;
										setActiveDiffPaper(null);
										void review(
											"papers",
											[paper.id],
											"team-rejected",
											itemReasons[paper.id]?.trim() || undefined,
										);
									}}
								>
									<X size={14} />
									拒绝此修订
								</button>
								<button
									type="button"
									className="avant-btn avant-btn-primary"
									disabled={busy}
									onClick={() => {
										const paper = activeDiffPaper;
										setActiveDiffPaper(null);
										void review(
											"papers",
											[paper.id],
											"team-approved",
											itemReasons[paper.id]?.trim() || undefined,
										);
									}}
								>
									<Check size={14} />
									批准替换现有记录
								</button>
							</div>
						</footer>
					</div>
				</div>
			)}

			{/* METRIC HUD CARDS */}
			<section className="metric-hud-grid">
				<div className="hud-metric-card accent">
					<div className="hud-metric-icon">
						<BookOpen size={20} />
					</div>
					<div className="hud-metric-body">
						<span className="hud-label">共享论文总量</span>
						<strong className="hud-value">
							{canRead ? (stats.manifest?.recordCount ?? overview.papers?.length ?? 0) : "—"}
						</strong>
						<div className="hud-status-line">
							{stats.pendingPapers ? (
								<span className="pending-badge highlight">
									<Sparkles size={11} />
									{stats.pendingPapers} 篇待审核
								</span>
							) : (
								<span className="pending-badge clean">队列清空</span>
							)}
						</div>
					</div>
				</div>

				<div className="hud-metric-card">
					<div className="hud-metric-icon">
						<Layers size={20} />
					</div>
					<div className="hud-metric-body">
						<span className="hud-label">派生研究记忆</span>
						<strong className="hud-value">
							{canRead ? (stats.derivedCount ?? overview.derived?.length ?? 0) : "—"}
						</strong>
						<div className="hud-status-line">
							{stats.pendingDerived ? (
								<span className="pending-badge highlight">{stats.pendingDerived} 条待审核</span>
							) : (
								<span className="pending-badge clean">无积压</span>
							)}
						</div>
					</div>
				</div>

				<div className="hud-metric-card">
					<div className="hud-metric-icon">
						<FileCode size={20} />
					</div>
					<div className="hud-metric-body">
						<span className="hud-label">Artifact Manifest</span>
						<strong className="hud-value">
							{canRead ? (stats.artifactCount ?? overview.artifacts?.length ?? 0) : "—"}
						</strong>
						<div className="hud-status-line">
							{stats.pendingArtifacts ? (
								<span className="pending-badge highlight">{stats.pendingArtifacts} 份待审核</span>
							) : (
								<span className="pending-badge clean">已同步</span>
							)}
						</div>
					</div>
				</div>

				<div className="hud-metric-card">
					<div className="hud-metric-icon">
						<FileStack size={20} />
					</div>
					<div className="hud-metric-body">
						<span className="hud-label">内容寻址 Blob</span>
						<strong className="hud-value">{canRead ? (stats.blobCount ?? 0) : "—"}</strong>
						<div className="hud-status-line">
							<span className="blob-size">
								{canRead ? `${Math.round((stats.blobBytes ?? 0) / 1024 / 1024)} MB 存储空间` : "需 reader 角色"}
							</span>
						</div>
					</div>
				</div>
			</section>

			{/* ========================================================================= */}
			{/* P0 REVIEW CENTER (彻底消灭“盲批”) */}
			{/* ========================================================================= */}
			{reviewer && (
				<section className="avant-panel review-center-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">AUDIT WORKBENCH · 审核工作台</span>
							<h2>审核工作台</h2>
							<p>所有成员提交的提案与修订必须经过审查。支持展开完整元数据、标识符直达验证与字段级修订对比。</p>
						</div>

						<div className="review-tab-nav" role="tablist" aria-label="待审核资源分类">
							<button
								type="button"
								role="tab"
								id="tab-review-papers"
								aria-selected={reviewTab === "papers"}
								aria-controls="panel-review-papers"
								className={`tab-chip ${reviewTab === "papers" ? "active" : ""}`}
								onClick={() => setReviewTab("papers")}
							>
								<BookOpen size={13} />
								论文提案 ({overview.pendingPapers?.length ?? 0})
							</button>
							<button
								type="button"
								role="tab"
								id="tab-review-derived"
								aria-selected={reviewTab === "derived"}
								aria-controls="panel-review-derived"
								className={`tab-chip ${reviewTab === "derived" ? "active" : ""}`}
								onClick={() => setReviewTab("derived")}
							>
								<Layers size={13} />
								派生知识 (
								{overview.derived?.filter((e: any) => e.review.status === "team-proposed").length ?? 0})
							</button>
							<button
								type="button"
								role="tab"
								id="tab-review-artifacts"
								aria-selected={reviewTab === "artifacts"}
								aria-controls="panel-review-artifacts"
								className={`tab-chip ${reviewTab === "artifacts" ? "active" : ""}`}
								onClick={() => setReviewTab("artifacts")}
							>
								<FileCode size={13} />
								Artifacts (
								{overview.artifacts?.filter((e: any) => e.review.status === "team-proposed").length ?? 0})
							</button>
							<button
								type="button"
								role="tab"
								id="tab-review-pages"
								aria-selected={reviewTab === "pages"}
								aria-controls="panel-review-pages"
								className={`tab-chip ${reviewTab === "pages" ? "active" : ""}`}
								onClick={() => setReviewTab("pages")}
							>
								<FileText size={13} />
								知识页面 ({overview.pages?.filter((e: any) => e.review.status === "team-proposed").length ?? 0})
							</button>
						</div>
					</div>

					{/* 1. PAPERS REVIEW TAB */}
					{reviewTab === "papers" && (
						<div
							id="panel-review-papers"
							role="tabpanel"
							aria-labelledby="tab-review-papers"
							className="review-resource-section"
						>
							<div className="review-batch-toolbar">
								<div className="batch-selection-indicator">
									<label className="checkbox-wrap">
										<input
											type="checkbox"
											checked={
												Boolean(overview.pendingPapers?.length) &&
												overview.pendingPapers.every((p: PaperRecord) => reviewSelection.papers?.has(p.id))
											}
											onChange={(e) =>
												e.target.checked
													? selectAllReview(
															"papers",
															overview.pendingPapers.map((p: PaperRecord) => p.id),
														)
													: clearReviewSelection("papers")
											}
										/>
										<span>全选本页待审</span>
									</label>
									<span className="selected-count-tag">
										已选 {reviewSelection.papers?.size ?? 0} / {overview.pendingPapers?.length ?? 0}
									</span>
								</div>

								<div className="batch-action-inputs">
									<input
										className="avant-input batch-reason-input"
										placeholder="批量审核理由（可选，将赋给所选全部条目）"
										value={batchReason}
										onChange={(e) => setBatchReason(e.target.value)}
									/>
									<button
										className="avant-btn avant-btn-primary"
										type="button"
										disabled={!reviewSelection.papers?.size || busy}
										onClick={() => initiateBatchReview("papers", "team-approved")}
									>
										<Check size={14} />
										批量批准 ({reviewSelection.papers?.size ?? 0})
									</button>
									<button
										className="avant-btn avant-btn-secondary danger-hover"
										type="button"
										disabled={!reviewSelection.papers?.size || busy}
										onClick={() => initiateBatchReview("papers", "team-rejected")}
									>
										<X size={14} />
										批量拒绝
									</button>
								</div>
							</div>

							{overview.pendingPapers?.length ? (
								<div className="pending-cards-stack">
									{overview.pendingPapers.map((paper: PaperRecord) => {
										const isRevision = Boolean(paper.curation?.teamReview?.revision);
										const isSelected = reviewSelection.papers?.has(paper.id) ?? false;
										const isAbstractExpanded = expandedAbstracts.has(paper.id);
										const reasons = itemReasons[paper.id] ?? "";

										return (
											<article
												key={paper.id}
												className={`review-paper-card ${isSelected ? "selected" : ""} ${isRevision ? "is-revision" : ""}`}
											>
												<div className="card-top-row">
													<div className="card-select-and-badges">
														<input
															type="checkbox"
															aria-label={`选择论文 ${paper.title}`}
															checked={isSelected}
															onChange={(e) => toggleReview("papers", paper.id, e.target.checked)}
														/>
														{isRevision ? (
															<span className="avant-badge avant-badge-revision">
																<GitCompare size={12} />
																待审修订 (Revision)
															</span>
														) : (
															<span className="avant-badge avant-badge-new">
																<Sparkles size={12} />
																新论文提案 (New Proposal)
															</span>
														)}
														{paper.publicationType && (
															<span className="avant-badge avant-badge-type">
																{paper.publicationType}
															</span>
														)}
														{paper.year && (
															<span className="avant-badge avant-badge-year">
																<Calendar size={11} />
																{paper.year}
															</span>
														)}
													</div>

													<div className="card-proposer-meta">
														<Users size={12} />
														<span>{paper.curation?.teamReview?.proposedBy || "匿名贡献者"}</span>
														<Clock size={12} />
														<span>
															{paper.curation?.teamReview?.proposedAt
																? new Date(paper.curation.teamReview.proposedAt).toLocaleDateString()
																: "时间未知"}
														</span>
													</div>
												</div>

												{/* Title & Venue */}
												<div className="card-headline">
													<h3 className="paper-title">{paper.title}</h3>
													{paper.venue && (
														<span className="paper-venue">
															<Building size={13} />
															{paper.venue}
														</span>
													)}
												</div>

												{/* Authors list */}
												{paper.authors?.length > 0 && (
													<div className="card-authors-row">
														{paper.authors.map((author) => (
															<span key={author} className="author-pill">
																{author}
															</span>
														))}
													</div>
												)}

												{/* Abstract with toggle */}
												{paper.abstract && (
													<div
														className={`paper-abstract-container ${isAbstractExpanded ? "expanded" : "collapsed"}`}
													>
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

												{/* Identifiers (DOI, arXiv, OpenAlex, etc.) */}
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
															onClick={() =>
																copyText(paper.identifiers.openAlexId!, "已复制 OpenAlex ID")
															}
														>
															<code>OA: {paper.identifiers.openAlexId}</code>
															<Copy size={11} />
														</button>
													)}
													{paper.identifiers?.semanticScholarId && (
														<button
															type="button"
															className="identifier-copy-btn"
															onClick={() =>
																copyText(
																	paper.identifiers.semanticScholarId!,
																	"已复制 Semantic Scholar ID",
																)
															}
														>
															<code>S2: {paper.identifiers.semanticScholarId.slice(0, 10)}…</code>
															<Copy size={11} />
														</button>
													)}
												</div>

												{/* Download links */}
												{paper.links?.length > 0 && (
													<div className="card-links-bar">
														{paper.links.map((link) => (
															<a
																key={`${link.kind}-${link.url}`}
																href={link.url}
																target="_blank"
																rel="noopener noreferrer"
																className={`resource-chip ${link.kind}`}
															>
																{link.kind === "pdf" && <FileText size={11} />}
																{link.kind === "artifact" && <FileCode size={11} />}
																<span>
																	{link.kind.toUpperCase()}
																	{link.openAccess ? " (OA)" : ""}
																</span>
																<ArrowUpRight size={11} />
															</a>
														))}
													</div>
												)}

												{/* Action bar: Diff preview & individual reasons (P0 & P2) */}
												<div className="card-action-bar">
													{isRevision && (
														<button
															type="button"
															className="avant-btn avant-btn-secondary diff-trigger-btn"
															onClick={() => void openDiff(paper)}
														>
															<GitCompare size={14} />
															查看字段级差异比对 (Diff)
														</button>
													)}

													<div className="card-inline-review-controls">
														<input
															className="avant-input inline-reason-input"
															placeholder="为此篇填写审核意见（可选）"
															value={reasons}
															onChange={(e) =>
																setItemReasons((prev) => ({ ...prev, [paper.id]: e.target.value }))
															}
														/>
														<button
															type="button"
															className="avant-btn avant-btn-primary"
															disabled={busy}
															onClick={() =>
																void review(
																	"papers",
																	[paper.id],
																	"team-approved",
																	reasons.trim() || undefined,
																)
															}
														>
															<Check size={14} />
															批准
														</button>
														<button
															type="button"
															className="avant-btn avant-btn-danger"
															disabled={busy}
															onClick={() =>
																void review(
																	"papers",
																	[paper.id],
																	"team-rejected",
																	reasons.trim() || undefined,
																)
															}
														>
															<X size={14} />
															拒绝
														</button>
													</div>
												</div>
											</article>
										);
									})}
								</div>
							) : (
								<EmptyState
									title="当前没有待审核的论文提案"
									text="所有论文提案与修订均已审核完毕，新的提案会自动在此出现。"
								/>
							)}
						</div>
					)}

					{/* 2. DERIVED MEMORY REVIEW TAB */}
					{reviewTab === "derived" && (
						<div
							id="panel-review-derived"
							role="tabpanel"
							aria-labelledby="tab-review-derived"
							className="review-resource-section"
						>
							<div className="review-batch-toolbar">
								<label className="checkbox-wrap">
									<input
										type="checkbox"
										checked={
											Boolean(overview.derived?.length) &&
											(overview.derived ?? [])
												.filter((e: any) => e.review.status === "team-proposed")
												.every((e: any) => reviewSelection.derived?.has(e.record.key))
										}
										onChange={(e) =>
											e.target.checked
												? selectAllReview(
														"derived",
														(overview.derived ?? [])
															.filter((item: any) => item.review.status === "team-proposed")
															.map((item: any) => item.record.key),
													)
												: clearReviewSelection("derived")
										}
									/>
									<span>全选待审派生知识</span>
								</label>

								<div className="batch-action-inputs">
									<input
										className="avant-input batch-reason-input"
										placeholder="批量审核理由"
										value={batchReason}
										onChange={(e) => setBatchReason(e.target.value)}
									/>
									<button
										className="avant-btn avant-btn-primary"
										type="button"
										disabled={!reviewSelection.derived?.size || busy}
										onClick={() => initiateBatchReview("derived", "team-approved")}
									>
										<Check size={14} />
										批量批准 ({reviewSelection.derived?.size ?? 0})
									</button>
									<button
										className="avant-btn avant-btn-secondary danger-hover"
										type="button"
										disabled={!reviewSelection.derived?.size || busy}
										onClick={() => initiateBatchReview("derived", "team-rejected")}
									>
										<X size={14} />
										批量拒绝
									</button>
								</div>
							</div>

							<div className="review-compact-list">
								{(overview.derived ?? [])
									.filter((entry: any) => entry.review.status === "team-proposed")
									.map((entry: any) => (
										<div key={entry.record.key} className="review-compact-row">
											<input
												type="checkbox"
												aria-label={`选择派生记录 ${entry.record.key}`}
												checked={reviewSelection.derived?.has(entry.record.key) ?? false}
												onChange={(e) => toggleReview("derived", entry.record.key, e.target.checked)}
											/>
											<div className="compact-body">
												<div className="compact-title-row">
													<strong>{entry.record.operation}</strong>
													<button
														type="button"
														className="avant-btn avant-btn-sm avant-btn-secondary"
														onClick={() => void openKnowledge({ resource: "derived", entry })}
													>
														阅读研究结果
													</button>
													<code>{entry.record.key}</code>
												</div>
												<small>关联论文：{entry.record.paperId || "无"}</small>
											</div>
											<div className="compact-actions">
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-primary"
													onClick={() =>
														void review(
															"derived",
															[entry.record.key],
															"team-approved",
															batchReason || undefined,
														)
													}
												>
													批准
												</button>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-danger"
													onClick={() =>
														void review(
															"derived",
															[entry.record.key],
															"team-rejected",
															batchReason || undefined,
														)
													}
												>
													拒绝
												</button>
											</div>
										</div>
									))}
								{!(overview.derived ?? []).some((e: any) => e.review.status === "team-proposed") && (
									<EmptyState title="暂无待审核的派生知识" text="所有团队成员提交的派生分析均已完成审查。" />
								)}
							</div>
						</div>
					)}

					{/* 3. ARTIFACT MANIFEST REVIEW TAB */}
					{reviewTab === "artifacts" && (
						<div
							id="panel-review-artifacts"
							role="tabpanel"
							aria-labelledby="tab-review-artifacts"
							className="review-resource-section"
						>
							<div className="review-batch-toolbar">
								<label className="checkbox-wrap">
									<input
										type="checkbox"
										checked={
											Boolean(overview.artifacts?.length) &&
											(overview.artifacts ?? [])
												.filter((e: any) => e.review.status === "team-proposed")
												.every((e: any) => reviewSelection.artifacts?.has(e.paperId))
										}
										onChange={(e) =>
											e.target.checked
												? selectAllReview(
														"artifacts",
														(overview.artifacts ?? [])
															.filter((item: any) => item.review.status === "team-proposed")
															.map((item: any) => item.paperId),
													)
												: clearReviewSelection("artifacts")
										}
									/>
									<span>全选待审 Artifact</span>
								</label>

								<div className="batch-action-inputs">
									<input
										className="avant-input batch-reason-input"
										placeholder="批量审核理由"
										value={batchReason}
										onChange={(e) => setBatchReason(e.target.value)}
									/>
									<button
										className="avant-btn avant-btn-primary"
										type="button"
										disabled={!reviewSelection.artifacts?.size || busy}
										onClick={() => initiateBatchReview("artifacts", "team-approved")}
									>
										<Check size={14} />
										批量批准 ({reviewSelection.artifacts?.size ?? 0})
									</button>
									<button
										className="avant-btn avant-btn-secondary danger-hover"
										type="button"
										disabled={!reviewSelection.artifacts?.size || busy}
										onClick={() => initiateBatchReview("artifacts", "team-rejected")}
									>
										<X size={14} />
										批量拒绝
									</button>
								</div>
							</div>

							<div className="review-compact-list">
								{(overview.artifacts ?? [])
									.filter((entry: any) => entry.review.status === "team-proposed")
									.map((entry: any) => (
										<div key={entry.paperId} className="review-compact-row">
											<input
												type="checkbox"
												aria-label={`选择 Artifact ${entry.paperId}`}
												checked={reviewSelection.artifacts?.has(entry.paperId) ?? false}
												onChange={(e) => toggleReview("artifacts", entry.paperId, e.target.checked)}
											/>
											<div className="compact-body">
												<div className="compact-title-row">
													<strong>{entry.paperId}</strong>
													<button
														type="button"
														className="avant-btn avant-btn-sm avant-btn-secondary"
														onClick={() => void openKnowledge({ resource: "artifacts", entry })}
													>
														阅读材料与修订
													</button>
													<span className="avant-badge">
														{entry.candidateCount ?? 0} candidates · {entry.acquisitionCount ?? 0}{" "}
														acquisitions
													</span>
												</div>
												<small>PDF Hash: {entry.manifest?.pdfSha256?.slice(0, 16) || "未知"}</small>
											</div>
											<div className="compact-actions">
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-primary"
													onClick={() =>
														void review(
															"artifacts",
															[entry.paperId],
															"team-approved",
															batchReason || undefined,
														)
													}
												>
													批准
												</button>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-danger"
													onClick={() =>
														void review(
															"artifacts",
															[entry.paperId],
															"team-rejected",
															batchReason || undefined,
														)
													}
												>
													拒绝
												</button>
											</div>
										</div>
									))}
								{!(overview.artifacts ?? []).some((e: any) => e.review.status === "team-proposed") && (
									<EmptyState title="暂无待审核的 Artifact 证据" text="当前没有待处理的代码或模型抓取记录。" />
								)}
							</div>
						</div>
					)}

					{/* 4. KNOWLEDGE PAGES REVIEW TAB */}
					{reviewTab === "pages" && (
						<div
							id="panel-review-pages"
							role="tabpanel"
							aria-labelledby="tab-review-pages"
							className="review-resource-section"
						>
							<div className="review-batch-toolbar">
								<label className="checkbox-wrap">
									<input
										type="checkbox"
										checked={
											Boolean(overview.pages?.length) &&
											(overview.pages ?? [])
												.filter((e: any) => e.review.status === "team-proposed")
												.every((e: any) => reviewSelection.pages?.has(e.snapshot.key))
										}
										onChange={(e) =>
											e.target.checked
												? selectAllReview(
														"pages",
														(overview.pages ?? [])
															.filter((item: any) => item.review.status === "team-proposed")
															.map((item: any) => item.snapshot.key),
													)
												: clearReviewSelection("pages")
										}
									/>
									<span>全选待审知识页面</span>
								</label>

								<div className="batch-action-inputs">
									<input
										className="avant-input batch-reason-input"
										placeholder="批量审核理由"
										value={batchReason}
										onChange={(e) => setBatchReason(e.target.value)}
									/>
									<button
										className="avant-btn avant-btn-primary"
										type="button"
										disabled={!reviewSelection.pages?.size || busy}
										onClick={() => initiateBatchReview("pages", "team-approved")}
									>
										<Check size={14} />
										批量批准 ({reviewSelection.pages?.size ?? 0})
									</button>
									<button
										className="avant-btn avant-btn-secondary danger-hover"
										type="button"
										disabled={!reviewSelection.pages?.size || busy}
										onClick={() => initiateBatchReview("pages", "team-rejected")}
									>
										<X size={14} />
										批量拒绝
									</button>
								</div>
							</div>

							<div className="review-compact-list">
								{(overview.pages ?? [])
									.filter((entry: any) => entry.review.status === "team-proposed")
									.map((entry: any) => (
										<div key={entry.snapshot.key} className="review-compact-row">
											<input
												type="checkbox"
												aria-label={`选择知识页面 ${entry.snapshot.key}`}
												checked={reviewSelection.pages?.has(entry.snapshot.key) ?? false}
												onChange={(e) => toggleReview("pages", entry.snapshot.key, e.target.checked)}
											/>
											<div className="compact-body">
												<div className="compact-title-row">
													<strong>{entry.snapshot.title}</strong>
													<button
														type="button"
														className="avant-btn avant-btn-sm avant-btn-secondary"
														onClick={() => void openKnowledge({ resource: "pages", entry })}
													>
														阅读全文与修订
													</button>
													<span className="avant-badge">
														{entry.snapshot.kind === "note" ? "调研笔记" : "Wiki 页面"} · rev{" "}
														{entry.snapshot.revision}
													</span>
												</div>
												<small>
													内容 {entry.snapshot.contentHash.slice(0, 12)} ·{" "}
													{entry.snapshot.paperIds?.length
														? `关联 ${entry.snapshot.paperIds.length} 篇论文`
														: "未关联论文"}
													{entry.snapshot.markdown
														? ` · 约 ${Math.round(entry.snapshot.markdown.length / 100) / 10}k 字符`
														: ""}
												</small>
											</div>
											<div className="compact-actions">
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-primary"
													onClick={() =>
														void review(
															"pages",
															[entry.snapshot.key],
															"team-approved",
															batchReason || undefined,
														)
													}
												>
													批准
												</button>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-danger"
													onClick={() =>
														void review(
															"pages",
															[entry.snapshot.key],
															"team-rejected",
															batchReason || undefined,
														)
													}
												>
													拒绝
												</button>
											</div>
										</div>
									))}
								{!(overview.pages ?? []).some((e: any) => e.review.status === "team-proposed") && (
									<EmptyState
										title="暂无待审核的知识页面"
										text="成员提交的调研笔记与 Wiki 页面快照会在此出现。"
									/>
								)}
							</div>
						</div>
					)}
				</section>
			)}

			{/* ========================================================================= */}
			{/* P1 MULTI-DIMENSIONAL SEARCH CONSOLE (全维搜索) */}
			{/* ========================================================================= */}
			{canRead && (
				<section className="avant-panel search-console-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">REPOSITORY SEARCH · 共享检索</span>
							<h2>检索团队论文库</h2>
							<p>支持按关键词、作者、期刊/会议、年份区间、开放获取状态及审核状态组合精确查询。</p>
						</div>
						<div className="search-stats-badge">
							<Search size={13} />
							<span>{teamSearchResults.length} 条检索结果</span>
						</div>
					</div>

					<form
						className="search-console-form"
						onSubmit={(e) => {
							e.preventDefault();
							void searchTeam();
						}}
					>
						<div className="search-primary-line">
							<div className="search-input-wrap">
								<Search size={16} className="search-icon" />
								<input
									className="search-main-input"
									value={teamQuery}
									onChange={(e) => setTeamQuery(e.target.value)}
									placeholder="输入论文标题、摘要、作者或 DOI 关键词…"
								/>
							</div>
							<button
								type="button"
								className={`avant-btn avant-btn-secondary ${showAdvancedFilters ? "active" : ""}`}
								onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
							>
								<SlidersHorizontal size={14} />
								高级过滤器
							</button>
							<button className="avant-btn avant-btn-primary" type="submit" disabled={teamSearchLoading}>
								<Search size={14} className={teamSearchLoading ? "spin" : ""} />
								{teamSearchLoading ? "检索中…" : "立即检索"}
							</button>
						</div>

						{/* ADVANCED MULTI-FILTER DRAWER (P1) */}
						{showAdvancedFilters && (
							<div className="advanced-filters-drawer">
								<label className="filter-field">
									<span>
										<Users size={12} /> 作者 (Author)
									</span>
									<input
										className="avant-input"
										value={teamAuthor}
										onChange={(e) => setTeamAuthor(e.target.value)}
										placeholder="例如：Vaswani, Hinton"
									/>
								</label>
								<label className="filter-field">
									<span>
										<Building size={12} /> 会议 / 期刊 (Venue)
									</span>
									<input
										className="avant-input"
										value={teamVenue}
										onChange={(e) => setTeamVenue(e.target.value)}
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
										value={teamYearFrom}
										onChange={(e) => setTeamYearFrom(e.target.value)}
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
										value={teamYearTo}
										onChange={(e) => setTeamYearTo(e.target.value)}
										placeholder="例如：2026"
									/>
								</label>
								<label className="filter-field">
									<span>
										<BookOpen size={12} /> 文献类型
									</span>
									<select
										className="avant-select"
										value={teamType}
										onChange={(e) => setTeamType(e.target.value)}
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
										value={teamOpenAccess}
										onChange={(e) => setTeamOpenAccess(e.target.value as any)}
									>
										<option value="all">全部（含闭源）</option>
										<option value="true">仅开放获取 (OA Only)</option>
										<option value="false">仅限制访问 (Non-OA)</option>
									</select>
								</label>
								{reviewer && (
									<label className="filter-field">
										<span>
											<ShieldCheck size={12} /> 审核状态 (Review Status)
										</span>
										<select
											className="avant-select"
											value={teamStatus}
											onChange={(e) => setTeamStatus(e.target.value)}
										>
											<option value="">默认（仅已批准）</option>
											<option value="team-approved">已批准 (Approved)</option>
											<option value="team-proposed">待审核 (Proposed)</option>
											<option value="team-rejected">已拒绝 (Rejected)</option>
										</select>
									</label>
								)}
								<div className="filter-field filter-reset-wrap">
									<button type="button" className="avant-btn avant-btn-secondary" onClick={resetSearch}>
										<RotateCcw size={13} />
										重置筛选条件
									</button>
								</div>
							</div>
						)}
					</form>

					{/* SEARCH RESULTS DISPLAY (P2: SEPARATE SELECTION) */}
					{teamSearchResults.length > 0 ? (
						<div className="search-results-section">
							<div className="results-action-bar">
								<div className="selection-toolbar-left">
									<label className="checkbox-wrap">
										<input
											type="checkbox"
											checked={
												teamSearchResults.length > 0 &&
												teamSearchResults.every((p) => searchPullSelection.has(p.id))
											}
											onChange={(e) =>
												setSearchPullSelection(
													e.target.checked ? new Set(teamSearchResults.map((p) => p.id)) : new Set(),
												)
											}
										/>
										<span>全选检索结果</span>
									</label>
									<span className="selected-count-tag">已选 {searchPullSelection.size} 篇</span>
								</div>

								<div className="selection-toolbar-right">
									<label className="checkbox-wrap">
										<input
											type="checkbox"
											checked={includePdf}
											onChange={(e) => setIncludePdf(e.target.checked)}
										/>
										<span>同步拉取 PDF 到本地</span>
									</label>
									<button
										className="avant-btn avant-btn-primary"
										type="button"
										disabled={!searchPullSelection.size || busy}
										onClick={() => pullPapers([...searchPullSelection])}
									>
										<Download size={14} />
										拉取选中文献到个人库 ({searchPullSelection.size})
									</button>
								</div>
							</div>

							<div className="results-card-grid">
								{teamSearchResults.map((paper) => {
									const isChecked = searchPullSelection.has(paper.id);
									return (
										<article key={paper.id} className={`search-hit-card ${isChecked ? "checked" : ""}`}>
											<div className="hit-card-top">
												<input
													type="checkbox"
													aria-label={`选择拉取论文 ${paper.title}`}
													checked={isChecked}
													onChange={(e) =>
														setSearchPullSelection((prev) => {
															const next = new Set(prev);
															if (e.target.checked) next.add(paper.id);
															else next.delete(paper.id);
															return next;
														})
													}
												/>
												<div className="hit-meta-pills">
													<StatusPill status={paper.curation?.teamReview?.status ?? "team-approved"} />
													{paper.year && <span className="year-pill">{paper.year}</span>}
												</div>
											</div>
											<h4 className="hit-title">{paper.title}</h4>
											<div className="hit-authors-venue">
												<span>{paper.authors?.slice(0, 3).join(", ") || "作者未知"}</span>
												{paper.venue && <span className="hit-venue"> · {paper.venue}</span>}
											</div>
											{paper.abstract && <p className="hit-abstract">{paper.abstract.slice(0, 160)}…</p>}
										</article>
									);
								})}
							</div>

							{teamSearchCursor && (
								<div className="pagination-center">
									<button
										className="avant-btn avant-btn-secondary"
										type="button"
										disabled={teamSearchLoading}
										onClick={() => void searchTeam(teamSearchCursor)}
									>
										<RefreshCw size={13} className={teamSearchLoading ? "spin" : ""} />
										加载更多检索结果
									</button>
								</div>
							)}
						</div>
					) : (
						<div className="search-empty-prompt">
							<Search size={28} />
							<p>输入关键词或筛选条件后即可快速检索团队论文库，检索行为不会影响个人本地库数据。</p>
						</div>
					)}
				</section>
			)}

			{/* ========================================================================= */}
			{/* WORKSPACE DUAL-COLUMN GRID: PERSONAL CONTRIBUTION vs SHARED REPOSITORY */}
			{/* ========================================================================= */}
			<div className="team-dual-workspace-grid">
				{/* LEFT COLUMN: PERSONAL -> TEAM PROPOSAL (CONTRIBUTOR) */}
				{contributor ? (
					<section className="avant-panel personal-proposal-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">PROPOSAL PIPELINE · 提案推送</span>
								<h2>提交新论文提案</h2>
								<p>将个人空间中的论文提案至团队库。私有笔记与标签会自动脱敏，只上传公共元数据与链接。</p>
							</div>

							<div className="namespace-and-submit-row">
								<select
									className="avant-select namespace-picker"
									value={personalNamespace}
									onChange={(e) => {
										setPersonalNamespace(e.target.value);
										setSelectedPersonal(new Set());
										setBlobVersions([]);
									}}
								>
									{personalNamespaces.map((ns) => (
										<option key={ns} value={ns}>
											个人空间: {ns}
										</option>
									))}
								</select>
								<button
									className="avant-btn avant-btn-primary"
									type="button"
									disabled={!selectedPersonal.size || busy}
									onClick={() =>
										void prepare("/api/team/proposals/prepare", "/api/team/proposals/execute", {
											paperIds: [...selectedPersonal],
											personalNamespace,
										})
									}
								>
									<Send size={14} />
									预览并提交 ({selectedPersonal.size})
								</button>
							</div>
						</div>

						{/* PDF ACCOMPANIMENT NOTICE (P2) */}
						<div className="pdf-accompaniment-banner">
							<Info size={16} />
							<div>
								<strong>PDF 不会自动随元数据上行</strong>
								<span>
									提案批准后，请在下方“PDF Blob 上传器”单独上传对应论文的本地 PDF，团队成员方可下载全文。
								</span>
							</div>
						</div>

						{/* PERSONAL PAPERS SELECTOR WITH PDF AWARENESS (P2) */}
						<div className="personal-paper-checklist">
							{personal.map((paper) => {
								const isSelected = selectedPersonal.has(paper.id);
								const pdfCount = personalPaperPdfs[paper.id];

								return (
									<label key={paper.id} className={`personal-paper-row ${isSelected ? "checked" : ""}`}>
										<input
											type="checkbox"
											checked={isSelected}
											onChange={(e) =>
												setSelectedPersonal((prev) => {
													const next = new Set(prev);
													if (e.target.checked) next.add(paper.id);
													else next.delete(paper.id);
													return next;
												})
											}
										/>
										<div className="personal-paper-info">
											<strong className="personal-title">{paper.title}</strong>
											<div className="personal-meta-line">
												<span>{paper.authors?.slice(0, 3).join(", ") || "作者未知"}</span>
												{paper.year && <span> · {paper.year}</span>}
												{pdfCount !== undefined && pdfCount > 0 ? (
													<span className="pdf-status-pill has-pdf">
														<FileText size={10} /> 含 {pdfCount} 个本地 PDF
													</span>
												) : (
													<span className="pdf-status-pill no-pdf">无本地 PDF</span>
												)}
											</div>
										</div>
									</label>
								);
							})}
							{!personal.length && <EmptyState title="个人空间暂无论文" text="请先在个人文献库导入论文。" />}
						</div>
					</section>
				) : (
					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">PERMISSION GUARD · 权限防护</span>
								<h2>只读访问模式</h2>
								<p>当前身份具有团队库读取权限，但不具备 contributor 提案权限。如需提交请联系管理员授权。</p>
							</div>
						</div>
					</section>
				)}

				{/* RIGHT COLUMN: SHARED PAPERS REPOSITORY (READER & ALL) */}
				<section className="avant-panel shared-papers-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">SHARED REPOSITORY · 团队文献</span>
							<h2>已共享团队论文</h2>
							<p>经过审核并向全体成员开放的论文记录。支持批量拉取到本地个人空间。</p>
						</div>

						{canRead && sharedPapers.length > 0 && (
							<div className="shared-pull-controls">
								<label className="checkbox-wrap">
									<input
										type="checkbox"
										checked={includePdf}
										onChange={(e) => setIncludePdf(e.target.checked)}
									/>
									<span>含 PDF</span>
								</label>
								<button
									className="avant-btn avant-btn-primary"
									type="button"
									disabled={!sharedPullSelection.size || busy}
									onClick={() => pullPapers([...sharedPullSelection])}
								>
									<Download size={14} />
									拉取到个人库 ({sharedPullSelection.size})
								</button>
							</div>
						)}
					</div>

					<div className="shared-papers-list">
						{canRead ? (
							sharedPapers.length > 0 ? (
								sharedPapers.map((paper: PaperRecord) => {
									const isChecked = sharedPullSelection.has(paper.id);
									return (
										<article key={paper.id} className={`shared-paper-card ${isChecked ? "checked" : ""}`}>
											<div className="shared-card-left">
												<input
													type="checkbox"
													aria-label={`选择拉取论文 ${paper.title}`}
													checked={isChecked}
													onChange={(e) =>
														setSharedPullSelection((prev) => {
															const next = new Set(prev);
															if (e.target.checked) next.add(paper.id);
															else next.delete(paper.id);
															return next;
														})
													}
												/>
												<div className="shared-paper-meta">
													<strong className="shared-title">{paper.title}</strong>
													<div className="shared-sub-line">
														<span>{paper.authors?.slice(0, 3).join(", ") || "作者未知"}</span>
														{paper.year && <span> · {paper.year}</span>}
														{paper.venue && <span> · {paper.venue}</span>}
													</div>
												</div>
											</div>
											<StatusPill status={paper.curation?.teamReview?.status ?? "team-approved"} />
										</article>
									);
								})
							) : (
								<div className="shared-empty-workflow">
									<div className="workflow-hero">
										<div className="workflow-hero-icon">
											<BookOpen size={24} />
										</div>
										<h3>团队知识库尚无已收录文献</h3>
										<p>团队知识库为所有科研人员共享的同行评议文献池。严格遵循三步流转闭环：</p>
									</div>
									<div className="workflow-steps-grid">
										<div className="workflow-step-card">
											<span className="step-badge">01</span>
											<div className="step-body">
												<strong>左侧发起文献提案</strong>
												<small>在左侧列表勾选个人库中已精读、已验证的高价值文献提交入库提案。</small>
											</div>
										</div>
										<div className="workflow-step-card">
											<span className="step-badge">02</span>
											<div className="step-body">
												<strong>审核员比对背书</strong>
												<small>具备评审席位的成员在上方待审队列核对学术元数据或修订差异并决定通过。</small>
											</div>
										</div>
										<div className="workflow-step-card">
											<span className="step-badge">03</span>
											<div className="step-body">
												<strong>全员检索与同步</strong>
												<small>一旦通过，所有团队成员均可在此面板或上方搜索控制台一键拉取到本地。</small>
											</div>
										</div>
									</div>
								</div>
							)
						) : (
							<EmptyState title="无读取权限" text="请联系团队管理员授予 reader 权限。" />
						)}
					</div>

					{sharedCursor && (
						<div className="pagination-center">
							<button
								className="avant-btn avant-btn-secondary"
								type="button"
								disabled={teamSearchLoading}
								onClick={() => void loadMoreShared()}
							>
								<RefreshCw size={13} className={teamSearchLoading ? "spin" : ""} />
								加载更多团队论文
							</button>
						</div>
					)}
				</section>
			</div>

			{/* ========================================================================= */}
			{/* MULTIMODAL KNOWLEDGE & ASSET PROPOSALS (BLOB / DERIVED / PAGES)          */}
			{/* ========================================================================= */}
			{contributor && (
				<section className="avant-panel extended-proposals-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">ASSET PROPOSALS · 衍生与资源</span>
							<h2>多维知识资产与扩展提案</h2>
							<p>
								除论文元数据外，您还可向团队提交校验过的本地 PDF 全文、大模型精读派生记忆，或共享调研笔记与 Wiki
								快照。
							</p>
						</div>

						<div className="asset-tab-switcher">
							<button
								type="button"
								className={`asset-tab-btn ${assetTab === "blob" ? "active" : ""}`}
								onClick={() => setAssetTab("blob")}
							>
								<UploadCloud size={14} />
								PDF 全文 Blob 上传
							</button>
							<button
								type="button"
								className={`asset-tab-btn ${assetTab === "derived" ? "active" : ""}`}
								onClick={() => setAssetTab("derived")}
							>
								<Layers size={14} />
								派生知识记录 ({personalDerived.length})
							</button>
							<button
								type="button"
								className={`asset-tab-btn ${assetTab === "pages" ? "active" : ""}`}
								onClick={() => setAssetTab("pages")}
							>
								<FileText size={14} />
								笔记与 Wiki 快照 ({personalPages.notes.length + personalPages.wikiPages.length})
							</button>
						</div>
					</div>

					<div className="asset-tab-content">
						{assetTab === "blob" && (
							<div className="blob-uploader-wrapper">
								<div className="sub-section-header">
									<div className="sub-section-icon-box">
										<UploadCloud size={16} />
									</div>
									<div className="sub-section-titles">
										<h4>上传已下载 PDF Blob</h4>
										<small>独立核验内容 Hash、字节大小与目标空间，确保全文资产安全上云。</small>
									</div>
								</div>

								<div className="blob-controls-bar">
									<select
										className="avant-select blob-paper-select"
										value={blobPaperId}
										disabled={!personal.length}
										onChange={(e) => {
											setBlobPaperId(e.target.value);
											setBlobVersions([]);
										}}
									>
										<option value="">
											{personal.length ? "请选择待上传 PDF 的本地论文…" : "当前空间暂无可用本地论文"}
										</option>
										{personal.map((p) => (
											<option key={p.id} value={p.id}>
												{p.title.length > 60 ? `${p.title.slice(0, 60)}…` : p.title}{" "}
												{p.year ? `(${p.year})` : ""}
											</option>
										))}
									</select>
									<button
										className="avant-btn avant-btn-secondary blob-fetch-btn"
										type="button"
										disabled={!blobPaperId || blobLoading}
										onClick={() => void loadBlobVersions()}
									>
										<FileStack size={14} className={blobLoading ? "spin" : ""} />
										读取本地 PDF 版本
									</button>
								</div>

								{blobVersions.length > 0 ? (
									<div className="blob-version-cards">
										{blobVersions.map((version) => (
											<div key={version.sha256} className="blob-version-row">
												<div className="version-info">
													<div className="version-hash-line">
														<FileText size={13} />
														<code>{version.sha256}</code>
													</div>
													<small>
														{Math.round(version.bytes / 1024)} KB · {version.contentType}
													</small>
												</div>
												<button
													className="avant-btn avant-btn-sm avant-btn-primary"
													type="button"
													disabled={busy}
													onClick={() =>
														void prepare("/api/team/blobs/prepare", "/api/team/blobs/execute", {
															paperId: blobPaperId,
															sha256: version.sha256,
															personalNamespace,
														})
													}
												>
													<UploadCloud size={12} />
													预览并上传 Blob
												</button>
											</div>
										))}
									</div>
								) : blobPaperId && !blobLoading ? (
									<div className="blob-empty-hint">
										<Info size={14} />
										<span>点击“读取本地 PDF 版本”按钮以扫描本机缓存的对应 PDF 文件。</span>
									</div>
								) : null}
							</div>
						)}

						{assetTab === "derived" && (
							<div className="derived-submission-wrapper">
								<div className="sub-section-header">
									<div className="sub-section-icon-box">
										<Layers size={16} />
									</div>
									<div className="sub-section-titles">
										<h4>提交个人派生知识记录</h4>
										<small>将个人分析、大模型精读结论等派生记录作为团队资产提案。</small>
									</div>
								</div>

								{personalDerived.length > 0 ? (
									<>
										<div className="derived-action-bar">
											<button
												className="avant-btn avant-btn-primary"
												type="button"
												disabled={!derivedSelection.size || busy}
												onClick={() =>
													void prepare("/api/team/derived/prepare", "/api/team/derived/execute", {
														keys: [...derivedSelection],
														personalNamespace,
													})
												}
											>
												<Send size={13} />
												提交勾选的派生知识 ({derivedSelection.size})
											</button>
										</div>
										<div className="derived-checklist">
											{personalDerived.map((entry) => (
												<label key={entry.key} className="derived-check-item">
													<input
														type="checkbox"
														aria-label={`选择提案派生 ${entry.key}`}
														checked={derivedSelection.has(entry.key)}
														onChange={(e) =>
															setDerivedSelection((prev) => {
																const next = new Set(prev);
																if (e.target.checked) next.add(entry.key);
																else next.delete(entry.key);
																return next;
															})
														}
													/>
													<div>
														<strong>{entry.operation}</strong>
														<code>{entry.key}</code>
														<small>论文 ID: {entry.paperId}</small>
													</div>
												</label>
											))}
										</div>
									</>
								) : (
									<div className="sub-empty-box">
										<Layers size={18} className="empty-box-icon" />
										<p>当前个人空间暂无可提案的派生知识记录。</p>
									</div>
								)}
							</div>
						)}

						{assetTab === "pages" && (
							<div className="pages-submission-wrapper">
								<div className="sub-section-header">
									<div className="sub-section-icon-box">
										<FileText size={16} />
									</div>
									<div className="sub-section-titles">
										<h4>提交个人知识页面</h4>
										<small>
											把调研笔记或 Wiki
											页面的当前快照提交给团队审核。只共享明确勾选的内容，之后笔记更新会形成新的待审修订。
										</small>
									</div>
								</div>

								{personalPages.notes.length || personalPages.wikiPages.length ? (
									<>
										<div className="derived-action-bar">
											<button
												className="avant-btn avant-btn-primary"
												type="button"
												disabled={!pageSelection.size || busy}
												onClick={() =>
													void prepare("/api/team/pages/prepare", "/api/team/pages/execute", {
														sources: [...pageSelection].map((key) => ({
															kind: key.startsWith("wiki.") ? ("wiki" as const) : ("note" as const),
															id: key.slice(key.indexOf(".") + 1),
														})),
														personalNamespace,
													} satisfies TeamPageSourcesInput)
												}
											>
												<Send size={13} />
												提交选中的页面快照 ({pageSelection.size})
											</button>
										</div>
										<div className="derived-checklist">
											{personalPages.notes.map((note) => {
												const key = `note.${note.id}`;
												return (
													<label key={key} className="derived-check-item">
														<input
															type="checkbox"
															aria-label={`选择提案页面 ${key}`}
															checked={pageSelection.has(key)}
															onChange={(e) =>
																setPageSelection((prev) => {
																	const next = new Set(prev);
																	if (e.target.checked) next.add(key);
																	else next.delete(key);
																	return next;
																})
															}
														/>
														<div>
															<strong>{note.title}</strong>
															<span className="avant-badge">调研笔记 · rev {note.revision}</span>
															<code>{note.contentHash.slice(0, 12)}</code>
														</div>
													</label>
												);
											})}
											{personalPages.wikiPages.map((page) => {
												const key = `wiki.${page.id}`;
												return (
													<label key={key} className="derived-check-item">
														<input
															type="checkbox"
															aria-label={`选择提案页面 ${key}`}
															checked={pageSelection.has(key)}
															onChange={(e) =>
																setPageSelection((prev) => {
																	const next = new Set(prev);
																	if (e.target.checked) next.add(key);
																	else next.delete(key);
																	return next;
																})
															}
														/>
														<div>
															<strong>{page.title}</strong>
															<span className="avant-badge">
																Wiki · {page.type} · {page.status}
															</span>
															<code>{page.contentHash.slice(0, 12)}</code>
														</div>
													</label>
												);
											})}
										</div>
									</>
								) : (
									<div className="sub-empty-box">
										<FileText size={18} className="empty-box-icon" />
										<p>
											当前个人空间还没有调研笔记或 Wiki 页面。先在“知识库”或笔记区撰写内容，再来分享给团队。
										</p>
									</div>
								)}
							</div>
						)}
					</div>
				</section>
			)}

			{/* ========================================================================= */}
			{/* P3: MY PENDING PROPOSALS (面向所有 contributor 开放，包括兼任 reviewer 者) */}
			{/* ========================================================================= */}
			{contributor && (
				<section className="avant-panel my-proposals-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">MY PROPOSALS · 个人提案</span>
							<h2>我的待审提案</h2>
							<p>
								您向团队提交但尚未完成审核的提案。在 Reviewer 做出审核前，您可以随时自主撤回。
								撤回新论文将从队列彻底移除；撤回修订则丢弃修订，原已批准版本不受影响。
							</p>
						</div>
					</div>

					<div className="my-proposals-list">
						{overview.myProposals?.length ? (
							overview.myProposals.map((paper: PaperRecord) => (
								<div key={paper.id} className="my-proposal-row">
									<div className="my-proposal-info">
										<div className="my-proposal-title-row">
											<strong>{paper.title}</strong>
											{paper.curation?.teamReview?.revision && (
												<span className="avant-badge avant-badge-revision">
													<GitCompare size={11} /> 修订提案
												</span>
											)}
										</div>
										<small>
											提交时间：
											{paper.curation?.teamReview?.proposedAt
												? new Date(paper.curation.teamReview.proposedAt).toLocaleString()
												: "未知"}
										</small>
									</div>
									<button
										className="avant-btn avant-btn-secondary danger-hover"
										type="button"
										disabled={busy}
										onClick={() =>
											void prepare(
												"/api/team/proposals/withdraw/prepare",
												"/api/team/proposals/withdraw/execute",
												{ paperIds: [paper.id] },
											)
										}
									>
										<Trash2 size={13} />
										撤回提案
									</button>
								</div>
							))
						) : (
							<p className="clean-queue-hint">您当前没有处于待审状态的提案。</p>
						)}
					</div>
				</section>
			)}

			{/* PULL RESULTS PANEL */}
			{pullResult && (
				<section className="avant-panel pull-result-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">TRANSFER QUEUE · 传输队列</span>
							<h2>最近一次拉取结果</h2>
							<p>
								已成功同步 {pullResult.pulled} 篇文献到个人空间：新建 {pullResult.created?.length ?? 0}、更新{" "}
								{pullResult.updated?.length ?? 0}、未变更 {pullResult.unchanged?.length ?? 0}
							</p>
						</div>
					</div>

					{pullResult.pdfs?.length > 0 && (
						<div className="pull-pdf-list">
							{pullResult.pdfs.map((entry: any, index: number) => (
								<div key={`${entry.paperId}-${entry.sha256 || index}`} className="pull-pdf-item">
									<div className="pdf-item-body">
										<FileText size={14} />
										<strong>{entry.paperId}</strong>
										<code>{entry.sha256 ? entry.sha256.slice(0, 16) : "无 hash"}</code>
										{entry.reason && <span className="pdf-fail-reason">{entry.reason}</span>}
									</div>
									<StatusPill status={entry.status === "failed" ? "team-rejected" : "team-approved"} />
								</div>
							))}
						</div>
					)}
				</section>
			)}

			{/* APPROVED KNOWLEDGE SNAPSHOTS */}
			{canRead && (
				<div className="team-knowledge-archive-grid">
					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">APPROVED INTELLIGENCE · 已审核派生</span>
								<h2>已批准团队派生记忆</h2>
							</div>
						</div>
						<div className="knowledge-scroll-box">
							{(overview.derived ?? []).filter((e: any) => e.review.status === "team-approved").length ? (
								(overview.derived ?? [])
									.filter((e: any) => e.review.status === "team-approved")
									.slice(0, 40)
									.map((e: any) => (
										<div key={e.record.key} className="archive-entry-card">
											<div className="archive-header">
												<strong>{e.record.operation}</strong>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-secondary"
													onClick={() => void openKnowledge({ resource: "derived", entry: e })}
												>
													阅读研究结果
												</button>
												<StatusPill status="team-approved" />
											</div>
											<code>{e.record.key}</code>
											<small>
												{e.record.paperId} · {e.record.createdBy || "匿名"} ·{" "}
												{new Date(e.record.createdAt).toLocaleDateString()}
											</small>
										</div>
									))
							) : (
								<p className="sub-empty-text">暂无已批准的派生记录。</p>
							)}
						</div>
					</section>

					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">APPROVED ARTIFACTS · 已审核资产</span>
								<h2>已批准 Artifact 证据清单</h2>
							</div>
						</div>
						<div className="knowledge-scroll-box">
							{(overview.artifacts ?? []).filter((e: any) => e.review.status === "team-approved").length ? (
								(overview.artifacts ?? [])
									.filter((e: any) => e.review.status === "team-approved")
									.slice(0, 30)
									.map((e: any) => (
										<div key={e.paperId} className="archive-entry-card">
											<div className="archive-header">
												<strong>{e.paperId}</strong>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-secondary"
													onClick={() => void openKnowledge({ resource: "artifacts", entry: e })}
												>
													阅读材料清单
												</button>
												<StatusPill status="team-approved" />
											</div>
											<small>
												PDF {e.manifest.pdfSha256?.slice(0, 12)} · {e.manifest.candidates?.length ?? 0}{" "}
												candidates
											</small>
										</div>
									))
							) : (
								<p className="sub-empty-text">暂无已批准的 Artifact Manifest。</p>
							)}
						</div>
					</section>

					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">APPROVED PAGES · 已审核知识页</span>
								<h2>已批准知识页面</h2>
							</div>
						</div>
						<div className="knowledge-scroll-box">
							{(overview.pages ?? []).filter((e: any) => e.review.status === "team-approved").length ? (
								(overview.pages ?? [])
									.filter((e: any) => e.review.status === "team-approved")
									.slice(0, 50)
									.map((e: any) => (
										<div key={e.snapshot.key} className="archive-entry-card">
											<div className="archive-header">
												<strong>{e.snapshot.title}</strong>
												<button
													type="button"
													className="avant-btn avant-btn-sm avant-btn-secondary"
													onClick={() => void openKnowledge({ resource: "pages", entry: e })}
												>
													阅读全文
												</button>
												<StatusPill status="team-approved" />
											</div>
											<small>
												{e.snapshot.kind === "note" ? "调研笔记" : "Wiki 页面"} · 内容{" "}
												{e.snapshot.contentHash.slice(0, 12)} ·{" "}
												{e.snapshot.paperIds?.length
													? `关联 ${e.snapshot.paperIds.length} 篇论文`
													: "未关联论文"}
												{e.snapshot.createdBy ? ` · 由 ${e.snapshot.createdBy} 提案` : ""}
											</small>
										</div>
									))
							) : (
								<p className="sub-empty-text">暂无已批准的团队知识页面。</p>
							)}
						</div>
					</section>
				</div>
			)}

			{/* AUDIT LOG & MEMBER ADMINISTRATION */}
			<div className="team-admin-audit-grid">
				{/* AUDIT TRAIL */}
				<section className="avant-panel">
					<div className="panel-header-editorial">
						<div className="panel-title-block">
							<span className="avant-eyebrow">IMMUTABLE AUDIT · 审计跟踪</span>
							<h2>最近审计事件</h2>
							<p>所有提案、批准、拒绝与撤回操作均以不可变形式追加至安全审计账本。</p>
						</div>
					</div>

					<div className="audit-trail-list">
						{overview.events?.length ? (
							overview.events.slice(0, 30).map((event: any) => (
								<div key={event.id} className="audit-event-row">
									<div className="audit-actor-action">
										<strong>{event.action}</strong>
										<small>
											{event.actor} · {new Date(event.at).toLocaleTimeString()}
										</small>
									</div>
									<code className="audit-target">{event.target}</code>
								</div>
							))
						) : (
							<p className="sub-empty-text">当前角色不可查看审计日志，或尚无审计事件。</p>
						)}
					</div>
				</section>

				{/* IDENTITY & ACCESS MANAGEMENT */}
				{admin ? (
					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">GOVERNANCE & BACKUP · 节点治理</span>
								<h2>成员与安全演练</h2>
								<p>管理团队空间接入成员、生成/撤回权限凭据，或执行隔离恢复演练校验数据完备性。</p>
							</div>
						</div>

						<div className="sub-section-header">
							<FileStack size={15} />
							<div>
								<h4>备份与恢复演练</h4>
								<small>在服务端临时沙箱中校验备份包完整性与统计，绝不覆盖当前团队库。</small>
							</div>
						</div>

						<div className="restore-drill-bar" style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
							<input
								className="avant-input"
								style={{ flex: "1", minWidth: "220px" }}
								value={backupPath}
								onChange={(e) => setBackupPath(e.target.value)}
								placeholder="先创建备份，或粘贴服务端 backupPath…"
							/>
							<button
								className="avant-btn avant-btn-secondary"
								type="button"
								disabled={!backupPath.trim() || busy}
								onClick={() =>
									void prepare("/api/team/restore-drill/prepare", "/api/team/restore-drill/execute", {
										backupPath: backupPath.trim(),
									})
								}
							>
								<ShieldCheck size={14} />
								预览恢复演练
							</button>
						</div>

						<p>
							附件存储：{stats.blobCount ?? 0} 个文件 · {((stats.blobBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB
						</p>
						{Object.entries(overview.maintenance ?? {}).map(([operation, value]) => {
							const result = value as { status: string; at: string; backupPath?: string; message?: string };
							return (
								<p key={operation} role={result.status === "failed" ? "alert" : undefined}>
									{operation === "backup" ? "最近备份" : "最近恢复演练"}：
									{result.status === "succeeded" ? "成功" : "失败"} · {new Date(result.at).toLocaleString()}{" "}
									{result.message} {result.backupPath}
								</p>
							);
						})}
						<TeamMembersPanel
							identities={overview.identities ?? []}
							selfId={overview.identity?.id}
							namespace={overview.namespace}
							busy={busy}
							prepare={prepare}
						/>
					</section>
				) : (
					<section className="avant-panel">
						<div className="panel-header-editorial">
							<div className="panel-title-block">
								<span className="avant-eyebrow">ACCESS CONTROL · 访问边界</span>
								<h2>安全凭据隔离机制</h2>
								<p>
									您的当前身份：<strong>{overview.identity?.name}</strong>（权限：
									{roles.join(", ")}）
								</p>
							</div>
						</div>
						<div className="security-boundary-card">
							<Lock size={20} />
							<div>
								<strong>Token 永不进入浏览器存储</strong>
								<span>本地守护进程通过受保护的文件读取团队接入串；Web 前端仅展示脱敏后的连接状态。</span>
							</div>
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
