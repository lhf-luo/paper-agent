import { ArrowUpRight, BookmarkPlus, Check, Inbox, MoreHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiBytes, jsonBody } from "./api";
import { buildCollectionTree, flattenCollectionTree, PAPER_DRAG_TYPE } from "./collection-tree";
import { useAutomaticOperationConfirmation } from "./confirmation-policy";
import { paperLinksForDisplay, paperPrimaryAction, paperPrimaryUrl } from "./paper-links";
import { createPdfCoordinateMapper, type PdfRectangle } from "./pdf-coordinates";
import type {
	BackgroundJob,
	PaperAsset,
	PaperCollection,
	PaperRecord,
	PreparedOperation,
	ResearchNoteSummary,
} from "./types";

export function formatFileSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeLabel(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(
		date.getHours(),
	).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function PageHeading({
	eyebrow,
	title,
	description,
	actions,
}: {
	eyebrow: string;
	title: string;
	description: string;
	actions?: React.ReactNode;
}) {
	return (
		<header className="page-heading">
			<div>
				<span className="eyebrow">{eyebrow}</span>
				<h1>{title}</h1>
				<p>{description}</p>
			</div>
			{actions && <div className="heading-actions">{actions}</div>}
		</header>
	);
}

export function StatusPill({ status }: { status: string }) {
	return <span className={`status-pill status-${status}`}>{status}</span>;
}

export function EmptyState({
	title,
	text,
	action,
	tips,
}: {
	title: string;
	text: string;
	action?: React.ReactNode;
	tips?: string[];
}) {
	return (
		<div className="empty-state">
			<div className="empty-icon">
				<Inbox size={28} strokeWidth={1.5} />
			</div>
			<h3>{title}</h3>
			<p>{text}</p>
			{tips && tips.length > 0 && (
				<div className="empty-onboarding-tips">
					<div className="onboarding-label">
						<Sparkles size={13} />
						<span>下一步建议</span>
					</div>
					<ul>
						{tips.map((tip) => (
							<li key={tip}>{tip}</li>
						))}
					</ul>
				</div>
			)}
			{action && <div className="empty-action">{action}</div>}
		</div>
	);
}

export function SkeletonCard() {
	return (
		<div className="skeleton-card" aria-hidden="true">
			<div className="skeleton-pulse skeleton-line title" />
			<div className="skeleton-pulse skeleton-line medium" />
			<div className="skeleton-pulse skeleton-line full" />
			<div className="skeleton-pulse skeleton-line short" />
		</div>
	);
}

const SKELETON_KEYS = ["sk-1", "sk-2", "sk-3", "sk-4", "sk-5", "sk-6", "sk-7", "sk-8", "sk-9", "sk-10"];

export function SkeletonList({ count = 3 }: { count?: number }) {
	const keys = SKELETON_KEYS.slice(0, Math.min(count, SKELETON_KEYS.length));
	return (
		<div className="skeleton-list" aria-busy="true">
			{keys.map((key) => (
				<SkeletonCard key={key} />
			))}
		</div>
	);
}

export function AccessibleModal({
	title,
	description,
	onClose,
	children,
	footer,
	className = "",
	maxWidth = 640,
}: {
	title: string;
	description?: string;
	onClose: () => void;
	children: React.ReactNode;
	footer?: React.ReactNode;
	className?: string;
	maxWidth?: number | string;
}) {
	const modalRef = useRef<HTMLDivElement>(null);
	const prevFocusRef = useRef<HTMLElement | null>(null);
	// 调用方普遍传入内联箭头函数。若把 onClose 放进依赖数组，父组件每次重渲染都会
	// 重跑这个副作用，把焦点从正在输入的控件抢回弹窗第一个元素——表现就是每输入
	// 一个字符焦点就丢失。用 ref 读取最新回调，让副作用只在挂载与卸载时各跑一次。
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		prevFocusRef.current = document.activeElement as HTMLElement | null;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
			}
			if (event.key === "Tab" && modalRef.current) {
				const focusables = modalRef.current.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				);
				if (focusables.length === 0) return;
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", handleKeyDown);

		const focusTimer = window.setTimeout(() => {
			if (!modalRef.current) return;
			// 表单弹窗优先聚焦第一个输入控件；纯确认弹窗回退到首个可聚焦按钮，
			// 避免打开后焦点仍停在页面背后的触发按钮上。
			const first =
				modalRef.current.querySelector<HTMLElement>(
					'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
				) ??
				modalRef.current.querySelector<HTMLElement>(
					'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
				);
			first?.focus();
		}, 50);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			window.clearTimeout(focusTimer);
			prevFocusRef.current?.focus();
		};
	}, []);

	const titleId = useMemo(() => `modal-title-${Math.random().toString(36).slice(2, 8)}`, []);
	const descId = useMemo(() => `modal-desc-${Math.random().toString(36).slice(2, 8)}`, []);

	return (
		<div className="accessible-modal-overlay">
			<button
				type="button"
				className="accessible-modal-backdrop"
				onClick={onClose}
				aria-label="关闭对话框"
				tabIndex={-1}
			/>
			<div
				ref={modalRef}
				className={`accessible-modal-dialog ${className}`}
				style={{ maxWidth }}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descId : undefined}
			>
				<div className="accessible-modal-header">
					<div>
						<h3 id={titleId}>{title}</h3>
						{description && <p id={descId}>{description}</p>}
					</div>
					<button
						type="button"
						className="accessible-modal-close"
						onClick={onClose}
						aria-label="关闭对话框"
						title="关闭"
					>
						<X size={16} />
					</button>
				</div>
				<div className="accessible-modal-body">{children}</div>
				{footer && <div className="accessible-modal-footer">{footer}</div>}
			</div>
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
	truncateAbstract,
	collections,
	onAddToCollection,
	onMoveToCollection,
	onLoadLocalPdf,
	localPdfUploading,
	localPdfBusy,
	onDelete,
	researchNotes,
	onOpenResearchNote,
	onCreateResearchNote,
	deleteLabel = "Delete",
	deleteBusy,
	dragPaperIds,
	onSave,
	saved,
	saveBusy,
}: {
	paper: PaperRecord;
	selected?: boolean;
	onSelect?: (selected: boolean) => void;
	onOpen?: () => void;
	truncateAbstract?: boolean;
	collections?: PaperCollection[];
	onAddToCollection?: (paperId: string, collectionId: string) => void;
	onMoveToCollection?: (paperId: string, collectionId: string | null) => void;
	onLoadLocalPdf?: (paper: PaperRecord) => void;
	localPdfUploading?: boolean;
	localPdfBusy?: boolean;
	onDelete?: (paper: PaperRecord) => void;
	researchNotes?: ResearchNoteSummary[];
	onOpenResearchNote?: (noteId: string) => void;
	onCreateResearchNote?: () => void;
	deleteLabel?: string;
	deleteBusy?: boolean;
	dragPaperIds?: string[];
	onSave?: (paper: PaperRecord) => void;
	saved?: boolean;
	saveBusy?: boolean;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuMode, setMenuMode] = useState<"add" | "move" | "notes" | null>(null);
	const menuCloseTimerRef = useRef<number | undefined>(undefined);
	const collectionOptions = useMemo(
		() => flattenCollectionTree(buildCollectionTree(collections ?? [])),
		[collections],
	);
	useEffect(
		() => () => {
			if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current);
		},
		[],
	);
	const cancelMenuClose = () => {
		if (!menuCloseTimerRef.current) return;
		window.clearTimeout(menuCloseTimerRef.current);
		menuCloseTimerRef.current = undefined;
	};
	const scheduleMenuClose = () => {
		cancelMenuClose();
		menuCloseTimerRef.current = window.setTimeout(() => {
			setMenuOpen(false);
			setMenuMode(null);
			menuCloseTimerRef.current = undefined;
		}, 160);
	};
	return (
		<article
			className={`paper-card${dragPaperIds?.length ? " paper-card-draggable" : ""}`}
			draggable={Boolean(dragPaperIds?.length)}
			onDragStart={(event) => {
				if (!dragPaperIds?.length) return;
				event.dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(dragPaperIds));
				event.dataTransfer.setData("text/plain", paper.title);
				event.dataTransfer.effectAllowed = "copy";
			}}
		>
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
			{paper.abstract && (
				<p className={`paper-abstract${truncateAbstract ? " paper-abstract-truncated" : ""}`}>{paper.abstract}</p>
			)}
			<div className="paper-meta">
				{paper.venueRank && (
					<span className={`ccf-badge ccf-${paper.venueRank.toLowerCase()}`}>CCF-{paper.venueRank}</span>
				)}
				<span>{paper.venue || paper.publicationType || "来源未标注"}</span>
				{paper.identifiers.doi && <span>DOI {paper.identifiers.doi}</span>}
				<span>{[...new Set(paper.provenance.map((item) => item.provider))].join(" · ")}</span>
			</div>
			<div className="paper-card-actions">
				{(() => {
					const action = paperPrimaryAction(paper);
					if (!action) return null;
					return (
						<a
							className="paper-open-link"
							href={action.url}
							target="_blank"
							rel="noreferrer"
							title={action.label}
						>
							{action.label} <ArrowUpRight size={13} style={{ display: "inline-block", verticalAlign: "middle", marginLeft: 3 }} />
						</a>
					);
				})()}
				{onSave && (
					<button
						className={`paper-card-save-btn${saved ? " saved" : ""}`}
						type="button"
						disabled={saved || saveBusy}
						title={saved ? "已保存到个人库" : "保存到个人库"}
						onClick={() => onSave(paper)}
					>
						{saved ? <Check size={13} /> : <BookmarkPlus size={13} />}
						<span>{saved ? "已保存" : saveBusy ? "保存中…" : "保存"}</span>
					</button>
				)}
				{((collections && onAddToCollection && onMoveToCollection) ||
					onLoadLocalPdf ||
					onDelete ||
					onCreateResearchNote) && (
					<div className="paper-card-menu-wrap">
						<button
							className="paper-card-menu-btn"
							type="button"
							title="更多操作"
							aria-label="更多操作"
							onMouseEnter={cancelMenuClose}
							onMouseLeave={scheduleMenuClose}
							onClick={() => {
								setMenuOpen((current) => !current);
								setMenuMode(null);
							}}
						>
							<MoreHorizontal size={15} />
						</button>
						{menuOpen && (
							<div
								className="paper-card-menu"
								role="menu"
								onMouseEnter={cancelMenuClose}
								onMouseLeave={scheduleMenuClose}
							>
								{menuMode === null ? (
									<>
										{collections && onAddToCollection && onMoveToCollection && (
											<>
												<button
													className="paper-card-menu-item"
													type="button"
													onClick={() => setMenuMode("add")}
												>
													添加到
												</button>
												<button
													className="paper-card-menu-item"
													type="button"
													onClick={() => setMenuMode("move")}
												>
													移动到
												</button>
											</>
										)}
										{onLoadLocalPdf && (
											<button
												className="paper-card-menu-item"
												type="button"
												disabled={localPdfBusy}
												onClick={() => {
													setMenuOpen(false);
													setMenuMode(null);
													onLoadLocalPdf(paper);
												}}
											>
												{localPdfUploading ? "正在关联 PDF…" : "从本地加载 PDF"}
											</button>
										)}
										{onCreateResearchNote && (
											<button
												className="paper-card-menu-item"
												type="button"
												onClick={() => setMenuMode("notes")}
											>
												笔记
											</button>
										)}
										{onDelete && (
											<button
												className="paper-card-menu-item danger"
												type="button"
												disabled={deleteBusy}
												onClick={() => {
													setMenuOpen(false);
													setMenuMode(null);
													onDelete(paper);
												}}
											>
												{deleteLabel}
											</button>
										)}
									</>
								) : menuMode === "notes" && onCreateResearchNote ? (
									<div className="paper-card-note-menu">
										{researchNotes?.length ? (
											researchNotes.map((note) => (
												<button
													className="paper-card-menu-item"
													type="button"
													key={note.id}
													onClick={() => {
														onOpenResearchNote?.(note.id);
														setMenuOpen(false);
														setMenuMode(null);
													}}
												>
													{note.title}
												</button>
											))
										) : (
											<span className="paper-card-menu-empty">暂无关联笔记</span>
										)}
										<button
											className="paper-card-menu-item"
											type="button"
											onClick={() => {
												onCreateResearchNote();
												setMenuOpen(false);
												setMenuMode(null);
											}}
										>
											+ 新建笔记
										</button>
									</div>
								) : menuMode === "move" && collections && onMoveToCollection ? (
									<>
										<button
											className="paper-card-menu-item"
											type="button"
											onClick={() => {
												onMoveToCollection(paper.id, null);
												setMenuOpen(false);
												setMenuMode(null);
											}}
										>
											未分类
										</button>
										{collectionOptions.map(({ collection, path }) => (
											<button
												className="paper-card-menu-item"
												type="button"
												key={collection.id}
												onClick={() => {
													onMoveToCollection(paper.id, collection.id);
													setMenuOpen(false);
													setMenuMode(null);
												}}
											>
												{path.join(" / ")}
											</button>
										))}
									</>
								) : collections && onAddToCollection ? (
									collectionOptions.map(({ collection, path }) => (
										<button
											className="paper-card-menu-item"
											type="button"
											key={collection.id}
											onClick={() => {
												onAddToCollection(paper.id, collection.id);
												setMenuOpen(false);
												setMenuMode(null);
											}}
										>
											{path.join(" / ")}
										</button>
									))
								) : null}
							</div>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

export function PaperDetailDrawer({ paper, onClose }: { paper: PaperRecord; onClose: () => void }) {
	return (
		<div className="paper-detail-layer">
			<div className="paper-detail-mask" onClick={onClose} aria-hidden />
			<aside className="paper-detail-drawer" role="dialog" aria-label={`论文详情 ${paper.title}`}>
				<header className="paper-detail-head">
					<strong>论文详情</strong>
					<button type="button" className="paper-detail-close" aria-label="关闭" onClick={onClose}>
						<X size={16} aria-hidden="true" />
					</button>
				</header>
				<div className="paper-detail-body">
					<h2 className="paper-detail-title">{paper.title}</h2>
					<div className="paper-detail-meta">
						{paper.venueRank && (
							<span className={`ccf-badge ccf-${paper.venueRank.toLowerCase()}`}>CCF-{paper.venueRank}</span>
						)}
						<span className="year-badge">{paper.year ?? "—"}</span>
						{paper.venue && <span>{paper.venue}</span>}
						{paper.identifiers.doi && <span>DOI: {paper.identifiers.doi}</span>}
					</div>
					{paper.authors.length > 0 && (
						<section>
							<h3>作者</h3>
							<p className="paper-detail-authors">{paper.authors.join(", ")}</p>
						</section>
					)}
					{paper.abstract && (
						<section>
							<h3>摘要</h3>
							<p className="paper-detail-abstract">{paper.abstract}</p>
						</section>
					)}
					{paper.links.length > 0 && (
						<section>
							<h3>链接</h3>
							<ul className="paper-detail-links">
								{paperLinksForDisplay(paper).map((link) => (
									<li key={link.url}>
										<a href={link.url} target="_blank" rel="noreferrer">
											{link.kind} · {link.url}
										</a>
									</li>
								))}
							</ul>
						</section>
					)}
					{paper.provenance.length > 0 && (
						<section>
							<h3>来源</h3>
							<p className="paper-detail-source">
								{[...new Set(paper.provenance.map((item) => item.provider))].join(" · ")}
							</p>
						</section>
					)}
				</div>
			</aside>
		</div>
	);
}

function paperPrimaryIdentifier(paper: PaperRecord): string {
	if (paper.identifiers.doi) return `DOI ${paper.identifiers.doi}`;
	if (paper.identifiers.arxivId) return `arXiv ${paper.identifiers.arxivId}`;
	if (paper.identifiers.semanticScholarId) return `S2 ${paper.identifiers.semanticScholarId}`;
	if (paper.identifiers.openAlexId) return `OpenAlex ${paper.identifiers.openAlexId}`;
	return "—";
}

export function SearchResultTable({
	papers,
	selected,
	onSelect,
	onOpenAbstract,
}: {
	papers: PaperRecord[];
	selected: Set<string>;
	onSelect: (id: string, checked: boolean) => void;
	onOpenAbstract: (paper: PaperRecord) => void;
}) {
	return (
		<div className="search-result-table-wrap">
			<table className="search-result-table">
				<thead>
					<tr>
						<th className="col-select" />
						<th>标题</th>
						<th>年份</th>
						<th>Venue</th>
						<th>标识</th>
						<th>来源</th>
						<th>摘要</th>
					</tr>
				</thead>
				<tbody>
					{papers.map((paper) => {
						const url = paperPrimaryUrl(paper);
						return (
							<tr key={paper.id}>
								<td className="col-select">
									<input
										aria-label={`选择 ${paper.title}`}
										type="checkbox"
										checked={selected.has(paper.id)}
										onChange={(event) => onSelect(paper.id, event.target.checked)}
									/>
								</td>
								<td className="col-title">
									{url ? (
										<a href={url} target="_blank" rel="noreferrer">
											{paper.title}
										</a>
									) : (
										<span className="paper-detail-title-inline">{paper.title}</span>
									)}
									{paper.authors.length > 0 && (
										<span className="search-table-authors">{paper.authors.slice(0, 4).join(", ")}</span>
									)}
								</td>
								<td>{paper.year ?? "—"}</td>
								<td>
									{paper.venueRank && (
										<span className={`ccf-badge ccf-${paper.venueRank.toLowerCase()}`}>
											CCF-{paper.venueRank}
										</span>
									)}{" "}
									<span>{paper.venue || paper.publicationType || "—"}</span>
								</td>
								<td className="col-identifier">{paperPrimaryIdentifier(paper)}</td>
								<td>{[...new Set(paper.provenance.map((item) => item.provider))].join(" · ")}</td>
								<td className="col-abstract">
									<button
										type="button"
										className="abstract-link"
										disabled={!paper.abstract}
										onClick={() => onOpenAbstract(paper)}
									>
										摘要
									</button>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function ConsentCard({
	operation,
	onConfirm,
	onCancel,
	busy,
}: {
	operation: PreparedOperation;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
	busy?: boolean;
}) {
	const { confirmationRequired, automaticAttemptFailed } = useAutomaticOperationConfirmation(
		operation,
		Boolean(busy),
		onConfirm,
	);
	if (!confirmationRequired && !automaticAttemptFailed) {
		return <LoadingBlock text="正在根据操作确认设置执行…" />;
	}
	return (
		<section className="consent-card">
			<div>
				<span className="eyebrow">{automaticAttemptFailed ? "自动执行未完成" : "需要人工确认"}</span>
				<h3>{operation.summary}</h3>
				<p className="fingerprint">Manifest {operation.manifestFingerprint}</p>
			</div>
			<section className="consent-targets" aria-label="待确认目标">
				{operation.targets.slice(0, 12).map((target) => (
					<div className="consent-target" key={`${target.label}-${target.value}`}>
						<StatusPill status={target.risk ?? "medium"} />
						<span>{target.label}</span>
						<code>{target.value}</code>
					</div>
				))}
				{operation.targets.length > 12 && <p>另有 {operation.targets.length - 12} 个目标。</p>}
			</section>
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
