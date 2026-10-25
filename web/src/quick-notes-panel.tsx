import { Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useState } from "react";
import { QuickNoteComposer } from "./quick-note-composer";
import { QuickNoteItem } from "./quick-note-item";
import type { QuickNote, QuickNotePaper } from "./quick-notes-api";
import type { ReaderState } from "./types";
import { useQuickNotes } from "./use-quick-notes";
import "./quick-notes.css";

type ListState = ReturnType<typeof useQuickNotes>;
function useEditingNotePins(notes: QuickNote[]) {
	const [editingNotes, setEditingNotes] = useState<Record<string, QuickNote>>({});
	const onEditingChange = useCallback((id: string, note?: QuickNote) => {
		setEditingNotes((current) => {
			const next = { ...current };
			if (note) next[id] = note;
			else delete next[id];
			return next;
		});
	}, []);
	return {
		onEditingChange,
		visible: [...notes, ...Object.values(editingNotes).filter((note) => !notes.some((item) => item.id === note.id))],
	};
}

function QuickNotesHeader({
	embedded,
	creating,
	refresh,
	onCreate,
}: {
	embedded: boolean;
	creating: boolean;
	refresh: () => void;
	onCreate: () => void;
}) {
	return (
		<header className="quick-notes-header">
			<div>
				<h2>随手记</h2>
				<p>{embedded ? "当前论文的摘录与想法" : "阅读中记下的一句话、一个想法，都能找到来源。"}</p>
			</div>
			<div className="quick-note-actions">
				<button type="button" aria-label="刷新记录" title="刷新记录" onClick={refresh}>
					<RefreshCw size={16} />
				</button>
				<button type="button" className="primary" onClick={onCreate} disabled={creating}>
					<Plus size={16} />
					记一条
				</button>
			</div>
		</header>
	);
}

function QuickNotesFilters({ state, embedded }: { state: ListState; embedded: boolean }) {
	return (
		<div className="quick-notes-filters">
			<label className="quick-notes-search">
				<Search size={16} />
				<input
					aria-label="搜索记录内容或论文标题"
					value={state.query}
					placeholder="搜索记录内容或论文标题"
					onChange={(event) => state.setQuery(event.target.value)}
				/>
			</label>
			{!embedded && (
				<select
					aria-label="按来源论文筛选"
					value={state.paperId}
					onChange={(event) => state.setPaperId(event.target.value)}
				>
					<option value="">全部来源论文</option>
					{state.data?.sources.map((source) => (
						<option key={`${source.id}:${source.available}`} value={source.id}>
							{source.title}
							{!source.available ? "（已删除）" : ""}
						</option>
					))}
				</select>
			)}
		</div>
	);
}

function QuickNotesPagination({ state }: { state: ListState }) {
	const total = state.data?.total ?? 0,
		pageSize = state.data?.pageSize ?? 30;
	if (total <= pageSize) return null;
	return (
		<nav className="quick-notes-pagination" aria-label="记录分页">
			<button
				type="button"
				disabled={state.loading || state.page === 1}
				onClick={() => state.setPage(state.page - 1)}
			>
				上一页
			</button>
			<span>
				第 {state.page} / {Math.ceil(total / pageSize)} 页
			</span>
			<button
				type="button"
				disabled={state.loading || state.page * pageSize >= total}
				onClick={() => state.setPage(state.page + 1)}
			>
				下一页
			</button>
		</nav>
	);
}

function QuickNotesEmpty({ state }: { state: ListState }) {
	return (
		<div className="quick-notes-empty">
			<p>{state.query || state.paperId ? "没有匹配的记录。" : "还没有随手记。"}</p>
			{!state.query && !state.paperId && <span>阅读时选中文字，点击“记一条”；也可以在这里手动记录。</span>}
		</div>
	);
}

interface QuickNotesPanelProps {
	paper?: QuickNotePaper;
	onOpenReader: (state: ReaderState) => void;
	onOpenPaper: (paperId: string) => void;
}

export function QuickNotesPanel({ paper, onOpenReader, onOpenPaper }: QuickNotesPanelProps) {
	const state = useQuickNotes(paper?.id);
	const [creating, setCreating] = useState(false);
	const total = state.data?.total ?? 0;
	const notes = state.data?.notes ?? [];
	const pinned = useEditingNotePins(notes);
	return (
		<section className={`quick-notes${paper ? " embedded" : ""}`} aria-label="随手记">
			<QuickNotesHeader
				embedded={Boolean(paper)}
				creating={creating}
				refresh={state.refresh}
				onCreate={() => setCreating(true)}
			/>
			{creating && (
				<QuickNoteComposer
					paper={paper}
					onCancel={() => setCreating(false)}
					onSaved={() => {
						setCreating(false);
						state.setPage(1);
						state.refresh();
					}}
				/>
			)}
			<QuickNotesFilters state={state} embedded={Boolean(paper)} />
			{state.error && (
				<p className="quick-note-error" role="alert">
					{state.error}
					<button type="button" onClick={state.refresh}>
						重试
					</button>
				</p>
			)}
			<output className="quick-notes-count">{state.loading ? "正在加载…" : `${total} 条记录`}</output>
			{pinned.visible.length > notes.length && (
				<p className="quick-note-draft-hint">部分编辑中的记录不在当前筛选结果中，草稿保留在下方。</p>
			)}
			<div className="quick-notes-list" aria-busy={state.loading}>
				{pinned.visible.map((note) => (
					<QuickNoteItem
						key={note.id}
						note={note}
						onOpenReader={onOpenReader}
						onOpenPaper={onOpenPaper}
						onEditingChange={pinned.onEditingChange}
					/>
				))}
			</div>
			{!state.loading && !state.error && !total && !pinned.visible.length && <QuickNotesEmpty state={state} />}
			<QuickNotesPagination state={state} />
		</section>
	);
}
