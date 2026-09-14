import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Info } from "lucide-react";
import { useState } from "react";
import type { PaperVersion } from "../../src/literature/domain/literature-types";
import type { TeamReviewResource, TeamReviewSnapshot } from "../../src/team/domain/team-corpus-types";
import { AccessibleModal, LoadingBlock, StatusPill } from "./components";
import { useAutomaticOperationConfirmation } from "./confirmation-policy";
import { TeamKnowledgeContent, type TeamKnowledgeValue, TeamMarkdown } from "./team-content-view";
import type { PaperRecord, PreparedOperation } from "./types";
import "./team-operation-preview.css";

export function TeamSnapshotBody({ resource, content }: { resource: TeamReviewResource; content: unknown }) {
	if (resource !== "papers")
		return <TeamKnowledgeContent value={{ resource, entry: content } as TeamKnowledgeValue} />;
	const value = content as { record?: PaperRecord; versions?: PaperVersion[] };
	const paper = value.record ?? (content as PaperRecord);
	return (
		<div className="team-preview-paper-card">
			<h4 className="team-preview-paper-title">{paper.title}</h4>
			<p className="team-preview-paper-meta">
				{paper.authors?.slice(0, 6).join(", ")}
				{paper.authors && paper.authors.length > 6 ? ` 等 ${paper.authors.length} 位作者` : ""}
				{paper.year ? ` · ${paper.year}` : ""}
				{paper.venue ? ` · ${paper.venue}` : ""}
			</p>
			{paper.abstract && (
				<div className="team-preview-abstract-card">
					<span className="team-preview-box-label">论文摘要</span>
					<div className="team-preview-abstract-scroll">
						<TeamMarkdown text={paper.abstract} />
					</div>
				</div>
			)}
			{paper.links?.length || value.versions?.length ? (
				<div className="team-preview-links-row">
					{paper.links?.map((link) => (
						<a
							key={link.url}
							href={/^https?:\/\//i.test(link.url) ? link.url : undefined}
							target="_blank"
							rel="noreferrer"
							className="preview-resource-chip"
						>
							<ExternalLink size={11} />
							<span>{link.kind.toUpperCase()}</span>
						</a>
					))}
					{value.versions?.map((version) => (
						<a
							key={`${version.sha256}-${version.finalUrl}`}
							href={`/api/team/blobs/${version.sha256}`}
							target="_blank"
							rel="noreferrer"
							className="preview-resource-chip pdf"
						>
							<FileText size={11} />
							<span>PDF 附件 ({version.sha256.slice(0, 8)})</span>
						</a>
					))}
				</div>
			) : null}
			<details className="team-preview-raw-toggle">
				<summary>展开完整论文元数据 (JSON)</summary>
				<pre>{JSON.stringify(paper, null, 2)}</pre>
			</details>
		</div>
	);
}

function PreviewValue({ value }: { value: unknown }) {
	if (!value || typeof value !== "object")
		return <pre className="preview-raw-details">{JSON.stringify(value, null, 2)}</pre>;
	const item = value as Record<string, unknown>;
	if (item.resource && item.content) {
		const snapshot = value as TeamReviewSnapshot;
		return (
			<div className="team-preview-snapshot-wrapper">
				<div className="team-preview-version-pill">
					<span>内容版本快照</span>
					<code>{snapshot.version.slice(0, 16)}…</code>
				</div>
				<div className={snapshot.approvedContent ? "team-content-comparison" : ""}>
					{Boolean(snapshot.approvedContent) && (
						<section className="preview-compare-col">
							<span className="compare-col-heading">已发布版本</span>
							<TeamSnapshotBody resource={snapshot.resource} content={snapshot.approvedContent} />
						</section>
					)}
					<section className="preview-compare-col">
						{Boolean(snapshot.approvedContent) && <span className="compare-col-heading">本次修订内容</span>}
						<TeamSnapshotBody resource={snapshot.resource} content={snapshot.content} />
					</section>
				</div>
			</div>
		);
	}
	if (typeof item.markdown === "string")
		return (
			<div className="team-preview-markdown-wrapper">
				<h4 className="preview-item-title">{String(item.title ?? "知识快照")}</h4>
				<div className="team-preview-abstract-scroll">
					<TeamMarkdown text={item.markdown} />
				</div>
				<details className="team-preview-raw-toggle">
					<summary>来源与关联信息</summary>
					<pre>{JSON.stringify({ ...item, markdown: undefined }, null, 2)}</pre>
				</details>
			</div>
		);
	if (item.snapshot) return <PreviewValue value={item.snapshot} />;
	if (Array.isArray(item.authors)) return <TeamSnapshotBody resource="papers" content={item} />;
	return <pre className="preview-raw-details">{JSON.stringify(value, null, 2)}</pre>;
}

export function TeamOperationPreview({ operation }: { operation: PreparedOperation }) {
	const [index, setIndex] = useState(0);
	const details = operation.details ?? {};
	const source = details.preview ?? details.previews;
	const entries: unknown[] = Array.isArray(source) ? source : source ? [source] : [];
	return (
		<section className="team-operation-preview-panel">
			<div className="preview-panel-header">
				<div className="preview-space-meta">
					<span>
						团队空间：<strong>{String(details.teamNamespace ?? details.namespace ?? "当前空间")}</strong>
					</span>
					{details.personalNamespace ? (
						<span>
							{" "}
							· 个人空间：<strong>{String(details.personalNamespace)}</strong>
						</span>
					) : null}
				</div>
				{entries.length > 1 && (
					<label className="preview-entry-select-label">
						<span>逐项核对（共 {entries.length} 项）：</span>
						<select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
							{entries.map((_, i) => (
								<option key={operation.targets[i]?.value ?? String(i)} value={i}>
									{i + 1}. {operation.targets[i]?.label ?? "条目"}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			{Boolean(details.warnings) && (
				<div className="preview-warning-box">
					<AlertTriangle size={14} />
					<pre>{JSON.stringify(details.warnings, null, 2)}</pre>
				</div>
			)}
			<div className="preview-entry-body">
				{entries.length ? (
					<PreviewValue value={entries[Math.min(index, entries.length - 1)]} />
				) : (
					<pre className="preview-raw-details">
						{JSON.stringify(details.input ?? details.member ?? details, null, 2)}
					</pre>
				)}
				{Boolean(details.input) && entries.length > 0 && (
					<details className="team-preview-raw-toggle">
						<summary>输入参数详情 (Input)</summary>
						<pre>{JSON.stringify(details.input, null, 2)}</pre>
					</details>
				)}
			</div>
		</section>
	);
}

export function TeamOperationModal({
	operation,
	busy,
	onConfirm,
	onCancel,
}: {
	operation: PreparedOperation;
	busy?: boolean;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
}) {
	const { confirmationRequired, automaticAttemptFailed } = useAutomaticOperationConfirmation(
		operation,
		Boolean(busy),
		onConfirm,
	);

	const summaryLower = operation.summary.toLowerCase();
	const isReject = summaryLower.includes("reject") || summaryLower.includes("拒绝") || summaryLower.includes("驳回");
	const isApprove = summaryLower.includes("approve") || summaryLower.includes("批准") || summaryLower.includes("通过");
	const isPull = summaryLower.includes("pull") || summaryLower.includes("拉取");
	const isBackup = summaryLower.includes("backup") || summaryLower.includes("备份");
	const isRestore = summaryLower.includes("restore") || summaryLower.includes("恢复");

	const modalTitle = isReject
		? "确认驳回团队提案"
		: isApprove
			? "确认批准入库提案"
			: isPull
				? "确认拉取团队文献"
				: isBackup
					? "确认创建全量备份"
					: isRestore
						? "确认执行恢复演练"
						: "确认团队操作";

	const confirmLabel = busy
		? "正在执行…"
		: isReject
			? "确认驳回"
			: isApprove
				? "确认批准入库"
				: isPull
					? "确认拉取"
					: "确认并执行";

	const confirmButtonClass = isReject ? "avant-btn-danger" : "avant-btn-primary";

	const highestRisk = operation.targets.some((t) => t.risk === "high")
		? "high"
		: isReject
			? "high"
			: operation.targets.some((t) => t.risk === "medium")
				? "medium"
				: "low";

	const footer = (
		<div className="team-modal-sticky-footer">
			<div className="footer-meta-left">
				<StatusPill status={highestRisk} />
				<span className="footer-fingerprint">
					Manifest <code>{operation.manifestFingerprint.slice(0, 10)}…</code>
				</span>
			</div>
			<div className="footer-buttons-right">
				<button type="button" className="avant-btn avant-btn-secondary" disabled={busy} onClick={onCancel}>
					取消
				</button>
				<button
					type="button"
					className={`avant-btn ${confirmButtonClass}`}
					disabled={busy}
					onClick={() => void onConfirm()}
				>
					{isReject ? <AlertTriangle size={14} /> : isApprove ? <CheckCircle2 size={14} /> : null}
					<span>{confirmLabel}</span>
				</button>
			</div>
		</div>
	);

	if (!confirmationRequired && !automaticAttemptFailed) {
		return (
			<AccessibleModal title={modalTitle} onClose={onCancel} maxWidth={640}>
				<LoadingBlock text="正在根据操作确认设置执行…" />
			</AccessibleModal>
		);
	}

	return (
		<AccessibleModal
			title={modalTitle}
			onClose={() => {
				if (!busy) onCancel();
			}}
			maxWidth={760}
			className="team-operation-dialog"
			footer={footer}
		>
			<div className="team-operation-dialog-content">
				{/* Operation Alert Banner */}
				<div className={`team-operation-alert-banner ${isReject ? "reject" : isApprove ? "approve" : "info"}`}>
					<div className="alert-banner-icon">
						{isReject ? <AlertTriangle size={20} /> : isApprove ? <CheckCircle2 size={20} /> : <Info size={20} />}
					</div>
					<div className="alert-banner-copy">
						<h4>{operation.summary}</h4>
						<p>
							{isReject
								? "您正在驳回此项团队提案。被驳回后该条目将移出待审队列，并保留历史流转记录。"
								: isApprove
									? "您正在批准此项提案入库。批准后将正式发布至团队共享知识库，所有空间成员均可查阅与拉取。"
									: isPull
										? "您正在将团队文献与物料同步拉取至您的个人文献库。"
										: "该操作包含对团队服务端状态的写操作，请在核对无误后确认执行。"}
						</p>
					</div>
				</div>

				{/* Targets summary pills */}
				{operation.targets.length > 0 && (
					<div className="team-targets-summary">
						<span className="summary-title">涉及目标对象（共 {operation.targets.length} 项）：</span>
						<div className="targets-pills-row">
							{operation.targets.slice(0, 8).map((target) => (
								<div className="target-pill-chip" key={`${target.label}-${target.value}`}>
									<StatusPill status={target.risk ?? (isReject ? "high" : "medium")} />
									<span className="target-label-text">{target.label}</span>
									<code className="target-value-text">{target.value}</code>
								</div>
							))}
							{operation.targets.length > 8 && (
								<span className="targets-overflow-text">另有 {operation.targets.length - 8} 项…</span>
							)}
						</div>
					</div>
				)}

				{/* Content Preview */}
				<TeamOperationPreview operation={operation} />
			</div>
		</AccessibleModal>
	);
}
