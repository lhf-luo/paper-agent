import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TeamArtifactEntry, TeamDerivedEntry, TeamPageEntry } from "../../src/team/domain/team-corpus-types";
import type { PaperRecord } from "./types";
import { api } from "./api";
import { AccessibleModal, StatusPill } from "./components";
import "./team-content-view.css";

export type TeamKnowledgeValue =
	| { resource: "pages"; entry: TeamPageEntry }
	| { resource: "derived"; entry: TeamDerivedEntry }
	| { resource: "artifacts"; entry: TeamArtifactEntry };

function safeLink(value?: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function TeamMarkdown({ text }: { text: string }) {
	return (
		<article className="team-content-markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) =>
						safeLink(href) ? (
							<a href={safeLink(href)} target="_blank" rel="noreferrer">
								{children}
							</a>
						) : (
							<span>{children}</span>
						),
					img: ({ src, alt }) =>
						safeLink(typeof src === "string" ? src : undefined) ? (
							<a href={safeLink(typeof src === "string" ? src : undefined)} target="_blank" rel="noreferrer">
								查看图片：{alt || "图片"}
							</a>
						) : (
							<span>{alt || "本地图片未共享"}</span>
						),
				}}
			>
				{text}
			</ReactMarkdown>
		</article>
	);
}

export function TeamKnowledgeContent({ value }: { value: TeamKnowledgeValue }) {
	if (value.resource === "pages") return <TeamMarkdown text={value.entry.snapshot.markdown} />;
	if (value.resource === "derived")
		return (
			<>
				<h4>研究结果</h4>
				{typeof value.entry.record.result === "string" ? (
					<TeamMarkdown text={value.entry.record.result} />
				) : (
					<pre>{JSON.stringify(value.entry.record.result, null, 2)}</pre>
				)}
				<details>
					<summary>输入与生成信息</summary>
					<pre>{JSON.stringify({ ...value.entry.record, result: undefined }, null, 2)}</pre>
				</details>
			</>
		);
	return (
		<>
			<h4>来源与材料清单</h4>
			{value.entry.manifest.candidates.map((item) => (
				<div className="team-content-source" key={item.id}>
					<a href={safeLink(item.url)} target="_blank" rel="noreferrer">
						{item.url}
					</a>
					<span>
						{item.kind} · {item.confidence}
					</span>
					{item.sources.map((source, index) => (
						<p key={`${source.method}-${index}`}>
							第 {source.page ?? "?"} 页 · {source.method} · {source.context}
						</p>
					))}
				</div>
			))}
			<h4>获取结果</h4>
			{value.entry.manifest.acquisitions.map((item, index) => (
				<div className="team-content-source" key={`${item.candidateId}-${index}`}>
					<a href={safeLink(item.finalUrl ?? item.sourceUrl)} target="_blank" rel="noreferrer">
						{item.sourceUrl}
					</a>
					<span>
						{item.status} · {item.commit ?? item.sha256 ?? "无内容标识"}
					</span>
					{item.sha256 && (
						<a href={`/api/team/blobs/${item.sha256}`} target="_blank" rel="noreferrer">
							读取团队附件
						</a>
					)}
					{item.failureReason && <p>{item.failureReason}</p>}
				</div>
			))}
			<details>
				<summary>完整 Manifest</summary>
				<pre>{JSON.stringify(value.entry.manifest, null, 2)}</pre>
			</details>
		</>
	);
}

export function TeamKnowledgeDialog({
	value,
	previous,
	onClose,
}: {
	value: TeamKnowledgeValue;
	previous?: TeamKnowledgeValue;
	onClose: () => void;
}) {
	const [paper, setPaper] = useState<PaperRecord>();
	const [error, setError] = useState("");
	const title =
		value.resource === "pages"
			? value.entry.snapshot.title
			: value.resource === "derived"
				? value.entry.record.operation
				: "Artifact 材料清单";
	const paperIds =
		value.resource === "pages"
			? value.entry.snapshot.paperIds
			: [value.resource === "derived" ? value.entry.record.paperId : value.entry.paperId];
	const openPaper = async (id: string) => {
		setError("");
		try {
			setPaper(await api<PaperRecord>(`/api/team/papers/${encodeURIComponent(id)}`));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const exportContent = () => {
		const text =
			value.resource === "pages"
				? `<!-- Team source: ${JSON.stringify({ key: value.entry.snapshot.key, contentHash: value.entry.snapshot.contentHash, sourceIdentityId: value.entry.snapshot.sourceIdentityId, sourceNamespace: value.entry.snapshot.sourceNamespace })} -->\n\n${value.entry.snapshot.markdown}`
				: JSON.stringify(value.entry, null, 2);
		const url = URL.createObjectURL(
			new Blob([text], { type: value.resource === "pages" ? "text/markdown;charset=utf-8" : "application/json" }),
		);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80)}.${value.resource === "pages" ? "md" : "json"}`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return (
		<AccessibleModal
			title={title}
			description="共享内容快照。技术判断请继续核对关联论文和一手材料。"
			onClose={onClose}
			maxWidth={1100}
			className="team-content-dialog"
		>
			<div className="team-content-toolbar">
				<StatusPill status={value.entry.review.status} />
				<span>提交：{value.entry.review.proposedBy}</span>
				<button type="button" onClick={exportContent}>
					导出快照
				</button>
			</div>
			{value.entry.review.reason && <p>审核意见：{value.entry.review.reason}</p>}
			{value.resource === "pages" && (
				<p className="team-content-origin">
					来源空间：{value.entry.snapshot.sourceNamespace ?? "default"} · 版本 {value.entry.snapshot.revision} ·{" "}
					{value.entry.snapshot.contentHash}
				</p>
			)}
			<div className={previous ? "team-content-comparison" : ""}>
				{previous && (
					<section>
						<h4>已发布版本</h4>
						<TeamKnowledgeContent value={previous} />
					</section>
				)}
				<section>
					{previous && <h4>待审修订</h4>}
					<TeamKnowledgeContent value={value} />
				</section>
			</div>
			{paperIds.length > 0 && (
				<section>
					<h4>关联论文与证据入口</h4>
					<div className="team-content-toolbar">
						{paperIds.map((id) => (
							<button key={id} type="button" onClick={() => void openPaper(id)}>
								{id}
							</button>
						))}
					</div>
				</section>
			)}
			{error && <p role="alert">该关联论文可能尚未共享或未获批准：{error}</p>}
			{paper && (
				<section className="team-content-source">
					<h4>{paper.title}</h4>
					<p>{paper.abstract}</p>
					{paper.links.map((link) => (
						<a key={link.url} href={safeLink(link.url)} target="_blank" rel="noreferrer">
							{link.kind}：{link.url}
						</a>
					))}
				</section>
			)}
		</AccessibleModal>
	);
}
