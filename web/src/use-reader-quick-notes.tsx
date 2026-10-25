import { useRef, useState } from "react";
import type { ReaderTextSelection } from "./pdfjs-reader-selection";
import { type CreateQuickNoteInput, createQuickNote } from "./quick-notes-api";
import type { ReaderState } from "./types";

function selectionInput(reader: ReaderState, selection: ReaderTextSelection) {
	return {
		content: selection.text,
		paperId: reader.paperId!,
		...(reader.sha256 ? { locator: { pdfSha256: reader.sha256, pages: [...selection.pages] } } : {}),
	};
}

export function useReaderQuickNotes(reader: ReaderState) {
	const pending = useRef<CreateQuickNoteInput | undefined>(undefined);
	const busy = useRef(false);
	const [notice, setNotice] = useState<{ success: boolean; message: string; content?: string }>();
	const [saving, setSaving] = useState(false);
	const save = async (input: CreateQuickNoteInput): Promise<boolean> => {
		if (busy.current) return false;
		busy.current = true;
		setSaving(true);
		try {
			await createQuickNote(input);
			pending.current = undefined;
			setNotice({ success: true, message: "已保存到随手记" });
			return true;
		} catch (reason) {
			setNotice({ success: false, message: String(reason), content: input.content });
			return false;
		} finally {
			busy.current = false;
			setSaving(false);
		}
	};
	const capture = async (selection: ReaderTextSelection) => {
		if (!reader.paperId) {
			setNotice({ success: false, message: "请先将这份 PDF 加入个人库，再创建随手记。" });
			return false;
		}
		const candidate = selectionInput(reader, selection);
		if (
			pending.current &&
			JSON.stringify({ ...pending.current, clientRequestId: "" }) !==
				JSON.stringify({ ...candidate, clientRequestId: "" })
		) {
			setNotice({
				success: false,
				message: "还有一条未保存的记录，请先重试，或放弃该条后再记录。",
				content: pending.current.content,
			});
			return false;
		}
		pending.current ??= { ...candidate, clientRequestId: crypto.randomUUID() };
		return save(pending.current);
	};
	return {
		capture,
		notice,
		saving,
		canRetry: Boolean(pending.current),
		retry: () => (pending.current ? save(pending.current) : Promise.resolve(false)),
		dismiss: () => {
			if (!busy.current) {
				pending.current = undefined;
				setNotice(undefined);
			}
		},
	};
}

export function ReaderQuickNoteNotice({
	state,
	onView,
}: {
	state: ReturnType<typeof useReaderQuickNotes>;
	onView: () => void;
}) {
	if (!state.notice && !state.saving) return null;
	return (
		<div
			className={`paper-reader-notice reader-quick-note-notice ${state.saving ? "" : state.notice?.success ? "success" : "error"}`}
			aria-live="polite"
		>
			<div>
				<span>{state.saving ? "正在保存随手记…" : state.notice?.message}</span>
				{!state.saving && state.notice?.content && (
					<details>
						<summary>未保存的内容</summary>
						<p style={{ whiteSpace: "pre-wrap" }}>{state.notice.content}</p>
					</details>
				)}
			</div>
			<div className="quick-note-actions">
				{state.notice?.success && (
					<button type="button" onClick={onView}>
						查看
					</button>
				)}
				{!state.saving && !state.notice?.success && state.canRetry && (
					<button type="button" disabled={state.saving} onClick={() => void state.retry()}>
						重试保存
					</button>
				)}
				<button type="button" disabled={state.saving} onClick={state.dismiss}>
					{state.canRetry ? "放弃本条" : "关闭"}
				</button>
			</div>
		</div>
	);
}
