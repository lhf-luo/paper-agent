import { useState } from "react";
import type { TeamReviewResource, TeamReviewSnapshot } from "../../src/team/domain/team-corpus-types";
import type { PaperRecord, PreparedOperation } from "./types";
import type { PaperVersion } from "../../src/literature/domain/literature-types";
import { TeamKnowledgeContent, type TeamKnowledgeValue, TeamMarkdown } from "./team-content-view";

export function TeamSnapshotBody({ resource, content }: { resource: TeamReviewResource; content: unknown }) {
	if (resource !== "papers")
		return <TeamKnowledgeContent value={{ resource, entry: content } as TeamKnowledgeValue} />;
	const value = content as { record?: PaperRecord; versions?: PaperVersion[] };
	const paper = value.record ?? (content as PaperRecord);
	return (
		<div className="team-content-markdown">
			<h3>{paper.title}</h3>
			<p>
				{paper.authors?.join(", ")} · {paper.year ?? "年份未知"} · {paper.venue}
			</p>
			<TeamMarkdown text={paper.abstract ?? "暂无摘要"} />
			{paper.links?.map((link) => (
				<p key={link.url}>
					<a href={/^https?:\/\//i.test(link.url) ? link.url : undefined} target="_blank" rel="noreferrer">
						{link.kind} · {link.url}
					</a>
				</p>
			))}
			{value.versions?.map((version) => (
				<p key={`${version.sha256}-${version.finalUrl}`}>
					<a href={`/api/team/blobs/${version.sha256}`} target="_blank" rel="noreferrer">
						阅读 PDF 附件
					</a>{" "}
					· {version.sha256} · {version.teamReview?.status ?? "已发布"}
				</p>
			))}
			<details>
				<summary>完整论文元数据</summary>
				<pre>{JSON.stringify(paper, null, 2)}</pre>
			</details>
		</div>
	);
}

function PreviewValue({ value }: { value: unknown }) {
	if (!value || typeof value !== "object") return <pre>{JSON.stringify(value, null, 2)}</pre>;
	const item = value as Record<string, unknown>;
	if (item.resource && item.content) {
		const snapshot = value as TeamReviewSnapshot;
		return (
			<div>
				<p>
					内容版本：<code>{snapshot.version}</code>
				</p>
				<div className={snapshot.approvedContent ? "team-content-comparison" : ""}>
					{Boolean(snapshot.approvedContent) && (
						<section>
							<h4>已发布版本</h4>
							<TeamSnapshotBody resource={snapshot.resource} content={snapshot.approvedContent} />
						</section>
					)}
					<section>
						<h4>本次内容</h4>
						<TeamSnapshotBody resource={snapshot.resource} content={snapshot.content} />
					</section>
				</div>
			</div>
		);
	}
	if (typeof item.markdown === "string")
		return (
			<>
				<p>{String(item.title ?? "知识快照")}</p>
				<TeamMarkdown text={item.markdown} />
				<details>
					<summary>来源与关联信息</summary>
					<pre>{JSON.stringify({ ...item, markdown: undefined }, null, 2)}</pre>
				</details>
			</>
		);
	if (item.snapshot) return <PreviewValue value={item.snapshot} />;
	if (Array.isArray(item.authors)) return <TeamSnapshotBody resource="papers" content={item} />;
	return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function TeamOperationPreview({ operation }: { operation: PreparedOperation }) {
	const [index, setIndex] = useState(0);
	const details = operation.details ?? {};
	const source = details.preview ?? details.previews;
	const entries: unknown[] = Array.isArray(source) ? source : source ? [source] : [];
	return (
		<section className="team-operation-preview">
			<h3>核对本次操作</h3>
			<p>
				团队空间：{String(details.teamNamespace ?? details.namespace ?? "当前空间")}
				{details.personalNamespace ? ` · 个人空间：${details.personalNamespace}` : ""}
			</p>
			{Boolean(details.warnings) && <pre>{JSON.stringify(details.warnings, null, 2)}</pre>}
			{entries.length > 1 && (
				<label>
					逐项查看内容（共 {entries.length} 项）
					<select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
						{entries.map((_, i) => (
							<option key={operation.targets[i]?.value ?? String(i)} value={i}>
								{i + 1}. {operation.targets[i]?.label ?? "内容"}
							</option>
						))}
					</select>
				</label>
			)}
			{entries.length ? (
				<PreviewValue value={entries[Math.min(index, entries.length - 1)]} />
			) : (
				<pre>{JSON.stringify(details.input ?? details.member ?? details, null, 2)}</pre>
			)}
			{Boolean(details.input) && entries.length > 0 && <pre>{JSON.stringify(details.input, null, 2)}</pre>}
		</section>
	);
}
