import { BookOpen, FileText, List, X } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { activePaperDetailFields } from "../../src/literature/domain/paper-detail-fields";
import type { PaperRecord, PaperVersionView } from "./types";

export interface CanvasPaperDetails {
	paper: PaperRecord;
	versions: PaperVersionView[];
	derived: unknown[];
}

type PreviewTab = "metadata" | "abstract" | "fields";

const tabs: Array<{ id: PreviewTab; label: string; icon: typeof BookOpen }> = [
	{ id: "metadata", label: "基本信息", icon: BookOpen },
	{ id: "abstract", label: "摘要", icon: FileText },
	{ id: "fields", label: "信息卡片", icon: List },
];

const present = (value: string | number | undefined) =>
	typeof value === "string" ? value.trim() || "—" : (value ?? "—");

export function CanvasPaperPreview({
	paper,
	details,
	loading,
	error,
	style,
	onClose,
}: {
	paper: PaperRecord;
	details?: CanvasPaperDetails;
	loading: boolean;
	error?: string;
	style: CSSProperties;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<PreviewTab>("metadata");
	const current = details?.paper ?? paper;
	const fields = activePaperDetailFields(current.curation?.detailFields);
	const loadedCount = (count: number | undefined) => (count === undefined ? (loading ? "…" : "—") : count);
	return (
		<aside
			className="research-canvas-paper-preview"
			style={style}
			aria-label={`${current.title} 的论文预览`}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="research-canvas-paper-preview-head">
				<div>
					<span className="research-canvas-paper-preview-eyebrow">PAPER PREVIEW · 论文速览</span>
					<h3>{current.title}</h3>
					<p>{current.authors.join("、") || "作者未标注"}</p>
				</div>
				<button type="button" aria-label="关闭论文预览" onClick={onClose}>
					<X size={18} />
				</button>
			</div>
			<div className="research-canvas-paper-preview-tabs" role="tablist" aria-label="论文预览内容">
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						className={tab === id ? "active" : ""}
						onClick={() => setTab(id)}
					>
						<Icon size={15} />
						{label}
					</button>
				))}
			</div>
			<div className="research-canvas-paper-preview-body" role="tabpanel">
				{tab === "metadata" && (
					<div className="research-canvas-paper-facts">
						<div className="research-canvas-paper-facts-grid">
							<div>
								<span>年份</span>
								<strong>{present(current.year)}</strong>
							</div>
							<div>
								<span>Venue</span>
								<strong>{present(current.venue)}</strong>
							</div>
							<div>
								<span>DOI</span>
								<strong>{present(current.identifiers.doi)}</strong>
							</div>
							<div>
								<span>arXiv</span>
								<strong>{present(current.identifiers.arxivId)}</strong>
							</div>
							<div>
								<span>CCF</span>
								<strong>{present(current.venueRank)}</strong>
							</div>
							<div>
								<span>类型</span>
								<strong>{present(current.publicationType)}</strong>
							</div>
						</div>
						<div className="research-canvas-paper-stats">
							<div>
								<span>PDF 版本</span>
								<strong>{loadedCount(details?.versions.length)}</strong>
							</div>
							<div>
								<span>派生记忆</span>
								<strong>{loadedCount(details?.derived.length)}</strong>
							</div>
							<div>
								<span>引用</span>
								<strong>{present(current.referencedWorks?.length)}</strong>
							</div>
							<div>
								<span>被引用</span>
								<strong>{present(current.citationCount)}</strong>
							</div>
						</div>
					</div>
				)}
				{tab === "abstract" && (
					<div className="research-canvas-paper-abstract">
						<p>{current.abstract?.trim() || "这篇论文暂无摘要。"}</p>
					</div>
				)}
				{tab === "fields" && (
					<div className="research-canvas-paper-fields">
						<div className="research-canvas-paper-fields-intro">
							<strong>阅读与研究记录</strong>
							<span>已保存内容 · 只读</span>
						</div>
						{fields.map((field) => (
							<div className="research-canvas-paper-field" key={field.id}>
								<span>{field.label}</span>
								<p className={field.value ? "" : "empty"}>{field.value || "未填写"}</p>
							</div>
						))}
						{current.curation?.detailFields?.updatedAt && (
							<small>最后一次修改：{current.curation.detailFields.updatedAt}</small>
						)}
					</div>
				)}
				{error && <p className="research-canvas-paper-preview-error">最新统计读取失败：{error}</p>}
			</div>
		</aside>
	);
}
