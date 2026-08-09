import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiBytes, jsonBody } from "./api";
import { createPdfCoordinateMapper, type PdfRectangle } from "./pdf-coordinates";
import type { BackgroundJob, PaperAsset, PaperRecord, PreparedOperation } from "./types";

export function StatusPill({ status }: { status: string }) {
	return <span className={`status-pill status-${status}`}>{status}</span>;
}

export function EmptyState({ title, text }: { title: string; text: string }) {
	return (
		<div className="empty-state">
			<div className="empty-icon">◇</div>
			<h3>{title}</h3>
			<p>{text}</p>
		</div>
	);
}

export function LoadingBlock({ text = "正在加载…" }: { text?: string }) {
	return (
		<div className="loading-block">
			<span className="spinner" />
			{text}
		</div>
	);
}

export function PaperCard({
	paper,
	selected,
	onSelect,
	onOpen,
}: {
	paper: PaperRecord;
	selected?: boolean;
	onSelect?: (selected: boolean) => void;
	onOpen?: () => void;
}) {
	return (
		<article className="paper-card">
			<div className="paper-card-top">
				{onSelect && (
					<input
						aria-label={`选择 ${paper.title}`}
						type="checkbox"
						checked={selected}
						onChange={(event) => onSelect(event.target.checked)}
					/>
				)}
				<div className="paper-main">
					<button className="paper-title" type="button" onClick={onOpen}>
						{paper.title}
					</button>
					<p className="paper-authors">{paper.authors.slice(0, 6).join(", ") || "作者未知"}</p>
				</div>
				<span className="year-badge">{paper.year ?? "—"}</span>
			</div>
			{paper.abstract && <p className="paper-abstract">{paper.abstract}</p>}
			<div className="paper-meta">
				<span>{paper.venue || paper.publicationType || "来源未标注"}</span>
				{paper.identifiers.doi && <span>DOI {paper.identifiers.doi}</span>}
				<span>{[...new Set(paper.provenance.map((item) => item.provider))].join(" · ")}</span>
			</div>
		</article>
	);
}

export function ConsentCard({
	operation,
	onConfirm,
	onCancel,
	busy,
}: {
	operation: PreparedOperation;
	onConfirm: () => void;
	onCancel: () => void;
	busy?: boolean;
}) {
	return (
		<section className="consent-card">
			<div>
				<span className="eyebrow">需要人工确认</span>
				<h3>{operation.summary}</h3>
				<p className="fingerprint">Manifest {operation.manifestFingerprint}</p>
			</div>
			<div className="consent-targets">
				{operation.targets.slice(0, 12).map((target) => (
					<div className="consent-target" key={`${target.label}-${target.value}`}>
						<StatusPill status={target.risk ?? "medium"} />
						<span>{target.label}</span>
						<code>{target.value}</code>
					</div>
				))}
				{operation.targets.length > 12 && <p>另有 {operation.targets.length - 12} 个目标。</p>}
			</div>
			<div className="button-row">
				<button className="button secondary" type="button" disabled={busy} onClick={onCancel}>
					取消
				</button>
				<button className="button danger" type="button" disabled={busy} onClick={onConfirm}>
					{busy ? "正在确认…" : "确认并执行"}
				</button>
			</div>
		</section>
	);
}

export function useJob(jobId?: string) {
	const [job, setJob] = useState<BackgroundJob>();
	useEffect(() => {
		setJob(undefined);
		if (!jobId) return;
		let active = true;
		const load = async () => {
			try {
				const value = await api<BackgroundJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
				if (active) setJob(value);
				if (active && !["succeeded", "failed", "cancelled"].includes(value.status)) setTimeout(load, 1200);
			} catch {
				if (active) setTimeout(load, 2000);
			}
		};
		void load();
		return () => {
			active = false;
		};
	}, [jobId]);
	return job;
}

export function JobProgress({ job }: { job?: BackgroundJob }) {
	if (!job) return null;
	return (
		<div className="job-progress">
			<div className="job-progress-header">
				<StatusPill status={job.status} />
				<span>{job.message || job.type}</span>
				<strong>{Math.round(job.progress * 100)}%</strong>
			</div>
			<div className="progress-track">
				<span style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
			</div>
			{job.error && <p className="error-text">{job.error}</p>}
		</div>
	);
}

export function PdfViewer({
	url,
	assets = [],
	pageMetrics = [],
	editable = false,
	selectedPage,
	onPageChange,
	onRegionChange,
	onAssetSelect,
}: {
	url: string;
	assets?: PaperAsset[];
	pageMetrics?: Array<{ page: number; width: number; height: number }>;
	editable?: boolean;
	selectedPage?: number;
	onPageChange?: (page: number) => void;
	onRegionChange?: (asset: PaperAsset, region: PaperAsset["candidateRegion"]) => void;
	onAssetSelect?: (asset: PaperAsset) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const [documentProxy, setDocumentProxy] = useState<any>();
	const [page, setPage] = useState(1);
	const [pageView, setPageView] = useState({ width: 1, height: 1, sourceWidth: 612, sourceHeight: 792, rotation: 0 });
	const [draftRegions, setDraftRegions] = useState<Record<string, PaperAsset["candidateRegion"]>>({});
	const dragRef = useRef<{
		asset: PaperAsset;
		mode: "move" | "resize";
		startX: number;
		startY: number;
		startDisplay: PdfRectangle;
		current: PaperAsset["candidateRegion"];
		pointerWidth: number;
		pointerHeight: number;
		mapper: ReturnType<typeof createPdfCoordinateMapper>;
	} | null>(null);
	const [error, setError] = useState("");
	const analysisPage = useMemo(() => pageMetrics.find((candidate) => candidate.page === page), [page, pageMetrics]);
	const mapper = useMemo(
		() =>
			createPdfCoordinateMapper({
				analysisWidth: analysisPage?.width ?? pageView.sourceWidth,
				analysisHeight: analysisPage?.height ?? pageView.sourceHeight,
				displayWidth: pageView.width,
				displayHeight: pageView.height,
				rotation: pageView.rotation,
			}),
		[analysisPage, pageView],
	);

	useEffect(() => {
		let cancelled = false;
		let loadedDocument: any;
		setDocumentProxy(undefined);
		setDraftRegions({});
		setPage(1);
		setError("");
		void Promise.all([apiBytes(url), import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
			.then(([data, pdfjs, worker]) => {
				pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
				return pdfjs.getDocument({ data }).promise;
			})
			.then((pdf) => {
				loadedDocument = pdf;
				if (cancelled) {
					void (pdf as { destroy?: () => Promise<void> }).destroy?.();
					return;
				}
				setDocumentProxy(pdf);
			})
			.catch((reason) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			cancelled = true;
			if (loadedDocument) void loadedDocument.destroy?.();
		};
	}, [url]);

	useEffect(() => {
		if (!Number.isInteger(selectedPage) || (selectedPage ?? 0) < 1) return;
		setPage(Math.min(documentProxy?.numPages ?? (selectedPage as number), selectedPage as number));
	}, [documentProxy, selectedPage]);

	useEffect(() => {
		if (!documentProxy || !canvasRef.current) return;
		let cancelled = false;
		let renderTask: { cancel: () => void; promise: Promise<unknown> } | undefined;
		void documentProxy
			.getPage(page)
			.then(async (pdfPage: any) => {
				if (cancelled || !canvasRef.current) return;
				const sourceViewport = pdfPage.getViewport({ scale: 1 });
				const viewport = pdfPage.getViewport({ scale: 1.35 });
				const canvas = canvasRef.current;
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				setPageView({
					width: viewport.width,
					height: viewport.height,
					sourceWidth: sourceViewport.width,
					sourceHeight: sourceViewport.height,
					rotation: pdfPage.rotate ?? 0,
				});
				const currentRenderTask = pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport });
				renderTask = currentRenderTask;
				await currentRenderTask.promise;
			})
			.catch((reason: unknown) => {
				if (!cancelled && (reason as { name?: string })?.name !== "RenderingCancelledException") {
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			});
		return () => {
			cancelled = true;
			renderTask?.cancel();
		};
	}, [documentProxy, page]);

	useEffect(() => {
		const move = (event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const deltaX = (event.clientX - drag.startX) * (drag.mapper.displayWidth / Math.max(1, drag.pointerWidth));
			const deltaY = (event.clientY - drag.startY) * (drag.mapper.displayHeight / Math.max(1, drag.pointerHeight));
			const minimumDisplay =
				8 *
				Math.min(
					drag.mapper.displayWidth / drag.mapper.analysisWidth,
					drag.mapper.displayHeight / drag.mapper.analysisHeight,
				);
			const nextDisplay =
				drag.mode === "move"
					? {
							x: Math.max(
								0,
								Math.min(drag.mapper.displayWidth - drag.startDisplay.width, drag.startDisplay.x + deltaX),
							),
							y: Math.max(
								0,
								Math.min(drag.mapper.displayHeight - drag.startDisplay.height, drag.startDisplay.y + deltaY),
							),
							width: drag.startDisplay.width,
							height: drag.startDisplay.height,
						}
					: {
							x: drag.startDisplay.x,
							y: drag.startDisplay.y,
							width: Math.max(
								minimumDisplay,
								Math.min(drag.mapper.displayWidth - drag.startDisplay.x, drag.startDisplay.width + deltaX),
							),
							height: Math.max(
								minimumDisplay,
								Math.min(drag.mapper.displayHeight - drag.startDisplay.y, drag.startDisplay.height + deltaY),
							),
						};
			const mapped = drag.mapper.toAnalysis(nextDisplay);
			const next = {
				x: Math.max(0, Math.min(drag.mapper.analysisWidth - 8, mapped.x)),
				y: Math.max(0, Math.min(drag.mapper.analysisHeight - 8, mapped.y)),
				width: Math.max(8, Math.min(drag.mapper.analysisWidth - Math.max(0, mapped.x), mapped.width)),
				height: Math.max(8, Math.min(drag.mapper.analysisHeight - Math.max(0, mapped.y), mapped.height)),
			};
			drag.current = next;
			setDraftRegions((current) => ({ ...current, [drag.asset.id]: next }));
		};
		const up = () => {
			const drag = dragRef.current;
			if (!drag) return;
			dragRef.current = null;
			onRegionChange?.(drag.asset, drag.current);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
	}, [onRegionChange]);

	const beginDrag = (event: React.PointerEvent, asset: PaperAsset, mode: "move" | "resize") => {
		if (!editable || !wrapRef.current) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = wrapRef.current.getBoundingClientRect();
		const start = draftRegions[asset.id] ?? asset.candidateRegion;
		dragRef.current = {
			asset,
			mode,
			startX: event.clientX,
			startY: event.clientY,
			startDisplay: mapper.toDisplay(start),
			current: start,
			pointerWidth: rect.width,
			pointerHeight: rect.height,
			mapper,
		};
		onAssetSelect?.(asset);
	};
	const selectPage = (value: number) => {
		const next = Math.max(1, Math.min(documentProxy?.numPages ?? value, value));
		setPage(next);
		onPageChange?.(next);
	};

	if (error) return <div className="error-banner">PDF 加载失败：{error}</div>;
	if (!documentProxy) return <LoadingBlock text="正在载入 PDF…" />;
	const pageAssets = assets.filter((asset) => asset.page === page);
	return (
		<div className="pdf-viewer">
			<div className="pdf-toolbar">
					<button type="button" onClick={() => selectPage(page - 1)}>
					上一页
				</button>
				<span>
					第 {page} / {documentProxy.numPages} 页
				</span>
					<button type="button" onClick={() => selectPage(page + 1)}>
					下一页
				</button>
			</div>
			<div className="pdf-canvas-wrap" ref={wrapRef} style={{ width: pageView.width, height: pageView.height }}>
				<canvas ref={canvasRef} />
				{pageAssets.map((asset) => {
					const region = draftRegions[asset.id] ?? asset.candidateRegion;
					const displayRegion = mapper.toDisplay(region);
					return (
						<button
							className={`asset-overlay asset-${asset.type}${editable ? " editable" : ""}`}
							key={asset.id}
							title={`${asset.type} ${asset.identifier}: ${asset.caption}`}
							style={{
								left: displayRegion.x,
								top: displayRegion.y,
								width: displayRegion.width,
								height: displayRegion.height,
							}}
							type="button"
							onClick={() => onAssetSelect?.(asset)}
							onPointerDown={(event) => beginDrag(event, asset, "move")}
						>
							{editable && (
								<span className="resize-handle" onPointerDown={(event) => beginDrag(event, asset, "resize")} />
							)}
						</button>
					);
				})}
			</div>
			{assets.length > 0 && (
				<div className="asset-strip">
					{assets.map((asset) => (
						<button
							className={asset.page === page ? "active" : ""}
							type="button"
							key={asset.id}
								onClick={() => selectPage(asset.page)}
						>
							<span>
								{asset.type} {asset.identifier}
							</span>
							<small>
								p.{asset.page} · {asset.regionConfidence}
							</small>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export async function confirmOperation(operation: PreparedOperation) {
	return api(
		"/api/operations/confirm",
		jsonBody({
			operationId: operation.operationId,
			manifestFingerprint: operation.manifestFingerprint,
		}),
	);
}
