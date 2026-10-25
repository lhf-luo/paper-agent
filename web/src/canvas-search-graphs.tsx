import { SearchGraphEnrichment } from "./search-graph-enrichment";
import { useEffect, useRef, useState } from "react";
import { X, Network } from "lucide-react";
import type { SearchGraphRecord } from "./use-search-graphs";
import "./canvas-search-graphs.css";

interface ManagerProps {
	canvasId: string;
	graphs: SearchGraphRecord[];
	nodeRunIds: Set<string>;
	onOpen: (id: string) => Promise<void>;
	onAdd: (graph: SearchGraphRecord) => void;
	onRename: (id: string, title: string) => Promise<void>;
	onHide: (id: string) => Promise<void>;
	onClose: () => void;
}
function useManagerAction() {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const act = async (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, act };
}
export function SearchGraphManager(props: ManagerProps) {
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		root.current?.focus();
	}, []);
	return (
		<aside
			className="search-graph-manager"
			aria-label="图谱管理"
			tabIndex={-1}
			ref={root}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					props.onClose();
				}
			}}
		>
			<header>
				<strong>
					<Network size={18} /> 图谱管理
				</strong>
				<button type="button" aria-label="关闭图谱管理" onClick={props.onClose}>
					<X size={18} />
				</button>
			</header>
			<SavedGraphs {...props} />
		</aside>
	);
}
function SavedGraphs(props: ManagerProps) {
	const [query, setQuery] = useState(""),
		[hidden, setHidden] = useState(false);
	const action = useManagerAction();
	const visible = props.graphs.filter(
		(g) => (hidden || !g.closed) && g.title.toLowerCase().includes(query.toLowerCase()),
	);
	return (
		<>
			<div className="search-graph-manager-controls">
				<input
					aria-label="搜索已有图谱"
					placeholder="搜索图谱名称…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<label>
					<input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 显示已隐藏图谱
				</label>
			</div>
			<div className="search-graph-manager-list">
				{visible.map((graph) => (
					<SavedGraphRow key={graph.runId} graph={graph} {...props} action={action} />
				))}
				{!visible.length && <p>{query ? "没有匹配的图谱" : "暂无图谱。"}</p>}
			</div>
			{action.error && <p role="alert">{action.error}</p>}
		</>
	);
}
function SavedGraphRow({
	graph,
	action,
	...props
}: ManagerProps & { graph: SearchGraphRecord; action: ReturnType<typeof useManagerAction> }) {
	const [editing, setEditing] = useState(false);
	return (
		<article>
			{editing ? (
				<GraphNameEditor
					graph={graph}
					busy={action.busy}
					onCancel={() => setEditing(false)}
					onSave={(title) =>
						void action.act(async () => {
							await props.onRename(graph.runId, title);
							setEditing(false);
						})
					}
				/>
			) : (
				<strong>{graph.title}</strong>
			)}
			<small>
				{graph.closed ? "已隐藏 · " : ""}
				{new Date(graph.openedAt).toLocaleString()}
			</small>
			<div className="search-graph-manager-actions">
				<button
					type="button"
					disabled={action.busy}
					onClick={() => void action.act(() => props.onOpen(graph.runId))}
				>
					打开
				</button>
				<button type="button" disabled={action.busy} onClick={() => props.onAdd(graph)}>
					{props.nodeRunIds.has(graph.runId) ? "定位节点" : "添加到画布"}
				</button>
				<button type="button" disabled={action.busy} onClick={() => setEditing(true)}>
					重命名
				</button>
				{!graph.closed && (
					<button
						type="button"
						disabled={action.busy}
						title="从列表隐藏，保留画布节点和搜索记录"
						onClick={() => void action.act(() => props.onHide(graph.runId))}
					>
						隐藏
					</button>
				)}
			</div>
			<SearchGraphEnrichment canvasId={props.canvasId} runId={graph.runId} onOpen={props.onOpen} />
		</article>
	);
}
function GraphNameEditor({
	graph,
	busy,
	onSave,
	onCancel,
}: {
	graph: SearchGraphRecord;
	busy: boolean;
	onSave: (title: string) => void;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(graph.title);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onSave(title);
			}}
		>
			<input aria-label="图谱名称" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
			<button type="submit" disabled={busy || !title.trim()}>
				保存
			</button>
			<button type="button" onClick={onCancel}>
				取消
			</button>
		</form>
	);
}
