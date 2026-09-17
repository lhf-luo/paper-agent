import { ArrowLeft, Bot, Check, ExternalLink, FileStack, FolderOpen, NotebookPen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPage } from "./agent-page";
import { api } from "./api";
import { BrowserPdfReader } from "./browser-pdf-reader";
import { formatFileSize } from "./components";
import { MineruControl } from "./mineru-control";
import { PdfTranslationControl } from "./pdf-translation-control";
import { ReaderNoteCreatePanel, ReaderNotePanel } from "./reader-note-panels";
import { readerTabsStorageKey, readerVersionName, readerVersionState, restoredReaderTabs } from "./reader-state";
import type {
	PaperRecord,
	PaperVersionView,
	ReaderPaperDetails,
	ReaderState,
	ReaderWorkspaceTab,
	ResearchNote,
	ResearchNoteSummary,
} from "./types";

export { readerVersionName, readerVersionState };

export interface ReaderPageProps {
	reader: ReaderState;
	onBack: () => void;
	initialPrompt?: string;
	onPromptConsumed?: () => void;
	focusSessionId?: string;
}

export function ReaderPage({ reader, onBack, initialPrompt, onPromptConsumed, focusSessionId }: ReaderPageProps) {
	const restored = useRef(restoredReaderTabs(reader));
	const focusAgent = Boolean(focusSessionId || initialPrompt);
	const [activeReader, setActiveReader] = useState(reader);
	const [versions, setVersions] = useState<PaperVersionView[]>([]);
	const [paper, setPaper] = useState<PaperRecord>();
	const [linkedNotes, setLinkedNotes] = useState<ResearchNoteSummary[]>([]);
	const [tabs, setTabs] = useState<ReaderWorkspaceTab[]>(() =>
		focusAgent && !restored.current.tabs.some((tab) => tab.kind === "agent")
			? [{ id: "agent", kind: "agent", title: "AI 对话" }, ...restored.current.tabs]
			: restored.current.tabs,
	);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(focusAgent ? "agent" : restored.current.activeId);
	const [railMenu, setRailMenu] = useState<"notes" | "versions">();
	const [mobilePane, setMobilePane] = useState<"pdf" | "workspace">(focusAgent ? "workspace" : "pdf");
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
					<ArrowLeft size={16} />
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
				<a
					className="paper-reader-open"
					href={activeReader.url}
					target="_blank"
					rel="noreferrer"
					aria-label="在新标签页打开"
					title="在新标签页打开"
				>
					在新标签页打开 <ExternalLink size={13} style={{ display: "inline", verticalAlign: "middle" }} />
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
										<AgentPage
											embedded
											paperContext={paperContext}
											focusSessionId={focusSessionId}
											initialPrompt={initialPrompt}
											onPromptConsumed={onPromptConsumed}
										/>
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

export default ReaderPage;
