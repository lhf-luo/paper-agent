import { FileText, Grip, X } from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import type { ResearchNote, ResearchNoteSummary } from "./types";

type NoteFrame = { left: number; top: number; width: number; height: number };

function fitFrameToStage(current: NoteFrame, stage: { width: number; height: number }): NoteFrame {
	if (!stage.width || !stage.height) return current;
	const width = Math.min(current.width, Math.max(180, stage.width - 24));
	const height = Math.min(current.height, Math.max(150, stage.height - 24));
	return {
		left: Math.max(12, Math.min(current.left, stage.width - width - 12)),
		top: Math.max(12, Math.min(current.top, stage.height - height - 12)),
		width,
		height,
	};
}

export function CanvasNotePreview({
	namespace,
	noteId,
	summary,
	placement,
	onClose,
	onDirtyChange,
	onSaved,
	confirmAction,
}: {
	namespace: string;
	noteId: string;
	summary: ResearchNoteSummary;
	placement: NoteFrame;
	onClose: () => void;
	onDirtyChange: (dirty: boolean) => void;
	onSaved: (note: ResearchNote) => void;
	confirmAction: (message: string) => Promise<boolean>;
}) {
	const [note, setNote] = useState<ResearchNote>();
	const [draft, setDraft] = useState("");
	const [mode, setMode] = useState<"preview" | "edit">("preview");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [frame, setFrame] = useState(placement);
	const [dragging, setDragging] = useState(false);
	const cardRef = useRef<HTMLElement>(null);
	const dragRef = useRef<
		| {
				pointerId: number;
				startX: number;
				startY: number;
				left: number;
				top: number;
				active: boolean;
				timer: number;
				cleanup: () => void;
		  }
		| undefined
	>(undefined);
	const resizeRef = useRef<
		| {
				pointerId: number;
				startX: number;
				startY: number;
				width: number;
				height: number;
				left: number;
				top: number;
				cleanup: () => void;
		  }
		| undefined
	>(undefined);
	const dirty = !!note && draft !== note.markdown;
	const stageSize = () => ({
		width: cardRef.current?.parentElement?.clientWidth ?? 0,
		height: cardRef.current?.parentElement?.clientHeight ?? 0,
	});
	useEffect(() => {
		const stage = cardRef.current?.parentElement;
		if (!stage) return;
		const observer = new ResizeObserver(() =>
			setFrame((current) => fitFrameToStage(current, { width: stage.clientWidth, height: stage.clientHeight })),
		);
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);
	useEffect(
		() => () => {
			if (dragRef.current) {
				window.clearTimeout(dragRef.current.timer);
				dragRef.current.cleanup();
			}
			resizeRef.current?.cleanup();
		},
		[],
	);
	const endDrag = () => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = undefined;
		window.clearTimeout(drag.timer);
		drag.cleanup();
		setDragging(false);
	};
	const startDrag = (event: PointerEvent<HTMLElement>) => {
		event.stopPropagation();
		if (event.button !== 0 || dragRef.current || resizeRef.current) return;
		const target = event.target;
		if (
			target instanceof Element &&
			(target.closest("button, input, textarea, select, a, [contenteditable], .research-canvas-note-resize-grip") ||
				(target.closest(".research-canvas-note-markdown") &&
					event.clientX >= target.closest(".research-canvas-note-markdown")!.getBoundingClientRect().right - 18))
		)
			return;
		const pending = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			left: frame.left,
			top: frame.top,
			active: false,
			timer: 0,
			cleanup: () => {},
		};
		const move = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId !== pending.pointerId) return;
			const dx = pointer.clientX - pending.startX;
			const dy = pointer.clientY - pending.startY;
			if (!pending.active) {
				if (Math.hypot(dx, dy) > 6) endDrag();
				return;
			}
			pointer.preventDefault();
			setFrame((current) =>
				fitFrameToStage({ ...current, left: pending.left + dx, top: pending.top + dy }, stageSize()),
			);
		};
		const stop = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId === pending.pointerId) endDrag();
		};
		pending.cleanup = () => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", stop, true);
			window.removeEventListener("pointercancel", stop, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", stop, true);
		window.addEventListener("pointercancel", stop, true);
		pending.timer = window.setTimeout(() => {
			if (dragRef.current !== pending) return;
			pending.active = true;
			setDragging(true);
			window.getSelection()?.removeAllRanges();
		}, 350);
		dragRef.current = pending;
	};
	const startResize = (event: PointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.button !== 0) return;
		endDrag();
		const pending = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			width: frame.width,
			height: frame.height,
			left: frame.left,
			top: frame.top,
			cleanup: () => {},
		};
		const move = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId !== pending.pointerId) return;
			pointer.preventDefault();
			const stage = stageSize();
			setFrame((current) => ({
				...current,
				width: Math.max(
					Math.min(320, stage.width - pending.left - 12),
					Math.min(pending.width + pointer.clientX - pending.startX, stage.width - pending.left - 12),
				),
				height: Math.max(
					Math.min(220, stage.height - pending.top - 12),
					Math.min(pending.height + pointer.clientY - pending.startY, stage.height - pending.top - 12),
				),
			}));
		};
		const stop = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId !== pending.pointerId) return;
			pending.cleanup();
			resizeRef.current = undefined;
		};
		pending.cleanup = () => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", stop, true);
			window.removeEventListener("pointercancel", stop, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", stop, true);
		window.addEventListener("pointercancel", stop, true);
		resizeRef.current = pending;
	};

	useEffect(() => {
		let cancelled = false;
		void api<{ note: ResearchNote }>(
			`/api/research/notes/${encodeURIComponent(noteId)}?namespace=${encodeURIComponent(namespace)}`,
		)
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
	}, [namespace, noteId]);

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
						namespace,
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
		<aside
			ref={cardRef}
			className={`research-canvas-paper-preview research-canvas-note-preview${dragging ? " dragging" : ""}`}
			style={frame}
			role="dialog"
			aria-label={`${note?.title ?? summary.title} 的笔记`}
			onPointerDown={startDrag}
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
			<div className="research-canvas-paper-preview-head">
				<div>
					<span className="research-canvas-paper-preview-eyebrow">NOTE · 调研笔记</span>
					<span className="research-canvas-note-drag-hint">长按卡片拖动</span>
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
			<button
				type="button"
				className="research-canvas-note-resize-grip"
				aria-label="拖动以调整笔记卡片大小"
				title="拖动以调整卡片大小"
				onPointerDown={startResize}
				onKeyDown={(event) => {
					const dx = event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : 0;
					const dy = event.key === "ArrowDown" ? 24 : event.key === "ArrowUp" ? -24 : 0;
					if (!dx && !dy) return;
					event.preventDefault();
					event.stopPropagation();
					const stage = stageSize();
					setFrame((current) => ({
						...current,
						width: Math.max(
							Math.min(320, stage.width - current.left - 12),
							Math.min(current.width + dx, stage.width - current.left - 12),
						),
						height: Math.max(
							Math.min(220, stage.height - current.top - 12),
							Math.min(current.height + dy, stage.height - current.top - 12),
						),
					}));
				}}
			>
				<Grip size={15} aria-hidden="true" />
			</button>
		</aside>
	);
}
