import { SearchGraphEvidence } from "./search-graph-evidence";
import { useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, useJob } from "./components";
import type { BackgroundJob, PreparedOperation } from "./types";
import type { GraphDetail, GraphNode, GraphEdge } from "./canvas-graph-types";
function useGraphDetail(base: string, node: GraphNode) {
	const [detail, setDetail] = useState<GraphDetail>(),
		[error, setError] = useState("");
	useEffect(() => {
		if (node.kind !== "paper") return;
		const controller = new AbortController();
		void api<GraphDetail>(`${base}/papers/${encodeURIComponent(node.id)}`, { signal: controller.signal })
			.then(setDetail)
			.catch((e) => {
				if (!controller.signal.aborted) setError(String(e));
			});
		return () => controller.abort();
	}, [base, node.id, node.kind]);
	return { detail, error };
}
function useImportJob(jobId: string | undefined, onImported: () => void, setError: (s: string) => void) {
	const job = useJob(jobId);
	useEffect(() => {
		if (job?.status === "failed" || job?.status === "cancelled") setError(job.error ?? "入库未完成");
		if (job?.status === "succeeded") onImported();
	}, [job?.status, job?.error, onImported, setError]);
}
function useCandidateImport(nodeId: string, onImported: () => void, runId: string) {
	const [pending, setPending] = useState<{ prepared: PreparedOperation; runId: string; paperIds: string[] }>();
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[jobId, setJobId] = useState<string>();
	useImportJob(jobId, onImported, setError);
	const perform = async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	return {
		pending,
		error,
		busy,
		jobId,
		cancel: () => setPending(undefined),
		prepare: () =>
			perform(async () => {

					const prepared = await api<PreparedOperation>(
						"/api/library/import/prepare",
						jsonBody({ searchRunId: runId, paperIds: [nodeId] }),
					);
					setPending({ prepared, runId, paperIds: [nodeId] });
			}),
		confirm: () =>
			perform(async () => {
				if (!pending) return;
				const grant = await confirmOperation(pending.prepared);
				const created = await api<BackgroundJob>(
					"/api/library/import/execute",
					jsonBody(
						{ searchRunId: runId, paperIds: pending.paperIds, grant },
					),
				);
				setJobId(created.id);
				setPending(undefined);
			}),
	};
}
function CandidateImport({
	nodeId,
	onImported,
	runId,
}: {
	nodeId: string;
	onImported: () => void;
	runId: string;
}) {
	const action = useCandidateImport(nodeId, onImported, runId);
	return (
		<>
			<button type="button" disabled={action.busy || !!action.jobId} onClick={() => void action.prepare()}>
				{action.jobId ? "正在入库…" : "加入个人库"}
			</button>
			{action.pending && (
				<ConsentCard
					operation={action.pending.prepared}
					busy={action.busy}
					onCancel={action.cancel}
					onConfirm={action.confirm}
				/>
			)}
			{action.error && <p role="alert">{action.error}</p>}
		</>
	);
}
function PaperMetadata({ detail, node }: { detail?: GraphDetail; node: GraphNode }) {
	const paper = detail?.paper;
	return (
		<>
			<p>{paper?.authors.join("、") ?? node.authors?.join("、")}</p>
			<p>
				{paper?.year ?? node.year ?? "年份未知"} ·{" "}
				{detail?.libraryPaperId || node.libraryPaperId ? "已入库" : "候选论文"}
			</p>
			<p>
				{paper?.citationCount === undefined
					? "引用数未知"
					: `${paper.citationCount} 次引用 · ${new Set(paper.provenance.map((p) => p.provider)).size === 1 ? paper.provenance[0].provider : "来源未单独记录"}`}
			</p>
			{paper?.provenance.map((p, i) => (
				<small key={`${p.provider}:${i}`}>
					记录来源：{p.provider} · {new Date(p.retrievedAt).toLocaleDateString()}
				</small>
			))}
			<div className="button-row">
				{paper?.links
					.filter((l) => /^https?:\/\//.test(l.url))
					.map((l) => (
						<a key={`${l.kind}:${l.url}`} href={l.url} target="_blank" rel="noreferrer">
							{l.kind === "pdf" ? "PDF" : "原始页面"} ↗
						</a>
					))}
			</div>
		</>
	);
}
function PaperAbstract({ detail }: { detail?: GraphDetail }) {
	return (
		<>
			<h4>摘要</h4>
			<p className="graph-abstract">{detail?.paper?.abstract ?? (detail ? "未提供摘要" : "正在加载摘要…")}</p>
			{detail?.missingRelations && <p>当前已观测数据尚无可匹配的引文关系。</p>}

		</>
	);
}
export function CanvasGraphDetail({
	relations = [],
	canvasId,
	runId,
	node,
	onRead,
	onImported,
	onClose,
}: {
	canvasId: string;
	relations?: GraphEdge[];
	runId?: string;
	node: GraphNode;
	onRead: (id: string) => void;
	onImported: () => void;
	onClose: () => void;
}) {
	const base = `/api/canvases/${encodeURIComponent(canvasId)}/${runId ? `search-graphs/${encodeURIComponent(runId)}` : "graph"}`,
		{ detail, error } = useGraphDetail(base, node);
	const libraryId = detail?.libraryPaperId ?? node.libraryPaperId;
	return (
		<aside className="canvas-graph-detail" aria-label="论文详情">
			<button type="button" className="graph-close" onClick={onClose} aria-label="关闭详情">
				×
			</button>
			<h3>{node.title}</h3>
			{node.kind === "author" ? (
				<p>已解析的作者来源关联</p>
			) : (
				<>
					<PaperMetadata detail={detail} node={node} />
					{libraryId ? (
						<button type="button" onClick={() => onRead(libraryId)}>
							阅读
						</button>
					) : (
						runId && (
							<CandidateImport nodeId={node.id} onImported={onImported} runId={runId} />
						)
					)}
					<PaperAbstract detail={detail} />
					{runId && <SearchGraphEvidence base={base} nodeId={node.id} relations={relations} />}
				</>
			)}
			{error && <p role="alert">{error}</p>}
		</aside>
	);
}
