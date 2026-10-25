import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { createQuickNote, type QuickNotePaper } from "./quick-notes-api";
import type { PaperRecord } from "./types";

function usePaperSearch(query: string, enabled: boolean) {
	const [papers, setPapers] = useState<QuickNotePaper[]>([]);
	const [searching, setSearching] = useState(true);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setSearching(true);
			setError("");
			void api<{ hits: Array<{ record: PaperRecord }> }>(
				`/api/library?${new URLSearchParams({ q: query, limit: "20" })}`,
				{ signal: controller.signal },
			)
				.then((result) => {
					if (!controller.signal.aborted) setPapers(result.hits.map((hit) => hit.record));
				})
				.catch((reason) => {
					if (!controller.signal.aborted) setError(String(reason));
				})
				.finally(() => {
					if (!controller.signal.aborted) setSearching(false);
				});
		}, 200);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [enabled, query]);
	return { papers, searching, error };
}

function useQuickNoteComposer(paper: QuickNotePaper | undefined, onSaved: () => void) {
	const [content, setContent] = useState("");
	const [selected, setSelected] = useState(paper);
	const [query, setQuery] = useState("");
	const search = usePaperSearch(query, !paper && !selected);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const request = useRef<{ key: string; id: string } | undefined>(undefined);
	const submitting = useRef(false);
	const save = async () => {
		if (!selected || !content.trim() || submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError("");
		const key = JSON.stringify([selected.id, content]);
		if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
		try {
			await createQuickNote({ paperId: selected.id, content, clientRequestId: request.current.id });
			onSaved();
		} catch (reason) {
			setError(String(reason));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};
	return { content, setContent, selected, setSelected, query, setQuery, search, busy, error, save };
}
type ComposerState = ReturnType<typeof useQuickNoteComposer>;

function PaperPicker({ state, fixed }: { state: ComposerState; fixed: boolean }) {
	if (state.selected)
		return (
			<div className="quick-note-chosen-paper">
				<span>来源论文：{state.selected.title}</span>
				{!fixed && (
					<button type="button" disabled={state.busy} onClick={() => state.setSelected(undefined)}>
						更换
					</button>
				)}
			</div>
		);
	return (
		<div className="quick-note-paper-picker">
			<label>
				来源论文
				<input
					value={state.query}
					placeholder="搜索个人库论文"
					disabled={state.busy}
					onChange={(event) => state.setQuery(event.target.value)}
				/>
			</label>
			<section className="quick-note-paper-options" aria-label="个人库论文">
				{state.search.papers.map((item) => (
					<button key={item.id} type="button" onClick={() => state.setSelected(item)}>
						{item.title}
					</button>
				))}
				{state.search.searching && <output>正在查找论文…</output>}
				{!state.search.searching && !state.search.papers.length && !state.search.error && (
					<p>没有找到论文，请先将论文加入个人库。</p>
				)}
				{state.search.error && (
					<p className="quick-note-error" role="alert">
						{state.search.error}
					</p>
				)}
			</section>
		</div>
	);
}

export function QuickNoteComposer({
	paper,
	onSaved,
	onCancel,
}: {
	paper?: QuickNotePaper;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const state = useQuickNoteComposer(paper, onSaved);
	return (
		<form
			className="quick-note-composer"
			onSubmit={(event) => {
				event.preventDefault();
				void state.save();
			}}
		>
			<PaperPicker state={state} fixed={Boolean(paper)} />
			<label>
				记录内容
				<textarea
					value={state.content}
					rows={5}
					maxLength={50_000}
					disabled={state.busy}
					placeholder="记下原文中的一句话，或此刻的想法…"
					onChange={(event) => state.setContent(event.target.value)}
					onKeyDown={(event) => {
						if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
							event.preventDefault();
							void state.save();
						}
					}}
				/>
			</label>
			{state.error && (
				<p className="quick-note-error" role="alert">
					{state.error}
				</p>
			)}
			<div className="quick-note-actions">
				<button type="submit" className="primary" disabled={state.busy || !state.selected || !state.content.trim()}>
					{state.busy ? "正在保存…" : "保存记录"}
				</button>
				<button type="button" disabled={state.busy} onClick={onCancel}>
					取消
				</button>
			</div>
		</form>
	);
}
