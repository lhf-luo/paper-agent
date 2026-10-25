import {
	BookMarked,
	BookOpen,
	Bot,
	ChevronLeft,
	ChevronRight,
	Clock,
	FileStack,
	FlaskConical,
	LayoutDashboard,
	Moon,
	Network,
	Newspaper,
	StickyNote,
	Search,
	Settings,
	Sun,
	Users,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, launchPdfPath } from "./api";
import { LoadingBlock, StatusPill } from "./components";
import { ConfirmationPolicyProvider } from "./confirmation-policy";
import { readerVersionState } from "./reader-state";
import { RouterProvider, useRouter } from "./router";
import { ThemeProvider, useTheme } from "./theme-context";
import type { Page, PaperRecord, PaperVersionView, ReaderState, ResearchNoteNavigation } from "./types";
import { useWorkspace, WorkspaceProvider } from "./workspace-context";

const DashboardPage = lazy(() => import("./dashboard-page"));
const SearchPage = lazy(() => import("./search-page"));
const ArxivNewsPage = lazy(() => import("./arxiv-news-page"));
const AgentPage = lazy(() => import("./agent-page").then((m) => ({ default: m.AgentPage })));
const LibraryPage = lazy(() => import("./library-page"));
const TasksPage = lazy(() => import("./tasks-page"));
const PdfWorkspacePage = lazy(() => import("./pdf-workspace-page"));
const ReaderPage = lazy(() => import("./reader-page"));
const TeamPage = lazy(() => import("./team-page").then((m) => ({ default: m.TeamPage })));
const ResearchNotesPage = lazy(() => import("./research-notes-page").then((m) => ({ default: m.ResearchNotesPage })));
const WikiPage = lazy(() => import("./wiki-page").then((m) => ({ default: m.WikiPage })));
const SettingsPage = lazy(() => import("./settings-page"));
const CanvasPage = lazy(() => import("./canvas-page"));
const QuickNotesPage = lazy(() => import("./quick-notes-page"));

interface NavigationSection {
	title: string;
	items: Array<{
		id: Page;
		label: string;
		icon: React.ComponentType<{ size?: number; className?: string }>;
	}>;
}

const NAVIGATION_SECTIONS: NavigationSection[] = [
	{
		title: "核心工作区",
		items: [
			{ id: "dashboard", label: "总览看板", icon: LayoutDashboard },
			{ id: "library", label: "个人文献库", icon: BookMarked },
			{ id: "search", label: "检索与收集", icon: Search },
			{ id: "news", label: "最新资讯", icon: Newspaper },
			{ id: "agent", label: "Agent 对话", icon: Bot },
		],
	},
	{
		title: "研究与证据",
		items: [
			{ id: "research", label: "个人笔记", icon: FlaskConical },
			{ id: "quick-notes", label: "随手记", icon: StickyNote },
			{ id: "canvas", label: "关系画布", icon: Network },
			{ id: "wiki", label: "研究 Wiki", icon: BookOpen },
			{ id: "pdf", label: "PDF 与 Artifact", icon: FileStack },
			{ id: "tasks", label: "任务调度中心", icon: Clock },
		],
	},
	{
		title: "协同与系统",
		items: [
			{ id: "team", label: "团队共享", icon: Users },
			{ id: "settings", label: "系统设置", icon: Settings },
		],
	},
];

const PAGE_TITLES: Record<Page, string> = {
	dashboard: "总览看板",
	library: "个人文献库",
	search: "检索与收集",
	news: "最新资讯",
	agent: "Agent 对话",
	research: "个人笔记",
	"quick-notes": "随手记",
	canvas: "关系画布",
	wiki: "研究 Wiki",
	pdf: "PDF 与 Artifact",
	tasks: "任务调度中心",
	team: "团队共享",
	settings: "系统设置",
	reader: "论文阅读器",
};

function AppShell() {
	const initialPdf = useMemo(() => launchPdfPath(), []);
	const { resolvedTheme, toggleTheme } = useTheme();
	const router = useRouter(initialPdf ? "reader" : "dashboard");
	const { page, navigate, params } = router;
	const { status, refreshStatus, lastTask, trackTask, error } = useWorkspace();

	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => window.localStorage.getItem("paper-agent-sidebar-collapsed") === "true",
	);
	const [reader, setReader] = useState<ReaderState | undefined>(() =>
		initialPdf
			? {
					title: initialPdf.split(/[\\/]/).at(-1) ?? "本地论文",
					url: `/api/local-pdf?path=${encodeURIComponent(initialPdf)}`,
					pdfPath: initialPdf,
				}
			: undefined,
	);
	const [libraryToolbarTarget, setLibraryToolbarTarget] = useState<HTMLDivElement | null>(null);
	// Held in state rather than the URL: research prompts are long and would blow past practical URL length.
	const [agentDraft, setAgentDraft] = useState<{ sessionId: string; text: string }>();
	const lastAgentSessionId = useRef<string | undefined>(
		window.localStorage.getItem("paper-agent-last-agent-session") || undefined,
	);
	const agentSessionListScrollTop = useRef(
		Math.max(0, Number(window.sessionStorage.getItem("paper-agent-agent-session-list-scroll")) || 0),
	);
	const rememberAgentSession = useCallback(
		(sessionId?: string) => {
			lastAgentSessionId.current = sessionId;
			if (sessionId) window.localStorage.setItem("paper-agent-last-agent-session", sessionId);
			else window.localStorage.removeItem("paper-agent-last-agent-session");
			if (page === "agent" && params.session !== sessionId) {
				router.updateParams({ session: sessionId ?? null });
			}
		},
		[page, params.session, router.updateParams],
	);
	const rememberAgentSessionListScroll = useCallback((scrollTop: number) => {
		agentSessionListScrollTop.current = scrollTop;
		window.sessionStorage.setItem("paper-agent-agent-session-list-scroll", String(scrollTop));
	}, []);


	// Derived from the URL rather than held in state so `?page=research&noteId=<id>`
	// still opens the same note after a refresh, when in-memory navigation state is gone.
	const researchTarget = useMemo<ResearchNoteNavigation | undefined>(
		() =>
			params.noteId || params.paperId
				? {
						...(params.noteId ? { noteId: params.noteId } : {}),
						...(params.paperId ? { paperId: params.paperId } : {}),
					}
				: undefined,
		[params.noteId, params.paperId],
	);

	// Deep-link rebuild: `?page=reader&paper=<id>` must survive a refresh, where the in-memory reader state is gone.
	const readerPaperId = router.params.paper;

	useEffect(() => {
		if (page !== "reader" || !readerPaperId) return;
		const currentPdfPage = new URLSearchParams(reader?.url.split("#")[1]).get("page") ?? "1";
		if (reader?.paperId === readerPaperId && (!params.version || reader.sha256 === params.version)
			&& currentPdfPage === (params.pdfPage ?? "1")) return;
		let cancelled = false;
		void (async () => {
			try {
				const details = await api<{ paper: PaperRecord; versions: PaperVersionView[] }>(
					`/api/papers/${encodeURIComponent(readerPaperId)}`,
				);
				if (cancelled) return;
				const version = params.version
					? details.versions.find((item) => item.sha256 === params.version)
					: details.versions.find((item) => item.isPreferred) ?? details.versions[0];
				if (version) {
					const state = readerVersionState(details.paper, version);
					if (/^[1-9]\d*$/.test(params.pdfPage ?? "")) state.url += `#page=${params.pdfPage}`;
					setReader(state);
				}
				else navigate("library", { paper: readerPaperId }, true);
			} catch {
				if (!cancelled) navigate("library", {}, true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [page, reader, readerPaperId, navigate, params.version, params.pdfPage]);

	const go = useCallback(
		(next: Page) => {
			navigate(next, next === "agent" && lastAgentSessionId.current ? { session: lastAgentSessionId.current } : {});
			void refreshStatus();
		},
		[navigate, refreshStatus],
	);

	const openReader = useCallback(
		(state: ReaderState) => {
			setReader(state);
			const pdfPage = new URLSearchParams(state.url.split("#")[1]).get("page");
			navigate("reader", state.paperId ? {
				paper: state.paperId,
				...(state.sha256 ? { version: state.sha256 } : {}),
				...(pdfPage ? { pdfPage } : {}),
			} : {});
		},
		[navigate],
	);

	const openResearchNote = useCallback(
		(target: ResearchNoteNavigation) => {
			navigate("research", {
				...(target.noteId ? { noteId: target.noteId } : {}),
				...(target.paperId ? { paperId: target.paperId } : {}),
			});
		},
		[navigate],
	);

	const title = PAGE_TITLES[page] ?? "论文阅读器";

	return (
		<RouterProvider value={router}>
			<ConfirmationPolicyProvider settings={status?.confirmations}>
				<div
					className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${page === "reader" ? " reader-active" : ""}`}
				>
					<div className="ambient-canvas" aria-hidden="true" />
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
								{sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
							</button>
							<div className="brand">
								<div className="brand-mark">P</div>
								<div className="brand-copy">
									<strong>Paper Agent</strong>
									<span>Evidence workspace</span>
								</div>
							</div>
							<nav aria-label="工作区导航">
								{NAVIGATION_SECTIONS.map((section) => (
									<div key={section.title} className="nav-section-group">
										{!sidebarCollapsed && <span className="nav-section">{section.title}</span>}
										{section.items.map((item) => {
											const Icon = item.icon;
											const isActive = page === item.id;
											return (
												<button
													key={item.id}
													className={isActive ? "active" : ""}
													type="button"
													aria-current={isActive ? "page" : undefined}
													onClick={() => go(item.id)}
													title={sidebarCollapsed ? item.label : undefined}
												>
													<span className="nav-icon">
														<Icon size={18} />
													</span>
													<span className="nav-label">{item.label}</span>
												</button>
											);
										})}
									</div>
								))}
							</nav>
							<div className="sidebar-footer">
								<span className="health-dot" />
								<div className="sidebar-footer-copy">
									<strong>本地服务已连接</strong>
									<small>{status?.recordCount ?? 0} 篇个人论文</small>
								</div>
								<button
									type="button"
									className="theme-toggle-btn"
									onClick={toggleTheme}
									title={resolvedTheme === "dark" ? "切换至浅色模式" : "切换至深色模式"}
									aria-label={resolvedTheme === "dark" ? "切换至浅色模式" : "切换至深色模式"}
								>
									{resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
								</button>
							</div>
						</aside>
					)}
					<main
						className={`main-area${page === "library" ? " main-area-library" : ""}${page === "reader" ? " main-area-reader" : ""}${page === "research" ? " main-area-research" : ""}${page === "wiki" ? " main-area-wiki" : ""}${page === "canvas" ? " main-area-canvas" : ""}`}
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
									<button
										type="button"
										className="topbar-theme-btn"
										onClick={toggleTheme}
										title={resolvedTheme === "dark" ? "切换至浅色模式" : "切换至深色模式"}
										aria-label={resolvedTheme === "dark" ? "切换至浅色模式" : "切换至深色模式"}
									>
										{resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
									</button>
								</div>
							</div>
						)}
						<div
							key={page}
							className={`page-content${page === "agent" ? " page-content-full" : page === "library" ? " page-content-library" : page === "reader" ? " page-content-reader" : page === "research" ? " page-content-research" : page === "wiki" ? " page-content-wiki" : page === "canvas" ? " page-content-canvas" : page === "settings" ? " page-content-settings" : page === "news" ? " page-content-news" : ""}`}
						>
							{error && <div className="error-banner">{error}</div>}
							<Suspense fallback={<LoadingBlock text="正在加载工作区…" />}>
								{page === "dashboard" && <DashboardPage status={status} go={go} />}
								{page === "search" && <SearchPage onTask={trackTask} />}
								{page === "news" && <ArxivNewsPage onTask={trackTask} />}
								{page === "agent" && (
									<AgentPage
										focusSessionId={params.session || lastAgentSessionId.current}
										initialSessionListScrollTop={agentSessionListScrollTop.current}
										onActiveSessionChange={rememberAgentSession}
										onSessionListScroll={rememberAgentSessionListScroll}
										initialPrompt={
											agentDraft && agentDraft.sessionId === params.session ? agentDraft.text : undefined
										}
										onPromptConsumed={() => setAgentDraft(undefined)}
									/>
								)}
								{page === "library" && (
									<LibraryPage
										focusPaperId={params.paper}
										onOpenReader={openReader}
										onTask={trackTask}
										toolbarTarget={libraryToolbarTarget}
										onOpenResearchNote={openResearchNote}
										onAgentSession={(sessionId, draft, target) => {
											setAgentDraft(draft ? { sessionId, text: draft } : undefined);
											setReader(undefined);
											navigate("reader", {
												paper: target.paperId,

												session: sessionId,
											});
										}}
									/>
								)}
								{page === "tasks" && <TasksPage />}
								{page === "pdf" && <PdfWorkspacePage onTask={trackTask} />}
								{page === "reader" && reader && (
									<ReaderPage
										reader={reader}
										onBack={() => go("library")}
										focusSessionId={params.session}
										initialPrompt={
											agentDraft && agentDraft.sessionId === params.session ? agentDraft.text : undefined
										}
										onPromptConsumed={() => setAgentDraft(undefined)}
									/>
								)}
								{page === "team" && <TeamPage />}
								{page === "research" && <ResearchNotesPage target={researchTarget} />}
								{page === "quick-notes" && <QuickNotesPage onOpenReader={openReader} />}
								{page === "canvas" && <CanvasPage onOpenReader={openReader} />}
								{page === "wiki" && <WikiPage />}
								{page === "settings" && <SettingsPage onConfigurationSaved={refreshStatus} />}
							</Suspense>
						</div>
					</main>
				</div>
			</ConfirmationPolicyProvider>
		</RouterProvider>
	);
}

export default function App() {
	return (
		<ThemeProvider>
			<WorkspaceProvider>
				<AppShell />
			</WorkspaceProvider>
		</ThemeProvider>
	);
}
