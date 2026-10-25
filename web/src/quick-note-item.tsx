import { ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { notifyQuickNotesChanged, openQuickNoteSource, type QuickNote } from "./quick-notes-api";
import type { ReaderState } from "./types";

type EditingChange = (id: string, note?: QuickNote) => void;
function useNoteAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const running = useRef(false);
	const run = async <T,>(operation: () => Promise<T>) => {
		if (running.current) return { ok: false as const, message: "" };
		running.current = true;
		setBusy(true);
		setError("");
		try {
			return { ok: true as const, value: await operation() };
		} catch (reason) {
			const message = String(reason);
			setError(message);
			return { ok: false as const, message };
		} finally {
			running.current = false;
			setBusy(false);
		}
	};
	return { busy, error, run, clearError: () => setError("") };
}

interface DraftState {
	editing: boolean;
	content: string;
	revision: number;
	changed: boolean;
	latest?: string;
}
function useNoteEditor(note: QuickNote, onEditingChange: EditingChange) {
	const action = useNoteAction();
	const [draft, setDraft] = useState<DraftState>({
		editing: false,
		content: note.content,
		revision: note.revision,
		changed: false,
	});
	const update = (patch: Partial<DraftState>) => setDraft((current) => ({ ...current, ...patch }));
	const start = () => {
		setDraft({ editing: true, content: note.content, revision: note.revision, changed: false });
		onEditingChange(note.id, note);
		action.clearError();
	};
	const cancel = () => {
		update({ editing: false });
		onEditingChange(note.id);
		action.clearError();
	};
	const save = async () => {
		if (!draft.content.trim()) return;
		const result = await action.run(() =>
			api(
				`/api/quick-notes/${note.id}`,
				jsonBody({ content: draft.content, expectedRevision: draft.revision }, "PATCH"),
			),
		);
		if (result.ok) {
			update({ editing: false });
			onEditingChange(note.id);
		} else update({ changed: result.message.includes("其他页面修改") });
		notifyQuickNotesChanged();
	};
	const reload = async () => {
		const result = await action.run(() => api<{ note: QuickNote }>(`/api/quick-notes/${note.id}`));
		if (result.ok)
			update({ latest: result.value.note.content, revision: result.value.note.revision, changed: false });
	};
	return { draft, update, action, start, cancel, save, reload };
}
type Editor = ReturnType<typeof useNoteEditor>;

function useNoteReadActions(note: QuickNote, onOpenReader: (state: ReaderState) => void) {
	const action = useNoteAction();
	const remove = async () => {
		if (action.busy || !window.confirm("删除这条随手记？")) return;
		const result = await action.run(() => api(`/api/quick-notes/${note.id}`, { method: "DELETE" }));
		if (result.ok) notifyQuickNotesChanged();
	};
	const open = async () => {
		const result = await action.run(async () => onOpenReader(await openQuickNoteSource(note)));
		if (!result.ok) notifyQuickNotesChanged();
	};
	return { ...action, remove, open };
}
type ReadActions = ReturnType<typeof useNoteReadActions>;

function QuickNoteSource({
	note,
	busy,
	onOpenPaper,
}: {
	note: QuickNote;
	busy: boolean;
	onOpenPaper: (paperId: string) => void;
}) {
	return (
		<div className="quick-note-source">
			<button type="button" disabled={!note.paperAvailable || busy} onClick={() => onOpenPaper(note.paper.id)}>
				{note.paper.title}
			</button>
			{!note.paperAvailable && <span>来源已删除</span>}
			{note.locator && (
				<small>
					{note.locator.versionLabel} · PDF 第 {note.locator.pages.join("、")} 页
					{note.paperAvailable && !note.locationAvailable ? " · 原版本已不存在" : ""}
				</small>
			)}
		</div>
	);
}

function QuickNoteControls({ note, editor, actions }: { note: QuickNote; editor: Editor; actions: ReadActions }) {
	if (editor.draft.editing)
		return (
			<div className="quick-note-actions">
				<button
					type="button"
					className="primary"
					disabled={editor.action.busy || !editor.draft.content.trim()}
					onClick={() => void editor.save()}
				>
					保存
				</button>
				<button type="button" disabled={editor.action.busy} onClick={editor.cancel}>
					取消
				</button>
			</div>
		);
	return (
		<div className="quick-note-actions">
			{note.paperAvailable && (!note.locator || note.locationAvailable) && (
				<button type="button" disabled={actions.busy} onClick={() => void actions.open()}>
					<ArrowUpRight size={14} />
					{note.locator ? "返回原文" : "阅读论文"}
				</button>
			)}
			<button
				type="button"
				disabled={actions.busy}
				onClick={() => {
					actions.clearError();
					editor.start();
				}}
			>
				<Pencil size={14} />
				编辑
			</button>
			<button type="button" disabled={actions.busy} onClick={() => void actions.remove()}>
				<Trash2 size={14} />
				删除
			</button>
		</div>
	);
}

function QuickNoteConflict({ editor }: { editor: Editor }) {
	if (!editor.draft.editing) return null;
	return (
		<>
			{editor.draft.changed && (
				<div className="quick-note-conflict">
					<p>其他页面已修改此记录。重新加载后可对照最新内容，当前草稿不会被替换。</p>
					<button type="button" disabled={editor.action.busy} onClick={() => void editor.reload()}>
						重新加载最新记录，保留我的草稿
					</button>
				</div>
			)}
			{editor.draft.latest !== undefined && (
				<div className="quick-note-conflict">
					<p>最新保存的内容：{editor.draft.latest}</p>
				</div>
			)}
		</>
	);
}

export function QuickNoteItem({
	note,
	onOpenReader,
	onOpenPaper,
	onEditingChange,
}: {
	note: QuickNote;
	onOpenReader: (state: ReaderState) => void;
	onOpenPaper: (paperId: string) => void;
	onEditingChange: EditingChange;
}) {
	const editor = useNoteEditor(note, onEditingChange);
	const actions = useNoteReadActions(note, onOpenReader);
	const error = editor.action.error || actions.error;
	return (
		<article className="quick-note-item">
			{editor.draft.editing ? (
				<label>
					编辑记录
					<textarea
						value={editor.draft.content}
						rows={5}
						maxLength={50_000}
						disabled={editor.action.busy}
						onChange={(event) => editor.update({ content: event.target.value })}
					/>
				</label>
			) : (
				<p className="quick-note-content">{note.content}</p>
			)}
			<QuickNoteSource note={note} busy={editor.action.busy || actions.busy} onOpenPaper={onOpenPaper} />
			<footer>
				<time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time>
				<QuickNoteControls note={note} editor={editor} actions={actions} />
			</footer>
			{error && (
				<p className="quick-note-error" role="alert">
					{error}
				</p>
			)}
			<QuickNoteConflict editor={editor} />
		</article>
	);
}
