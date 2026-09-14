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
	Search,
	Settings,
	Sun,
	Users,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
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
const AgentPage = lazy(() => import("./agent-page").then((m) => ({ default: m.AgentPage })));
const LibraryPage = lazy(() => import("./library-page"));
const TasksPage = lazy(() => import("./tasks-page"));
const PdfWorkspacePage = lazy(() => import("./pdf-workspace-page"));
const ReaderPage = lazy(() => import("./reader-page"));
const TeamPage = lazy(() => import("./team-page").then((m) => ({ default: m.TeamPage })));
const ResearchNotesPage = lazy(() => import("./research-notes-page").then((m) => ({ default: m.ResearchNotesPage })));
const WikiPage = lazy(() => import("./wiki-page").then((m) => ({ default: m.WikiPage })));
const SettingsPage = lazy(() => import("./settings-page"));

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
			{ id: "agent", label: "Agent 对话", icon: Bot },
		],
	},
	{
		title: "研究与证据",
		items: [
			{ id: "research", label: "调研工作区", icon: FlaskConical },
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
	agent: "Agent 对话",
	research: "调研工作区",
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
	const { page, navigate } = router;
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
	const [researchTarget, setResearchTarget] = useState<ResearchNoteNavigation>();
	const { namespace } = useWorkspace();

	// Deep-link rebuild: `?page=reader&paper=<id>` must survive a refresh, where the in-memory reader state is gone.
	const readerPaperId = router.params.paper;
	useEffect(() => {
		if (page !== "reader" || reader || !readerPaperId) return;
		let cancelled = false;
		void (async () => {
			try {
				const details = await api<{ paper: PaperRecord; versions: PaperVersionView[] }>(
					`/api/papers/${encodeURIComponent(readerPaperId)}?namespace=${encodeURIComponent(namespace)}`,
				);
				if (cancelled) return;
				const version = details.versions.find((item) => item.isPreferred) ?? details.versions[0];
				if (version) setReader(readerVersionState(details.paper, namespace, version));
				else navigate("library", {}, true);
			} catch {
				if (!cancelled) navigate("library", {}, true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [page, reader, readerPaperId, namespace, navigate]);

	const go = useCallback(
		(next: Page) => {
			navigate(next);
			void refreshStatus();
		},
		[navigate, refreshStatus],
	);

	const openReader = useCallback(
		(state: ReaderState) => {
			setReader(state);
			navigate("reader", state.paperId ? { paper: state.paperId } : {});
		},
		[navigate],
	);

	const openResearchNote = useCallback(
		(target: ResearchNoteNavigation) => {
			setResearchTarget(target);
			navigate("research", {
				namespace: target.namespace,
				...(target.noteId ? { noteId: target.noteId } : {}),
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
									<small>{status?.defaultRecordCount ?? 0} 篇个人论文</small>
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
							className={`page-content${page === "agent" ? " page-content-full" : page === "library" ? " page-content-library" : page === "reader" ? " page-content-reader" : page === "research" ? " page-content-research" : page === "wiki" ? " page-content-wiki" : ""}`}
						>
							{error && <div className="error-banner">{error}</div>}
							<Suspense fallback={<LoadingBlock text="正在加载工作区…" />}>
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
