import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, LoadingBlock } from "./components";
import { useAutomaticOperationConfirmation } from "./confirmation-policy";
import type { ConfirmationGrant, PreparedOperation, ResearchNote, ResearchNoteTemplate } from "./types";

type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export function ReaderNotePanel({
	namespace,
	noteId,
	onSaved,
}: {
	namespace: string;
	noteId: string;
	onSaved: (note: ResearchNote) => void;
}) {
	const [note, setNote] = useState<ResearchNote>();
	const [markdown, setMarkdown] = useState("");
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [error, setError] = useState("");
	const saving = useRef(false);

	useEffect(() => {
		let cancelled = false;
		setNote(undefined);
		setError("");
		void api<{ note: ResearchNote }>(
			`/api/research/notes/${encodeURIComponent(noteId)}?namespace=${encodeURIComponent(namespace)}`,
		)
			.then(({ note: loaded }) => {
				if (cancelled) return;
				setNote(loaded);
				setMarkdown(loaded.markdown);
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => {
			cancelled = true;
		};
	}, [namespace, noteId]);

	const save = useCallback(async () => {
		if (!note || saving.current || markdown === note.markdown) return;
		saving.current = true;
		setSaveState("saving");
		setError("");
		const capturedMarkdown = markdown;
		try {
			const result = await api<{ note: ResearchNote }>(
				`/api/research/notes/${encodeURIComponent(note.id)}`,
				jsonBody(
					{
						namespace,
						title: note.title,
						markdown: capturedMarkdown,
						expectedRevision: note.revision,
						expectedContentHash: note.contentHash,
					},
					"PATCH",
				),
			);
			setNote(result.note);
			setSaveState("saved");
			onSaved(result.note);
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			setSaveState(/changed since|revision conflict/i.test(message) ? "conflict" : "error");
			setError(message);
		} finally {
			saving.current = false;
		}
	}, [markdown, namespace, note, onSaved]);

	useEffect(() => {
		if (!note || markdown === note.markdown) return;
		const timer = window.setTimeout(() => void save(), 700);
		return () => window.clearTimeout(timer);
	}, [markdown, note, save]);

	if (!note && !error) return <LoadingBlock text="正在加载笔记" />;
	if (!note) return <div className="reader-note-error">{error}</div>;

	const saveLabel = {
		idle: "",
		saving: "正在保存",
		saved: "已保存",
		error: "保存失败",
		conflict: "检测到外部修改",
	}[saveState];

	return (
		<div className="reader-note-panel">
			<header className="reader-note-header">
				<div className="reader-note-actions">
					{saveLabel && <span className={`reader-note-save ${saveState}`}>{saveLabel}</span>}
					<fieldset className="reader-note-modes" aria-label="笔记显示方式">
						<button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
							编辑
						</button>
						<button
							type="button"
							className={mode === "preview" ? "active" : ""}
							onClick={() => setMode("preview")}
						>
							预览
						</button>
					</fieldset>
				</div>
			</header>
			{note.papers.length > 0 && (
				<div className="reader-note-papers">
					{note.papers.map((paper) => (
						<span key={paper.id}>{paper.title}</span>
					))}
				</div>
			)}
			{error && <div className="reader-note-error">{error}</div>}
			{mode === "edit" ? (
				<textarea
					value={markdown}
					onChange={(event) => setMarkdown(event.target.value)}
					onBlur={() => void save()}
					placeholder="开始记录这篇论文的阅读笔记…"
					spellCheck
				/>
			) : (
				<article className="reader-note-preview">
					{markdown.trim() ? (
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
					) : (
						<p>这篇笔记还没有内容。</p>
					)}
				</article>
			)}
		</div>
	);
}

export function ReaderNoteCreatePanel({
	namespace,
	paperId,
	onCreated,
	onCancel,
}: {
	namespace: string;
	paperId: string;
	onCreated: (note: ResearchNote) => void;
	onCancel: () => void;
}) {
	const [templates, setTemplates] = useState<ResearchNoteTemplate[]>([]);
	const [title, setTitle] = useState("");
	const [templateId, setTemplateId] = useState("blank");
	const [pending, setPending] = useState<PreparedOperation>();
	const [payload, setPayload] = useState<Record<string, unknown>>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void api<{ templates: ResearchNoteTemplate[] }>(
			`/api/research/templates?namespace=${encodeURIComponent(namespace)}`,
		)
			.then((result) => setTemplates(result.templates))
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [namespace]);

	const execute = useCallback(async () => {
		if (!pending || !payload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const result = await api<{ note: ResearchNote }>(
				"/api/research/notes/create/execute",
				jsonBody({ ...payload, grant }),
			);
			onCreated(result.note);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}, [onCreated, payload, pending]);

	const automatic = useAutomaticOperationConfirmation(pending, busy, execute);

	const prepare = async () => {
		if (!title.trim()) {
			setError("请输入笔记名称");
			return;
		}
		setBusy(true);
		setError("");
		const nextPayload = { namespace, title, templateId, paperIds: [paperId] };
		try {
			setPayload(nextPayload);
			setPending(await api<PreparedOperation>("/api/research/notes/create/prepare", jsonBody(nextPayload)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="reader-note-create">
			<header>
				<div>
					<strong>新建论文笔记</strong>
					<span>创建后会自动关联当前论文</span>
				</div>
				<button type="button" onClick={onCancel}>
					取消
				</button>
			</header>
			<label>
				<span>笔记名称</span>
				<input value={title} onChange={(event) => setTitle(event.target.value)} />
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
			{error && <div className="reader-note-error">{error}</div>}
			{pending && (automatic.confirmationRequired || automatic.automaticAttemptFailed) ? (
				<ConsentCard operation={pending} busy={busy} onConfirm={execute} onCancel={() => setPending(undefined)} />
			) : (
				<button
					className="button primary"
					type="button"
					disabled={busy || Boolean(pending)}
					onClick={() => void prepare()}
				>
					{busy || pending ? "正在创建…" : "创建笔记"}
				</button>
			)}
		</div>
	);
}
