import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, EmptyState, LoadingBlock } from "./components";
import { useAutomaticOperationConfirmation } from "./confirmation-policy";
import type {
	ConfirmationGrant,
	PaperRecord,
	PreparedOperation,
	ResearchNote,
	ResearchNoteFolder,
	ResearchNoteNavigation,
	ResearchNoteSummary,
	ResearchNoteTemplate,
} from "./types";

type PendingAction =
	| { kind: "create-note"; operation: PreparedOperation; payload: Record<string, unknown> }
	| { kind: "delete-note"; operation: PreparedOperation; payload: Record<string, unknown>; noteId: string }
	| { kind: "create-folder"; operation: PreparedOperation; payload: Record<string, unknown> }
	| { kind: "delete-folder"; operation: PreparedOperation; payload: Record<string, unknown> };

type FolderEditor = { id?: string; name: string; parentId?: string };
type NoteEditor = { note: ResearchNote; title: string; folderId?: string; paperIds: Set<string> };

function formatUpdatedAt(value: string): string {
	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

function tabsKey(namespace: string): string {
	return `paper-agent-research-tabs:${namespace}`;
}

function expandedKey(namespace: string): string {
	return `paper-agent-research-folders:${namespace}`;
}

function storedTabs(namespace: string, validIds: Set<string>): { ids: string[]; activeId?: string } {
	try {
		const parsed = JSON.parse(window.localStorage.getItem(tabsKey(namespace)) ?? "{}") as {
			ids?: string[];
			activeId?: string;
		};
		const ids = (parsed.ids ?? []).filter((id) => validIds.has(id));
		return { ids, activeId: ids.includes(parsed.activeId ?? "") ? parsed.activeId : ids[0] };
	} catch {
		return { ids: [] };
	}
}

export function ResearchNotesPage({ target }: { target?: ResearchNoteNavigation }) {
	const targetNamespace = target?.namespace;
	const targetNoteId = target?.noteId;
	const targetPaperId = target?.paperId;
	const [namespace, setNamespace] = useState(targetNamespace ?? "default");
	const [notes, setNotes] = useState<ResearchNoteSummary[]>([]);
	const [folders, setFolders] = useState<ResearchNoteFolder[]>([]);
	const [templates, setTemplates] = useState<ResearchNoteTemplate[]>([]);
	const [papers, setPapers] = useState<PaperRecord[]>([]);
	const [openNoteIds, setOpenNoteIds] = useState<string[]>([]);
	const [activeId, setActiveId] = useState<string>();
	const [active, setActive] = useState<ResearchNote>();
	const [draftMarkdown, setDraftMarkdown] = useState("");
	const [noteQuery, setNoteQuery] = useState("");
	const [paperQuery, setPaperQuery] = useState("");
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [newMenuOpen, setNewMenuOpen] = useState(false);
	const [menuKey, setMenuKey] = useState<string>();
	const [createOpen, setCreateOpen] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [newTemplateId, setNewTemplateId] = useState("blank");
	const [newFolderId, setNewFolderId] = useState("");
	const [newPaperIds, setNewPaperIds] = useState<Set<string>>(new Set());
	const [folderEditor, setFolderEditor] = useState<FolderEditor>();
	const [noteEditor, setNoteEditor] = useState<NoteEditor>();
	const [pending, setPending] = useState<PendingAction>();
	const [busy, setBusy] = useState(false);
	const mutationBusy = useRef(false);
	const refreshBusy = useRef(false);
	const targetHandled = useRef<string | undefined>(undefined);

	const loadIndex = useCallback(async () => {
		const [noteResult, folderResult] = await Promise.all([
			api<{ notes: ResearchNoteSummary[] }>(`/api/research/notes?namespace=${encodeURIComponent(namespace)}`),
			api<{ folders: ResearchNoteFolder[] }>(`/api/research/folders?namespace=${encodeURIComponent(namespace)}`),
		]);
		setNotes(noteResult.notes);
		setFolders(folderResult.folders);
		return { notes: noteResult.notes, folders: folderResult.folders };
	}, [namespace]);

	const fetchNote = useCallback(
		async (noteId: string) =>
			(
				await api<{ note: ResearchNote }>(
					`/api/research/notes/${encodeURIComponent(noteId)}?namespace=${encodeURIComponent(namespace)}`,
				)
			).note,
		[namespace],
	);

	useEffect(() => {
		if (targetNamespace) setNamespace(targetNamespace);
		else {
			void api<{ defaultNamespace: string }>("/api/namespaces")
				.then((value) => setNamespace(value.defaultNamespace))
				.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
		}
	}, [targetNamespace]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setActive(undefined);
		setPending(undefined);
		Promise.all([
			loadIndex(),
			api<{ templates: ResearchNoteTemplate[] }>(
				`/api/research/templates?namespace=${encodeURIComponent(namespace)}`,
			),
			api<{ hits: Array<{ record: PaperRecord }> }>(
				`/api/library?namespace=${encodeURIComponent(namespace)}&limit=1000`,
			),
		])
			.then(([loadedIndex, templateResult, paperResult]) => {
				if (cancelled) return;
				setTemplates(templateResult.templates);
				setPapers(paperResult.hits.map((hit) => hit.record));
				const validIds = new Set(loadedIndex.notes.map((note) => note.id));
				const restored = storedTabs(namespace, validIds);
				setOpenNoteIds(restored.ids);
				setActiveId(restored.activeId);
				try {
					const saved = window.localStorage.getItem(expandedKey(namespace));
					setExpanded(
						saved
							? new Set(JSON.parse(saved) as string[])
							: new Set(loadedIndex.folders.map((folder) => folder.id)),
					);
				} catch {
					setExpanded(new Set());
				}
				const targetKey = targetNamespace
					? `${targetNamespace}:${targetNoteId ?? "new"}:${targetPaperId ?? ""}`
					: "";
				if (targetNoteId && validIds.has(targetNoteId) && targetHandled.current !== targetKey) {
					targetHandled.current = targetKey;
					setOpenNoteIds((ids) => (ids.includes(targetNoteId) ? ids : [...ids, targetNoteId]));
					setActiveId(targetNoteId);
				} else if (targetPaperId && targetHandled.current !== targetKey) {
					targetHandled.current = targetKey;
					setNewPaperIds(new Set([targetPaperId]));
					setCreateOpen(true);
				}
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, [loadIndex, namespace, targetNamespace, targetNoteId, targetPaperId]);

	useEffect(() => {
		if (!activeId) {
			setActive(undefined);
			return;
		}
		let cancelled = false;
		void fetchNote(activeId)
			.then((note) => {
				if (cancelled) return;
				setActive(note);
				setDraftMarkdown(note.markdown);
				setSaveState("idle");
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => {
			cancelled = true;
		};
	}, [activeId, fetchNote]);

	useEffect(() => {
		if (loading) return;
		window.localStorage.setItem(tabsKey(namespace), JSON.stringify({ ids: openNoteIds, activeId }));
	}, [activeId, loading, namespace, openNoteIds]);

	useEffect(() => {
		if (loading) return;
		window.localStorage.setItem(expandedKey(namespace), JSON.stringify([...expanded]));
	}, [expanded, loading, namespace]);

	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(() => setMessage(""), 4_000);
		return () => window.clearTimeout(timer);
	}, [message]);

	useEffect(() => {
		if (!menuKey && !newMenuOpen) return;
		const close = (event: PointerEvent) => {
			if (!(event.target as Element).closest(".research-tree-menu-wrap, .research-new-menu-wrap")) {
				setMenuKey(undefined);
				setNewMenuOpen(false);
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenuKey(undefined);
				setNewMenuOpen(false);
				setFolderEditor(undefined);
				setNoteEditor(undefined);
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menuKey, newMenuOpen]);

	const refreshNote = useCallback(
		async (note: ResearchNote) => {
			setActive(note);
			setDraftMarkdown(note.markdown);
			await loadIndex();
		},
		[loadIndex],
	);

	const saveDraftNow = useCallback(async (): Promise<boolean> => {
		if (!active || draftMarkdown === active.markdown) return true;
		if (mutationBusy.current) return false;
		mutationBusy.current = true;
		setSaveState("saving");
		try {
			const result = await api<{ note: ResearchNote }>(
				`/api/research/notes/${encodeURIComponent(active.id)}`,
				jsonBody(
					{
						namespace,
						title: active.title,
						markdown: draftMarkdown,
						expectedRevision: active.revision,
						expectedContentHash: active.contentHash,
					},
					"PATCH",
				),
			);
			await refreshNote(result.note);
			setSaveState("saved");
			return true;
		} catch (reason) {
			const text = reason instanceof Error ? reason.message : String(reason);
			setSaveState(/changed since|revision conflict/i.test(text) ? "conflict" : "error");
			setError(text);
			return false;
		} finally {
			mutationBusy.current = false;
		}
	}, [active, draftMarkdown, namespace, refreshNote]);

	const refreshFromDisk = useCallback(
		async (showMessage = false) => {
			if (refreshBusy.current) return;
			refreshBusy.current = true;
			if (!(await saveDraftNow())) {
				refreshBusy.current = false;
				return;
			}
			setLoading(true);
			try {
				const loaded = await loadIndex();
				const validIds = new Set(loaded.notes.map((note) => note.id));
				const nextOpenIds = openNoteIds.filter((id) => validIds.has(id));
				setOpenNoteIds(nextOpenIds);
				if (activeId && validIds.has(activeId)) {
					const note = await fetchNote(activeId);
					setActive(note);
					setDraftMarkdown(note.markdown);
					setSaveState("idle");
				} else if (activeId) {
					setActiveId(nextOpenIds[0]);
					setActive(undefined);
				}
				if (showMessage) setMessage("已同步外部笔记更改");
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setLoading(false);
				refreshBusy.current = false;
			}
		},
		[activeId, fetchNote, loadIndex, openNoteIds, saveDraftNow],
	);

	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") void refreshFromDisk();
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [refreshFromDisk]);

	useEffect(() => {
		if (!active || draftMarkdown === active.markdown) return;
		const timer = window.setTimeout(() => void saveDraftNow(), 700);
		return () => window.clearTimeout(timer);
	}, [active, draftMarkdown, saveDraftNow]);

	const openNote = async (noteId: string) => {
		if (activeId === noteId || !(await saveDraftNow())) return;
		setOpenNoteIds((ids) => (ids.includes(noteId) ? ids : [...ids, noteId]));
		setActiveId(noteId);
		setCreateOpen(false);
	};

	const closeNote = async (noteId: string) => {
		if (noteId === activeId && !(await saveDraftNow())) return;
		setOpenNoteIds((ids) => {
			const index = ids.indexOf(noteId);
			const next = ids.filter((id) => id !== noteId);
			if (noteId === activeId) setActiveId(next[Math.min(index, next.length - 1)]);
			return next;
		});
	};

	const executePending = useCallback(async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending.operation)) as ConfirmationGrant;
			if (pending.kind === "create-note") {
				const result = await api<{ note: ResearchNote }>(
					"/api/research/notes/create/execute",
					jsonBody({ ...pending.payload, grant }),
				);
				setCreateOpen(false);
				setNewTitle("");
				setNewPaperIds(new Set());
				setOpenNoteIds((ids) => [...ids.filter((id) => id !== result.note.id), result.note.id]);
				setActiveId(result.note.id);
				await loadIndex();
				setMessage("笔记已创建");
			} else if (pending.kind === "delete-note") {
				await api("/api/research/notes/delete/execute", jsonBody({ ...pending.payload, grant }));
				setOpenNoteIds((ids) => {
					const index = ids.indexOf(pending.noteId);
					const next = ids.filter((id) => id !== pending.noteId);
					if (activeId === pending.noteId) setActiveId(next[Math.min(index, next.length - 1)]);
					return next;
				});
				await loadIndex();
				setMessage("笔记已删除");
			} else if (pending.kind === "create-folder") {
				await api("/api/research/folders/create/execute", jsonBody({ ...pending.payload, grant }));
				setFolderEditor(undefined);
				await loadIndex();
				setMessage("文件夹已创建");
			} else {
				await api("/api/research/folders/delete/execute", jsonBody({ ...pending.payload, grant }));
				await loadIndex();
				setMessage("文件夹已删除");
			}
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}, [activeId, loadIndex, pending]);

	const automaticConfirmation = useAutomaticOperationConfirmation(pending?.operation, busy, executePending);

	const prepareCreateNote = async () => {
		if (!newTitle.trim()) return setError("请输入笔记名称");
		const payload = {
			namespace,
			title: newTitle,
			templateId: newTemplateId,
			paperIds: [...newPaperIds],
			...(newFolderId ? { folderId: newFolderId } : {}),
		};
		try {
			const operation = await api<PreparedOperation>("/api/research/notes/create/prepare", jsonBody(payload));
			setPending({ kind: "create-note", operation, payload });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const prepareDeleteNote = async (noteId: string) => {
		const payload = { namespace, noteId, author: "interactive-user" };
		try {
			const operation = await api<PreparedOperation>("/api/research/notes/delete/prepare", jsonBody(payload));
			setPending({ kind: "delete-note", operation, payload, noteId });
			setMenuKey(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const submitFolder = async () => {
		if (!folderEditor?.name.trim()) return setError("请输入文件夹名称");
		const payload = {
			namespace,
			name: folderEditor.name,
			...(folderEditor.parentId ? { parentId: folderEditor.parentId } : {}),
		};
		try {
			if (folderEditor.id) {
				await api(
					`/api/research/folders/${encodeURIComponent(folderEditor.id)}`,
					jsonBody({ ...payload, parentId: folderEditor.parentId || null }, "PATCH"),
				);
				setFolderEditor(undefined);
				await loadIndex();
				setMessage("文件夹已更新");
			} else {
				const operation = await api<PreparedOperation>("/api/research/folders/create/prepare", jsonBody(payload));
				setPending({ kind: "create-folder", operation, payload });
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const prepareDeleteFolder = async (folderId: string) => {
		const hasContent =
			folders.some((folder) => folder.parentId === folderId) || notes.some((note) => note.folderId === folderId);
		if (hasContent) return setError("文件夹不是空的，请先移动或删除其中的内容");
		const payload = { namespace, folderId };
		try {
			const operation = await api<PreparedOperation>("/api/research/folders/delete/prepare", jsonBody(payload));
			setPending({ kind: "delete-folder", operation, payload });
			setMenuKey(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const startEditNote = async (noteId: string) => {
		if (noteId === activeId && !(await saveDraftNow())) return;
		try {
			const note = await fetchNote(noteId);
			setNoteEditor({
				note,
				title: note.title,
				folderId: note.folderId,
				paperIds: new Set(note.papers.map((paper) => paper.id)),
			});
			setPaperQuery("");
			setMenuKey(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const submitNoteEdit = async () => {
		if (!noteEditor?.title.trim()) return setError("请输入笔记名称");
		try {
			const result = await api<{ note: ResearchNote }>(
				`/api/research/notes/${encodeURIComponent(noteEditor.note.id)}`,
				jsonBody(
					{
						namespace,
						title: noteEditor.title,
						markdown: noteEditor.note.markdown,
						folderId: noteEditor.folderId || null,
						paperIds: [...noteEditor.paperIds],
						expectedRevision: noteEditor.note.revision,
						expectedContentHash: noteEditor.note.contentHash,
					},
					"PATCH",
				),
			);
			setNoteEditor(undefined);
			if (activeId === result.note.id) {
				setActive(result.note);
				setDraftMarkdown(result.note.markdown);
			}
			await loadIndex();
			setMessage("笔记已更新");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const visiblePapers = useMemo(() => {
		const query = paperQuery.trim().toLocaleLowerCase();
		return (
			query
				? papers.filter((paper) =>
						`${paper.title} ${paper.authors.join(" ")} ${paper.id}`.toLocaleLowerCase().includes(query),
					)
				: papers
		).slice(0, 100);
	}, [paperQuery, papers]);
	const folderChildren = useMemo(() => {
		const result = new Map<string, ResearchNoteFolder[]>();
		for (const folder of folders) {
			const key = folder.parentId ?? "root";
			result.set(key, [...(result.get(key) ?? []), folder]);
		}
		for (const values of result.values()) values.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
		return result;
	}, [folders]);
	const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
	const notesByFolder = useMemo(() => {
		const result = new Map<string, ResearchNoteSummary[]>();
		for (const note of notes) {
			const key = note.folderId ?? "root";
			result.set(key, [...(result.get(key) ?? []), note]);
		}
		return result;
	}, [notes]);
	const visibleNotes = useMemo(() => {
		const query = noteQuery.trim().toLocaleLowerCase();
		return query
			? notes.filter((note) => `${note.title} ${note.folderPath ?? ""}`.toLocaleLowerCase().includes(query))
			: [];
	}, [noteQuery, notes]);

	const folderOptions = (excludedId?: string) => {
		const excluded = new Set<string>();
		if (excludedId) {
			const visit = (id: string) => {
				excluded.add(id);
				for (const child of folderChildren.get(id) ?? []) visit(child.id);
			};
			visit(excludedId);
		}
		return folders
			.filter((folder) => !excluded.has(folder.id))
			.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	};
	const folderLabel = (folder: ResearchNoteFolder) => {
		const names = [folder.name];
		let parentId = folder.parentId;
		while (parentId) {
			const parent = folderById.get(parentId);
			if (!parent) break;
			names.unshift(parent.name);
			parentId = parent.parentId;
		}
		return names.join(" / ");
	};

	const noteRow = (note: ResearchNoteSummary, depth = 0) => (
		<div
			className={`research-note-tree-note${activeId === note.id ? " active" : ""}`}
			key={note.id}
			style={{ paddingLeft: 14 + depth * 16 }}
		>
			<button type="button" className="research-note-tree-main" onClick={() => void openNote(note.id)}>
				<strong>{note.title}</strong>
				<span>
					{note.papers.length} 篇论文 · {formatUpdatedAt(note.updatedAt)}
				</span>
			</button>
			<div className="research-tree-menu-wrap">
				<button
					type="button"
					className="icon-button"
					title="笔记操作"
					aria-label={`${note.title}操作`}
					onClick={() => setMenuKey(menuKey === `note:${note.id}` ? undefined : `note:${note.id}`)}
				>
					<MoreHorizontal size={16} />
				</button>
				{menuKey === `note:${note.id}` && (
					<div className="research-tree-menu" role="menu" onMouseLeave={() => setMenuKey(undefined)}>
						<button type="button" onClick={() => void startEditNote(note.id)}>
							修改
						</button>
						<button type="button" className="danger" onClick={() => void prepareDeleteNote(note.id)}>
							删除
						</button>
					</div>
				)}
			</div>
		</div>
	);

	const folderRows = (parentId = "root", depth = 0): React.ReactNode => (
		<>
			{(folderChildren.get(parentId) ?? []).map((folder) => {
				const open = expanded.has(folder.id);
				const hasChildren =
					(folderChildren.get(folder.id)?.length ?? 0) + (notesByFolder.get(folder.id)?.length ?? 0) > 0;
				return (
					<div className="research-folder-branch" key={folder.id}>
						<div className="research-folder-row" style={{ paddingLeft: 7 + depth * 16 }}>
							<button
								type="button"
								className="research-folder-main"
								onClick={() =>
									setExpanded((current) => {
										const next = new Set(current);
										next.has(folder.id) ? next.delete(folder.id) : next.add(folder.id);
										return next;
									})
								}
							>
								<ChevronRight className={open ? "open" : undefined} size={15} />
								<span className="research-folder-icon">
									{open ? <FolderOpen size={16} /> : <Folder size={16} />}
								</span>
								<span>{folder.name}</span>
							</button>
							<div className="research-tree-menu-wrap">
								<button
									type="button"
									className="icon-button"
									title="文件夹操作"
									aria-label={`${folder.name}操作`}
									onClick={() =>
										setMenuKey(menuKey === `folder:${folder.id}` ? undefined : `folder:${folder.id}`)
									}
								>
									<MoreHorizontal size={16} />
								</button>
								{menuKey === `folder:${folder.id}` && (
									<div className="research-tree-menu" role="menu" onMouseLeave={() => setMenuKey(undefined)}>
										<button
											type="button"
											onClick={() => {
												setFolderEditor({ name: "", parentId: folder.id });
												setMenuKey(undefined);
											}}
										>
											新建子文件夹
										</button>
										<button
											type="button"
											onClick={() => {
												setFolderEditor({ id: folder.id, name: folder.name, parentId: folder.parentId });
												setMenuKey(undefined);
											}}
										>
											修改
										</button>
										<button
											type="button"
											className="danger"
											onClick={() => void prepareDeleteFolder(folder.id)}
										>
											删除
										</button>
									</div>
								)}
							</div>
						</div>
						{open && hasChildren && (
							<div>
								{folderRows(folder.id, depth + 1)}
								{(notesByFolder.get(folder.id) ?? []).map((note) => noteRow(note, depth + 1))}
							</div>
						)}
					</div>
				);
			})}
		</>
	);

	const saveLabel = { idle: "", saving: "正在保存", saved: "已保存", error: "保存失败", conflict: "文件已在外部修改" }[
		saveState
	];

	return (
		<div className="research-notebook-page">
			{error && (
				<div className="error-banner research-note-banner">
					<span>{error}</span>
					<button type="button" onClick={() => setError("")}>
						关闭
					</button>
				</div>
			)}
			{message && <div className="success-banner research-note-banner">{message}</div>}
			{pending && automaticConfirmation.confirmationRequired && (
				<ConsentCard
					operation={pending.operation}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={executePending}
				/>
			)}
			<div className="research-notebook-layout">
				<aside className={`research-note-sidebar${active || createOpen ? " has-active-note" : ""}`}>
					<header className="research-note-sidebar-header">
						<div>
							<h1>调研笔记</h1>
							<span>{notes.length} 篇</span>
						</div>
						<div className="research-note-header-actions">
							<button
								type="button"
								className="icon-button"
								title="同步外部笔记更改"
								aria-label="同步外部笔记更改"
								disabled={loading}
								onClick={() => void refreshFromDisk(true)}
							>
								<RefreshCw size={16} />
							</button>
							<div className="research-new-menu-wrap">
								<button
									type="button"
									className="button primary compact"
									onClick={() => setNewMenuOpen((value) => !value)}
								>
									<Plus size={15} /> 新建
								</button>
								{newMenuOpen && (
									<div className="research-tree-menu" role="menu" onMouseLeave={() => setNewMenuOpen(false)}>
										<button
											type="button"
											onClick={() => {
												setCreateOpen(true);
												setNewMenuOpen(false);
											}}
										>
											笔记
										</button>
										<button
											type="button"
											onClick={() => {
												setFolderEditor({ name: "" });
												setNewMenuOpen(false);
											}}
										>
											文件夹
										</button>
									</div>
								)}
							</div>
						</div>
					</header>
					<input
						className="research-note-search"
						value={noteQuery}
						onChange={(event) => setNoteQuery(event.target.value)}
						placeholder="搜索笔记"
					/>
					<div className="research-note-list">
						{loading ? (
							<LoadingBlock text="正在加载笔记" />
						) : noteQuery.trim() ? (
							visibleNotes.map((note) => noteRow(note))
						) : (
							<>
								{folderRows()}
								{(notesByFolder.get("root") ?? []).map((note) => noteRow(note))}
							</>
						)}
						{!loading && !notes.length && !folders.length && (
							<EmptyState title="暂无笔记" text="新建一篇笔记开始整理调研内容。" />
						)}
					</div>
				</aside>
				<main className="research-note-editor">
					{openNoteIds.length > 0 && (
						<div className="research-note-tabs" role="tablist">
							{openNoteIds.map((id) => {
								const note = notes.find((item) => item.id === id);
								return note ? (
									<div className={`research-note-tab${activeId === id ? " active" : ""}`} key={id}>
										<button
											type="button"
											role="tab"
											aria-selected={activeId === id}
											onClick={() => void openNote(id)}
										>
											{note.title}
										</button>
										<button
											type="button"
											className="icon-button"
											title="关闭标签"
											aria-label={`关闭${note.title}`}
											onClick={() => void closeNote(id)}
										>
											<X size={13} />
										</button>
									</div>
								) : null;
							})}
						</div>
					)}
					{createOpen ? (
						<CreateNoteForm
							title={newTitle}
							setTitle={setNewTitle}
							folderId={newFolderId}
							setFolderId={setNewFolderId}
							templateId={newTemplateId}
							setTemplateId={setNewTemplateId}
							templates={templates}
							folders={folderOptions()}
							folderLabel={folderLabel}
							paperQuery={paperQuery}
							setPaperQuery={setPaperQuery}
							papers={visiblePapers}
							selected={newPaperIds}
							setSelected={setNewPaperIds}
							busy={busy}
							onCancel={() => setCreateOpen(false)}
							onCreate={prepareCreateNote}
						/>
					) : active ? (
						<>
							<header className="research-note-editor-header">
								<button
									className="research-note-mobile-back"
									type="button"
									onClick={() => void closeNote(active.id)}
								>
									返回列表
								</button>
								<strong className="research-note-title">{active.title}</strong>
								<div className="research-note-editor-actions">
									{saveLabel && <span className={`research-note-save-state ${saveState}`}>{saveLabel}</span>}
									<fieldset className="segmented-control" aria-label="笔记显示方式">
										<button
											type="button"
											className={mode === "edit" ? "active" : undefined}
											onClick={() => setMode("edit")}
										>
											编辑
										</button>
										<button
											type="button"
											className={mode === "preview" ? "active" : undefined}
											onClick={() => setMode("preview")}
										>
											预览
										</button>
									</fieldset>
								</div>
							</header>
							<div className="research-note-paper-links">
								{active.papers.map((paper) => (
									<span key={paper.id} title={paper.id}>
										{paper.title}
									</span>
								))}
							</div>
							{mode === "edit" ? (
								<textarea
									className="research-markdown-editor"
									value={draftMarkdown}
									onChange={(event) => setDraftMarkdown(event.target.value)}
									placeholder="开始记录你的调研内容…"
									spellCheck
								/>
							) : (
								<article className="research-markdown-preview">
									{draftMarkdown.trim() ? (
										<ReactMarkdown remarkPlugins={[remarkGfm]}>{draftMarkdown}</ReactMarkdown>
									) : (
										<p className="research-note-placeholder">这篇笔记还没有内容。</p>
									)}
								</article>
							)}
						</>
					) : (
						<EmptyState title="选择一篇笔记" text="从左侧打开已有笔记，或新建一篇 Markdown 笔记。" />
					)}
				</main>
			</div>
			{folderEditor && (
				<div className="research-note-dialog">
					<section>
						<header>
							<h2>{folderEditor.id ? "修改文件夹" : "新建文件夹"}</h2>
							<button
								className="icon-button"
								type="button"
								title="关闭"
								onClick={() => setFolderEditor(undefined)}
							>
								<X size={17} />
							</button>
						</header>
						<label>
							<span>名称</span>
							<input
								value={folderEditor.name}
								onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })}
							/>
						</label>
						<label>
							<span>上级文件夹</span>
							<select
								value={folderEditor.parentId ?? ""}
								onChange={(event) =>
									setFolderEditor({ ...folderEditor, parentId: event.target.value || undefined })
								}
							>
								<option value="">根目录</option>
								{folderOptions(folderEditor.id).map((folder) => (
									<option key={folder.id} value={folder.id}>
										{folderLabel(folder)}
									</option>
								))}
							</select>
						</label>
						<footer>
							<button className="button secondary" type="button" onClick={() => setFolderEditor(undefined)}>
								取消
							</button>
							<button className="button primary" type="button" onClick={() => void submitFolder()}>
								保存
							</button>
						</footer>
					</section>
				</div>
			)}
			{noteEditor && (
				<div className="research-note-dialog">
					<section className="research-note-edit-card">
						<header>
							<h2>修改笔记</h2>
							<button
								className="icon-button"
								type="button"
								title="关闭"
								onClick={() => setNoteEditor(undefined)}
							>
								<X size={17} />
							</button>
						</header>
						<label>
							<span>标题</span>
							<input
								value={noteEditor.title}
								onChange={(event) => setNoteEditor({ ...noteEditor, title: event.target.value })}
							/>
						</label>
						<label>
							<span>文件夹</span>
							<select
								value={noteEditor.folderId ?? ""}
								onChange={(event) =>
									setNoteEditor({ ...noteEditor, folderId: event.target.value || undefined })
								}
							>
								<option value="">根目录</option>
								{folderOptions().map((folder) => (
									<option key={folder.id} value={folder.id}>
										{folderLabel(folder)}
									</option>
								))}
							</select>
						</label>
						<PaperPicker
							query={paperQuery}
							setQuery={setPaperQuery}
							papers={visiblePapers}
							selected={noteEditor.paperIds}
							setSelected={(ids) => setNoteEditor({ ...noteEditor, paperIds: ids })}
						/>
						<footer>
							<button className="button secondary" type="button" onClick={() => setNoteEditor(undefined)}>
								取消
							</button>
							<button className="button primary" type="button" onClick={() => void submitNoteEdit()}>
								保存修改
							</button>
						</footer>
					</section>
				</div>
			)}
		</div>
	);
}

function PaperPicker({
	query,
	setQuery,
	papers,
	selected,
	setSelected,
}: {
	query: string;
	setQuery: (value: string) => void;
	papers: PaperRecord[];
	selected: Set<string>;
	setSelected: (value: Set<string>) => void;
}) {
	return (
		<div className="research-paper-picker">
			<div className="research-paper-picker-heading">
				<strong>关联论文</strong>
				<span>已选 {selected.size} 篇</span>
			</div>
			<input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="按标题、作者或 paper_id 搜索"
			/>
			<div className="research-paper-options">
				{papers.map((paper) => (
					<label key={paper.id}>
						<input
							type="checkbox"
							checked={selected.has(paper.id)}
							onChange={(event) => {
								const next = new Set(selected);
								event.target.checked ? next.add(paper.id) : next.delete(paper.id);
								setSelected(next);
							}}
						/>
						<span>
							<strong>{paper.title}</strong>
							<small>
								{paper.id} · {paper.authors.slice(0, 3).join(", ")}
							</small>
						</span>
					</label>
				))}
			</div>
		</div>
	);
}

function CreateNoteForm({
	title,
	setTitle,
	folderId,
	setFolderId,
	templateId,
	setTemplateId,
	templates,
	folders,
	folderLabel,
	paperQuery,
	setPaperQuery,
	papers,
	selected,
	setSelected,
	busy,
	onCancel,
	onCreate,
}: {
	title: string;
	setTitle: (value: string) => void;
	folderId: string;
	setFolderId: (value: string) => void;
	templateId: string;
	setTemplateId: (value: string) => void;
	templates: ResearchNoteTemplate[];
	folders: ResearchNoteFolder[];
	folderLabel: (folder: ResearchNoteFolder) => string;
	paperQuery: string;
	setPaperQuery: (value: string) => void;
	papers: PaperRecord[];
	selected: Set<string>;
	setSelected: (value: Set<string>) => void;
	busy: boolean;
	onCancel: () => void;
	onCreate: () => void;
}) {
	return (
		<section className="research-note-create" aria-label="新建笔记">
			<header>
				<h2>新建笔记</h2>
				<button type="button" className="text-button" onClick={onCancel}>
					取消
				</button>
			</header>
			<label>
				<span>笔记名称</span>
				<input value={title} onChange={(event) => setTitle(event.target.value)} />
			</label>
			<label>
				<span>文件夹</span>
				<select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
					<option value="">根目录</option>
					{folders.map((folder) => (
						<option key={folder.id} value={folder.id}>
							{folderLabel(folder)}
						</option>
					))}
				</select>
			</label>
			<label>
				<span>模板</span>
				<select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
					{templates.map((template) => (
						<option key={template.id} value={template.id}>
							{template.name}
						</option>
					))}
				</select>
			</label>
			<PaperPicker
				query={paperQuery}
				setQuery={setPaperQuery}
				papers={papers}
				selected={selected}
				setSelected={setSelected}
			/>
			<button className="button primary" type="button" disabled={busy || !title.trim()} onClick={onCreate}>
				创建笔记
			</button>
		</section>
	);
}
