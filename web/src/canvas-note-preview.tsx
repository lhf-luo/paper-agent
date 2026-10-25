import { FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import type { ResearchNote, ResearchNoteSummary } from "./types";

export function CanvasNotePreview({
	noteId,
	summary,
	onClose,
	onDirtyChange,
	onSaved,
	confirmAction,
	initialMode = "preview",
}: {
	noteId: string;
	summary: ResearchNoteSummary;
	onClose: () => void;
	onDirtyChange: (dirty: boolean) => void;
	onSaved: (note: ResearchNote) => void;
	confirmAction: (message: string) => Promise<boolean>;
	initialMode?: "preview" | "edit";
}) {
	const [note, setNote] = useState<ResearchNote>();
	const [draft, setDraft] = useState("");
	const [mode, setMode] = useState<"preview" | "edit">(initialMode);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const dirty = !!note && draft !== note.markdown;
	useEffect(() => {
		let cancelled = false;
		void api<{ note: ResearchNote }>(`/api/research/notes/${encodeURIComponent(noteId)}`)
			.then((result) => {
				if (cancelled) return;
				setNote(result.note);
				setDraft(result.note.markdown);
			})
			.catch((reason) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [noteId]);

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
	useEffect(() => {
		if (!dirty) return;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		const beforeRoute = (event: Event) => {
			event.preventDefault();
			void confirmAction("笔记有未保存的修改。放弃修改并离开吗？").then((confirmed) => {
				if (!confirmed) return;
				onDirtyChange(false);
				onClose();
				(event as CustomEvent<{ proceed?: () => void }>).detail?.proceed?.();
			});
		};
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("paper-agent:before-route", beforeRoute);
		return () => {
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("paper-agent:before-route", beforeRoute);
		};
	}, [confirmAction, dirty, onClose, onDirtyChange]);

	const close = async () => {
		if (saving) return;
		if (dirty && !(await confirmAction("笔记有未保存的修改。放弃修改并关闭吗？"))) return;
		onDirtyChange(false);
		onClose();
	};
	const save = async () => {
		if (!note || !dirty || saving) return;
		setSaving(true);
		setError("");
		try {
			const result = await api<{ note: ResearchNote }>(
				`/api/research/notes/${encodeURIComponent(noteId)}`,
				jsonBody(
					{
						title: note.title,
						markdown: draft,
						expectedRevision: note.revision,
						expectedContentHash: note.contentHash,
					},
					"PATCH",
				),
			);
			setNote(result.note);
			setDraft(result.note.markdown);
			onDirtyChange(false);
			onSaved(result.note);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section
			className="research-canvas-note-panel"
			aria-label={`${note?.title ?? summary.title} 的笔记`}
			onPointerMove={(event) => event.stopPropagation()}
			onPointerUp={(event) => event.stopPropagation()}
			onPointerCancel={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") close();
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					void save();
				}
			}}
		>
			<div className="research-canvas-agent-panel-heading research-canvas-note-panel-heading">
				<div>
					<FileText size={18} aria-hidden="true" />
					<h3>{note?.title ?? summary.title}</h3>
				</div>
				<button type="button" aria-label="关闭笔记" onClick={close}>
					<X size={18} />
				</button>
			</div>
			<div className="research-canvas-paper-preview-tabs" role="tablist" aria-label="笔记显示方式">
				{(["preview", "edit"] as const).map((tab) => (
					<button
						key={tab}
						type="button"
						role="tab"
						aria-selected={mode === tab}
						className={mode === tab ? "active" : ""}
						onClick={() => setMode(tab)}
					>
						<FileText size={15} /> {tab === "preview" ? "预览" : "编辑"}
					</button>
				))}
			</div>
			{!note && !error ? (
				<p className="research-canvas-note-status">正在加载笔记…</p>
			) : mode === "edit" && note ? (
				<textarea
					className="research-canvas-note-editor"
					aria-label="Markdown 笔记内容"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					spellCheck
				/>
			) : (
				<article className="research-canvas-paper-preview-body research-canvas-note-markdown" role="tabpanel">
					{draft.trim() ? (
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
					) : (
						<p className="research-canvas-note-empty">这篇笔记还没有内容。</p>
					)}
				</article>
			)}
			{(mode === "edit" || dirty || error) && (
				<footer className="research-canvas-note-actions">
					{error && <span role="alert">{error}</span>}
					{dirty && <small>有未保存的修改</small>}
					<button type="button" disabled={!dirty || saving} onClick={() => void save()}>
						{saving ? "保存中…" : "保存"}
					</button>
				</footer>
			)}
		</section>
	);
}
