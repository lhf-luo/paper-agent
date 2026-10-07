import { Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	activePaperDetailFields,
	DEFAULT_PAPER_DETAIL_FIELDS,
	type PaperDetailFieldInput,
} from "../../src/literature/domain/paper-detail-fields";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation } from "./components";
import { requiresWebOperationConfirmation, useConfirmationPolicy } from "./confirmation-policy";
import type { ConfirmationGrant, PaperRecord, PreparedOperation } from "./types";

function initialFields(paper: PaperRecord): PaperDetailFieldInput[] {
	return activePaperDetailFields(paper.curation?.detailFields);
}

function fitTextarea(textarea: HTMLTextAreaElement | null): void {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function GrowingField({ field, onChange }: { field: PaperDetailFieldInput; onChange: (value: string) => void }) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => fitTextarea(textareaRef.current));
	useEffect(() => {
		const parent = textareaRef.current?.parentElement;
		if (!parent) return;
		const observer = new ResizeObserver(() => fitTextarea(textareaRef.current));
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);
	return (
		<textarea
			ref={textareaRef}
			id={`detail-${field.id}`}
			aria-label={field.label}
			placeholder="输入内容"
			rows={2}
			maxLength={20_000}
			value={field.value}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

function validateDraft(fields: PaperDetailFieldInput[]): string | undefined {
	if (fields.length > DEFAULT_PAPER_DETAIL_FIELDS.length + 30) return "每篇论文最多添加 30 个自定义字段。";
	const names = new Set<string>();
	for (const field of fields) {
		const label = field.label.trim();
		if (!label) return "字段名称不能为空。";
		if (label.length > 80) return "字段名称最多 80 个字符。";
		if (names.has(label.toLocaleLowerCase())) return `字段名称重复：${label}`;
		if (field.value.length > 20_000) return `“${label}”内容超过 20,000 字符。`;
		if (
			field.type === "date" &&
			field.value &&
			(!/^\d{4}-\d{2}-\d{2}$/.test(field.value) ||
				Number.isNaN(Date.parse(`${field.value}T00:00:00Z`)) ||
				new Date(`${field.value}T00:00:00Z`).toISOString().slice(0, 10) !== field.value)
		)
			return `“${label}”日期格式应为 YYYY-MM-DD。`;
		names.add(label.toLocaleLowerCase());
	}
}

export function PaperDetailFieldsCard({
	paper,
	namespace,
	onDirtyChange,
	onSaved,
}: {
	paper: PaperRecord;
	namespace: string;
	onDirtyChange: (dirty: boolean) => void;
	onSaved: (paper: PaperRecord) => void;
}) {
	const confirmationSettings = useConfirmationPolicy();
	const [fields, setFields] = useState<PaperDetailFieldInput[]>(() => initialFields(paper));
	const [baseline, setBaseline] = useState(() => JSON.stringify(initialFields(paper)));
	const [revision, setRevision] = useState(paper.curation?.detailFields?.revision ?? 0);
	const [updatedAt, setUpdatedAt] = useState(paper.curation?.detailFields?.updatedAt);
	const [newType, setNewType] = useState<PaperDetailFieldInput["type"]>("text");
	const [pending, setPending] = useState<PreparedOperation>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [conflictPaper, setConflictPaper] = useState<PaperRecord>();
	const loadedKey = useRef(`${paper.id}:${paper.curation?.detailFields?.revision ?? 0}`);
	useEffect(() => {
		const key = `${paper.id}:${paper.curation?.detailFields?.revision ?? 0}`;
		if (loadedKey.current === key) return;
		loadedKey.current = key;
		const next = initialFields(paper);
		setFields(next);
		setBaseline(JSON.stringify(next));
		setRevision(paper.curation?.detailFields?.revision ?? 0);
		setUpdatedAt(paper.curation?.detailFields?.updatedAt);
		setPending(undefined);
		setError("");
		setConflictPaper(undefined);
	}, [paper]);
	const dirty = JSON.stringify(fields) !== baseline;
	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
	const validation = useMemo(() => validateDraft(fields), [fields]);
	const update = (id: string, patch: Partial<PaperDetailFieldInput>) =>
		setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
	const handleSaveError = async (reason: unknown) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		setError(message);
		if (!message.includes("Research fields changed")) return;
		try {
			const current = await api<{ paper: PaperRecord }>(
				`/api/papers/${encodeURIComponent(paper.id)}?namespace=${encodeURIComponent(namespace)}`,
			);
			setConflictPaper(current.paper);
		} catch {
			// Keep the unsaved draft and original conflict message even if comparison cannot load.
		}
	};
	const execute = async (operation: PreparedOperation) => {
		setBusy(true);
		try {
			const grant = (await confirmOperation(operation)) as ConfirmationGrant;
			const result = await api<{ paper: PaperRecord; revision: number }>(
				"/api/library/detail-fields/execute",
				jsonBody({ paperId: paper.id, namespace, grant }),
			);
			const next = initialFields(result.paper);
			setFields(next);
			setBaseline(JSON.stringify(next));
			setRevision(result.revision);
			setUpdatedAt(result.paper.curation?.detailFields?.updatedAt);
			setPending(undefined);
			setMessage("研究字段已保存。");
			setConflictPaper(undefined);
			onSaved(result.paper);
		} catch (reason) {
			setPending(undefined);
			await handleSaveError(reason);
		} finally {
			setBusy(false);
		}
	};
	const save = async () => {
		if (!dirty || validation || busy) return;
		setBusy(true);
		setError("");
		setMessage("");
		setConflictPaper(undefined);
		try {
			const result = await api<{ status: "ready" | "unchanged"; prepared: PreparedOperation | null }>(
				"/api/library/detail-fields/prepare",
				jsonBody({ paperId: paper.id, namespace, expectedRevision: revision, fields }),
			);
			if (result.status === "unchanged" || !result.prepared) {
				setBaseline(JSON.stringify(fields));
				setMessage("研究字段没有变化。");
			} else if (requiresWebOperationConfirmation("personal-corpus-write", confirmationSettings)) {
				setPending(result.prepared);
			} else {
				setBusy(false);
				await execute(result.prepared);
			}
		} catch (reason) {
			await handleSaveError(reason);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="paper-detail-fields-card" aria-label="研究字段">
			<div className="paper-detail-section-head">
				<div>
					<span className="eyebrow">RESEARCH FIELDS · 研究字段</span>
					<h3>阅读与研究记录</h3>
				</div>
				<button
					className="button primary"
					type="button"
					disabled={!dirty || !!validation || busy}
					onClick={() => void save()}
				>
					{busy ? "正在保存…" : "保存"}
				</button>
			</div>
			<p className="muted">仅保存在当前论文；默认字段由你填写，不从摘要或笔记推断。</p>
			<div className="paper-detail-field-list">
				{fields.map((field) => {
					const custom = !DEFAULT_PAPER_DETAIL_FIELDS.some((item) => item.id === field.id);
					return (
						<div className="paper-detail-field-row" key={field.id}>
							<div className="paper-detail-field-label">
								{custom ? (
									<input
										aria-label="自定义字段名称"
										value={field.label}
										maxLength={80}
										onChange={(event) => update(field.id, { label: event.target.value })}
									/>
								) : (
									<label htmlFor={`detail-${field.id}`}>{field.label}</label>
								)}
								{custom && (
									<button
										type="button"
										className="icon-button danger"
										aria-label={`删除字段 ${field.label}`}
										onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}
									>
										<Trash2 size={15} />
									</button>
								)}
							</div>
							<div className="paper-detail-field-content">
								{field.type === "multiline" ? (
									<GrowingField field={field} onChange={(value) => update(field.id, { value })} />
								) : (
									<input
										id={`detail-${field.id}`}
										aria-label={field.label}
										type={field.type === "date" ? "date" : "text"}
										placeholder={field.type === "date" ? undefined : "输入内容"}
										maxLength={20_000}
										value={field.value}
										onChange={(event) => update(field.id, { value: event.target.value })}
									/>
								)}
							</div>
						</div>
					);
				})}
				<div className="paper-detail-field-row paper-detail-field-add">
					<div className="paper-detail-field-label">
						<span>自定义字段</span>
					</div>
					<div className="paper-detail-field-content">
						<select
							aria-label="新增字段类型"
							value={newType}
							onChange={(event) => setNewType(event.target.value as PaperDetailFieldInput["type"])}
						>
							<option value="text">单行文本</option>
							<option value="multiline">多行文本</option>
							<option value="date">日期</option>
						</select>
						<button
							className="button secondary"
							type="button"
							disabled={fields.length >= DEFAULT_PAPER_DETAIL_FIELDS.length + 30}
							onClick={() =>
								setFields((current) => [
									...current,
									{ id: `custom-${crypto.randomUUID()}`, label: "", type: newType, value: "" },
								])
							}
						>
							<Plus size={15} /> 新增字段
						</button>
					</div>
				</div>
				<div className="paper-detail-field-row">
					<div className="paper-detail-field-label">最后一次修改时间</div>
					<div className="paper-detail-field-content paper-detail-field-timestamp">
						{updatedAt ? new Date(updatedAt).toLocaleString() : "尚未保存"}
					</div>
				</div>
			</div>
			{validation && (
				<p className="error" role="alert">
					{validation}
				</p>
			)}
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{conflictPaper && (
				<section className="paper-detail-conflict" aria-label="当前已保存字段">
					<strong>数据库当前内容（修订 {conflictPaper.curation?.detailFields?.revision ?? 0}）</strong>
					<p>上方草稿仍保留。请核对以下不同字段，再决定如何重新编辑。</p>
					{initialFields(conflictPaper)
						.filter((current) => {
							const draft = fields.find((field) => field.id === current.id);
							return draft?.label !== current.label || draft?.value !== current.value;
						})
						.map((current) => (
							<div key={current.id}>
								<span>{current.label}</span>
								<p>{current.value || "（空）"}</p>
							</div>
						))}
				</section>
			)}
			{message && <output className="muted">{message}</output>}
			{pending && (
				<AccessibleModal title="确认保存研究字段" onClose={() => !busy && setPending(undefined)} maxWidth={620}>
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => setPending(undefined)}
						onConfirm={() => void execute(pending)}
					/>
				</AccessibleModal>
			)}
		</section>
	);
}
