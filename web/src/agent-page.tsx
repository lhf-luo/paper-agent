import { Brain, Menu, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	type AgentResultDocument,
	collectAgentResultDocuments,
	parseAgentResultOutput,
} from "./agent-results";
import { isAgentTranscriptNearBottom } from "./agent-scroll";
import { api, apiEventStream, apiText, friendlyNetworkError, jsonBody } from "./api";
import { buildCollectionTree, flattenCollectionTree } from "./collection-tree";
import type { ParsedCell, ParsedLiteratureTable } from "./literature-markdown";
import { parseLiteratureTables } from "./literature-markdown";
import type {
	AgentConfigView,
	AgentEvent,
	AgentMode,
	AgentPermissionMode,
	AgentSessionSnapshot,
	AgentSessionSummary,
	AgentThinkingLevel,
	AgentToolView,
	AgentUIRequestView,
	PaperCollection,
} from "./types";

const thinkingLevelOptions: Array<{ value: AgentThinkingLevel; label: string }> = [
	{ value: "off", label: "思考：关闭" },
	{ value: "minimal", label: "思考：极简" },
	{ value: "low", label: "思考：低" },
	{ value: "medium", label: "思考：中" },
	{ value: "high", label: "思考：高" },
	{ value: "xhigh", label: "思考：极高" },
];

const permissionModeOptions: Array<{ value: AgentPermissionMode; label: string }> = [
	{ value: "ask", label: "权限：确认后执行" },
	{ value: "auto", label: "权限：自动批准" },
];

const taskTemplates = [
	{
		title: "搜集主题论文",
		prompt: "围绕“请替换为研究主题”搜集高相关论文。先给出检索式与纳入标准，再执行一次性检索；不要自动持久化或下载。",
	},
	{
		title: "分析本地 PDF",
		prompt: "分析本地 PDF：请替换为绝对路径。先核实文件身份与页数，给出研究问题、方法、主要证据、局限和下一步；不要自动下载 Artifact。",
	},
	{
		title: "导入本地 PDF 到个人库",
		prompt: "把本地 PDF 导入到 default 个人库：请替换为 PDF 的绝对路径（支持单个文件或整个目录）。用 import_literature_corpus 工具导入 personal 范围，先展示解析出的记录数与拒绝日志，完成确认后再写入；导入后说明 PDF 已入库、可在 PDF 工作区按标题选择分析。",
	},
	{
		title: "生成略读卡",
		prompt: "为这篇论文生成略读笔记：请替换为 PDF 路径或论文 ID。按 skim-card 技能的五问法（解决什么问题 / 现有方法为何不够 / 核心机制 / 哪个实验最直接支持 / 留下什么边界）回答，输出「问题 | research gap | 核心创新 | 关键证据 | 主要局限 | 精读/保留/排除」格式，并给出处置建议。gap 与创新点必须回到原文确认，标注证据位置；读完通过 manage_research_note 保存 Markdown 笔记并关联论文。",
	},
	{
		title: "查询个人库",
		prompt: "查询 default 个人论文库中与“请替换为主题”有关的记录，说明命中依据、已有笔记与证据边界，不要执行写入。",
	},
	{
		title: "比较多篇论文",
		prompt: "比较以下论文在研究问题、方法、数据集、关键结果、局限和可复现性上的差异：请粘贴论文 ID、标题或 PDF 路径。",
	},
	{
		title: "检查 Artifact",
		prompt: "检查这篇论文的官方 Artifact 候选、来源证据、许可证和版本信息：请提供 PDF 路径。先列候选，不要在未确认前下载或 clone。",
	},
	{
		title: "团队知识库",
		prompt: "查询团队知识库中与“请替换为主题”有关的已批准内容；如需提出共享提议，先展示将提交的记录与隐私边界，并等待人工确认。",
	},
];

const paperQuickPrompts = ["概括论文", "解释方法", "分析实验", "总结局限"];

interface FlatPaperRow {
	key: string;
	row: ParsedCell[];
	meta: Record<string, unknown>;
	paperId: string;
	title: string;
	titleUrl?: string;
	doi?: string;
	abstract?: string;
	focus: string;
	authors?: string;
	year?: string;
	venue?: string;
	citationCount?: number;
	relevance?: string;
	topic?: string;
	ccf?: string;
	curated?: "search" | "llm";
	relationship?: "reference" | "citation";
	savable: boolean;
}

/** 渲染一个表格单元格: 带链接则渲染链接, 否则纯文本。 */
function renderCell(cell?: ParsedCell) {
	if (!cell) return null;
	return cell.url ? (
		<a
			href={cell.url}
			target="_blank"
			rel="noreferrer"
			onClick={(event) => event.stopPropagation()}
		>
			{cell.text}
		</a>
	) : (
		cell.text
	);
}

function AgentResultSidebar({
	documents,
	activeDocument,
	activeRowCount,
	tables,
	loading,
	error,
	onSelect,
	onClose,
}: {
	documents: AgentResultDocument[];
	activeDocument?: AgentResultDocument;
	activeRowCount?: number;
	tables: ParsedLiteratureTable[];
	loading: boolean;
	error: string;
	onSelect: (url: string) => void;
	onClose: () => void;
}) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detailPaper, setDetailPaper] = useState<FlatPaperRow>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const [saveMessage, setSaveMessage] = useState("");
	const [collections, setCollections] = useState<PaperCollection[]>([]);
	const [selectedCollection, setSelectedCollection] = useState("");
	const collectionOptions = useMemo(
		() => flattenCollectionTree(buildCollectionTree(collections)),
		[collections],
	);

	const headerLabels = tables[0]?.customHeaders?.length ? tables[0].customHeaders : tables[0]?.headers ?? [];
	const focusCol = headerLabels.indexOf("focus");

	useEffect(() => {
		void api<PaperCollection[]>("/api/library/collections?namespace=default")
			.then(setCollections)
			.catch(() => {
				setCollections([]);
			});
	}, []);

	const rows = useMemo<FlatPaperRow[]>(() => {
		const list: FlatPaperRow[] = [];
		for (const table of tables) {
			for (let index = 0; index < table.rows.length; index += 1) {
				const row = table.rows[index];
				const meta = (table.rowMeta ?? [])[index] ?? {};
				const titleCell = row[0] ?? { text: "" };
				const title = meta.title ? String(meta.title) : titleCell.text;
				const titleUrl = (typeof meta.url === "string" && meta.url) || titleCell.url;
				const paperId =
					(typeof meta.paper_id === "string" && meta.paper_id) || row[2]?.text || title;
				const doi =
					(typeof meta.doi === "string" && meta.doi) ||
					row.find((cell) => /^doi:/i.test(cell.text))?.text?.replace(/^doi:/i, "");
				const abstract =
					(typeof meta.abstract === "string" && meta.abstract) ||
					row.slice(1).find((cell) => cell.text.length > 120)?.text;
				const focus =
					(typeof meta.focus === "string" && meta.focus) ||
					(focusCol >= 0 ? row[focusCol]?.text : undefined) ||
					table.focus ||
					"未分类";
				const year = typeof meta.year === "string" ? meta.year : row[1]?.text?.split(/\s*\/\s*/)[0]?.trim();
				const venue =
					(typeof meta.venue === "string" && meta.venue) || row[1]?.text?.split(/\s*\/\s*/)[1]?.trim();
				list.push({
					key: `${table.focus}-${index}-${paperId}`,
					row,
					meta,
					paperId,
					title,
					titleUrl,
					doi,
					abstract,
					focus,
					authors: typeof meta.authors === "string" ? meta.authors : undefined,
					year,
					venue,
					citationCount: typeof meta.citationCount === "number" ? meta.citationCount : undefined,
					relevance: typeof meta.relevance === "string" ? meta.relevance : undefined,
					topic: typeof meta.topic === "string" ? meta.topic : undefined,
					ccf: typeof meta.ccf === "string" ? meta.ccf : (typeof meta.venueRank === "string" ? meta.venueRank : undefined),
					curated: meta.curated === "llm" ? "llm" : meta.curated === "search" ? "search" : undefined,
					relationship: meta.relationship === "reference" || meta.relationship === "citation" ? meta.relationship : undefined,
					savable:
						meta.curated !== "llm" &&
						typeof meta.paper_id === "string" &&
						typeof meta.search_run_id === "string",
				});
			}
		}
		return list;
	}, [tables, focusCol]);
	const savablePaperIds = useMemo(
		() => new Set(rows.filter((row) => row.savable).map((row) => row.paperId)),
		[rows],
	);
	useEffect(() => {
		setSelected((current) => new Set([...current].filter((paperId) => savablePaperIds.has(paperId))));
		setDetailPaper((current) =>
			current ? rows.find((row) => row.paperId === current.paperId) : undefined,
		);
		setSaveError("");
		setSaveMessage("");
	}, [rows, savablePaperIds]);

	const toggleSelect = (key: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const saveSelection = async () => {
		if (!selected.size || !activeDocument?.url) return;
		setSaving(true);
		setSaveError("");
		setSaveMessage("");
		try {
			const paperIds = [...selected];
			await api(
				"/api/library/import/save",
				jsonBody({
					sidebarResultUrl: activeDocument.url,
					paperIds,
					namespace: "default",
					collectionId: selectedCollection || undefined,
				}),
			);
			setSaveMessage(
				selectedCollection
					? `已提交保存任务：${selected.size} 篇论文将写入个人库并归入所选分类。`
					: `已提交保存任务：${selected.size} 篇论文将写入个人库（未分类）。`,
			);
			setSelected(new Set());
			setSelectedCollection("");
		} catch (reason) {
			setSaveError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="agent-result-sidebar">
			<header className="agent-result-head">
				<div className="agent-result-head-main">
					<strong>论文清单</strong>
					{documents.length > 1 ? (
						<select
							className="agent-result-switcher"
							aria-label="切换本会话论文清单"
							value={activeDocument?.url ?? ""}
							onChange={(event) => onSelect(event.target.value)}
						>
							{documents.map((document) => (
								<option key={document.id} value={document.url}>
									{document.sequence}. {document.query}
								</option>
							))}
						</select>
					) : (
						<span title={activeDocument?.query}>{activeDocument?.query ?? "本会话结果"}</span>
					)}
				</div>
				<div className="agent-result-head-actions">
					{activeRowCount !== undefined && <span className="agent-result-document-count">{activeRowCount} 篇</span>}
					{selected.size > 0 && <span className="agent-result-save-count">已选 {selected.size} 篇</span>}
					<button type="button" className="agent-result-close" aria-label="关闭结果侧边栏" onClick={onClose}>
						×
					</button>
				</div>
			</header>
			{loading ? (
				<div className="agent-result-empty">加载中…</div>
			) : error ? (
				<div className="agent-result-empty error-text">{error}</div>
			) : tables.length === 0 ? (
				<div className="agent-result-empty">这份论文清单没有可显示的表格。</div>
			) : (
				<>
					<div className="agent-result-body">
					<div className="agent-result-table-scroll">
						<table className="agent-result-table">
							<colgroup>
								<col className="agent-result-col-check" />
								<col className="agent-result-col-title" />
								<col className="agent-result-col-focus" />
								<col className="agent-result-col-relevance" />
								<col className="agent-result-col-topic" />
								<col className="agent-result-col-yearvenue" />
								<col className="agent-result-col-id" />
								<col className="agent-result-col-ccf" />
							</colgroup>
							<thead>
								<tr>
									<th className="agent-result-table-check" aria-label="选择">
										<input
											type="checkbox"
											checked={selected.size > 0 && selected.size === savablePaperIds.size}
											disabled={savablePaperIds.size === 0}
											onChange={() =>
												setSelected((current) =>
													current.size === savablePaperIds.size ? new Set() : new Set(savablePaperIds),
												)
											}
											title="全选"
											aria-label="全选"
										/>
									</th>
									<th key="title">标题</th>
									<th key="focus">focus</th>
									<th key="relevance">relevance</th>
									<th key="topic">主题</th>
									<th key="yearvenue">年份/venue</th>
									<th key="id">标识</th>
									<th key="ccf">CCF</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((paper) => {
									const isSelected = selected.has(paper.paperId);
									const isDetail = detailPaper?.key === paper.key;
									return (
										<tr
											className={`agent-result-table-row${isSelected ? " selected" : ""}${isDetail ? " detail" : ""}`}
											key={paper.key}
											tabIndex={0}
											onClick={() => setDetailPaper(paper)}
											onKeyDown={(event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													setDetailPaper(paper);
												}
											}}
										>
											<td className="agent-result-table-check">
												<input
													type="checkbox"
													checked={isSelected}
													disabled={!paper.savable}
													onChange={() => toggleSelect(paper.paperId)}
													onClick={(event) => event.stopPropagation()}
													title="保存到个人库"
													aria-label="保存到个人库"
												/>
											</td>
											<td className="agent-result-table-title">
												<span className="agent-result-title-text">{paper.title}</span>
												{paper.curated === "llm" && (
													<span className="agent-result-curated" title="模型凭领域知识补充的论文, 不在搜索结果中, 无法保存到个人库">
														模型补充
													</span>
												)}
												{paper.relationship && (
													<span
														className={`agent-result-rel ${paper.relationship}`}
														title={paper.relationship === "reference" ? "种子论文的引用文献" : "引用了种子论文的后续工作"}
													>
														{paper.relationship === "reference" ? "引用" : "被引"}
													</span>
												)}
												{paper.titleUrl && (
													<a
														className="agent-result-title-link"
														href={paper.titleUrl}
														target="_blank"
														rel="noreferrer"
														title="在新窗口打开论文页"
														onClick={(event) => event.stopPropagation()}
													>
														↗
													</a>
												)}
											</td>
											<td className="agent-result-table-cell agent-result-focus">{paper.focus}</td>
											<td className="agent-result-table-cell agent-result-relevance">{paper.relevance}</td>
											<td className="agent-result-table-cell agent-result-topic" title={paper.topic}>
												{paper.topic}
											</td>
											<td className="agent-result-table-cell">
												{renderCell(paper.row[1])}
											</td>
											<td className="agent-result-table-cell">
												{renderCell(paper.row[2])}
											</td>
											<td className="agent-result-table-cell">
												{paper.ccf && <span className="agent-result-ccf">{paper.ccf}</span>}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					{detailPaper && (
						<aside className="agent-result-detail">
							<header className="agent-result-detail-head">
								<strong>来源详情</strong>
								<button type="button" className="agent-result-close" aria-label="关闭详情" onClick={() => setDetailPaper(undefined)}>
									×
								</button>
							</header>
							<div className="agent-result-detail-body">
								<h3 className="agent-result-detail-title">
									{detailPaper.title}
									{detailPaper.curated === "llm" && (
										<span className="agent-result-curated">模型补充</span>
									)}
								</h3>
								{detailPaper.authors && <p className="agent-result-detail-authors">{detailPaper.authors}</p>}
								{detailPaper.venue && (
									<p className="agent-result-detail-meta">
										{detailPaper.year ? `${detailPaper.year} · ` : ""}
										{detailPaper.venue}
										{detailPaper.citationCount !== undefined ? ` · ${detailPaper.citationCount} 引用` : ""}
									</p>
								)}
								{(detailPaper.relevance || detailPaper.topic || detailPaper.ccf) && (
									<div className="agent-result-detail-badges">
										{detailPaper.ccf && <span className="agent-result-ccf">CCF {detailPaper.ccf}</span>}
										{detailPaper.topic && <span className="agent-result-badge topic">{detailPaper.topic}</span>}
									</div>
								)}
								{detailPaper.relevance && (
									<>
										<div className="agent-result-detail-label">切题度</div>
										<p className="agent-result-detail-relevance">{detailPaper.relevance}</p>
									</>
								)}
								<div className="agent-result-detail-actions">
									{detailPaper.doi && (
										<a className="agent-result-id" href={`https://doi.org/${encodeURIComponent(detailPaper.doi)}`} target="_blank" rel="noreferrer" title={detailPaper.doi}>
											DOI: {detailPaper.doi}
										</a>
									)}
									{detailPaper.titleUrl && (
										<a className="agent-result-id" href={detailPaper.titleUrl} target="_blank" rel="noreferrer">论文页 ↗</a>
									)}
								</div>
								<div className="agent-result-detail-label">摘要</div>
								{detailPaper.abstract ? (
									<p className="agent-result-detail-abstract">{detailPaper.abstract}</p>
								) : (
									<p className="agent-result-detail-abstract muted">暂无摘要（该来源未提供摘要，可点击论文页查看）。</p>
								)}
							</div>
						</aside>
					)}
					</div>
					<div className="agent-result-save-bar">
						{selected.size > 0 && (
							<div className="agent-result-save-row">
								<select
									className="agent-result-save-col"
									value={selectedCollection}
									onChange={(event) => setSelectedCollection(event.target.value)}
									title="保存到哪个分类"
								>
									<option value="">未分类</option>
									{collectionOptions.map(({ collection, path }) => (
										<option value={collection.id} key={collection.id}>
											{path.join(" / ")}
										</option>
									))}
								</select>
								<button className="button primary" type="button" disabled={saving} onClick={() => void saveSelection()}>
									{saving ? "提交中…" : "保存到分类"}
								</button>
							</div>
						)}
						{saveError && <span className="error-text">{saveError}</span>}
						{saveMessage && <span className="agent-result-save-ok">{saveMessage}</span>}
					</div>
				</>
		)}

		</div>
	);
}

function summaryFromSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSummary {
	const { messages: _messages, tools: _tools, uiRequests: _uiRequests, ...summary } = snapshot;
	return summary;
}

const RESULT_LINK_PATTERN = /\/api\/agent\/results\/[A-Za-z0-9._-]+\.md/g;

/** 把消息文本中的论文清单链接替换为 markdown 链接, 交给 ReactMarkdown 渲染成可点击按钮。 */
function linkifyResultLinks(text: string): string {
	return text.replace(RESULT_LINK_PATTERN, "[查看论文清单]($1)");
}

function AgentMarkdown({
	content,
	onOpenResult,
}: {
	content: string;
	onOpenResult: (url: string) => void;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ href, children }) => {
					if (href?.startsWith("/api/agent/results/")) {
						return (
							<button type="button" className="agent-result-link" onClick={() => onOpenResult(href)}>
								{children}
							</button>
						);
					}
					return (
						<a href={href} target="_blank" rel="noreferrer">
							{children}
						</a>
					);
				},
			}}
		>
			{linkifyResultLinks(content)}
		</ReactMarkdown>
	);
}

function DismissibleErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
	return (
		<div className="error-banner dismissible-error-banner" role="alert">
			<span>{message}</span>
			<button type="button" aria-label="关闭错误提示" title="关闭" onClick={onDismiss}>
				×
			</button>
		</div>
	);
}

function AgentResultCard({
	document,
	active,
	rowCount,
	onOpen,
}: {
	document: AgentResultDocument;
	active: boolean;
	rowCount?: number;
	onOpen: () => void;
}) {
	return (
		<button
			type="button"
			className={`agent-result-card${active ? " active" : ""}`}
			aria-pressed={active}
			onClick={onOpen}
		>
			<span className="agent-result-card-index">论文清单 {document.sequence}</span>
			<strong>{document.query}</strong>
			<span className="agent-result-card-meta">表格{rowCount !== undefined ? ` · ${rowCount} 篇` : ""}</span>
		</button>
	);
}

function ThinkingBlock({ thinking, streaming }: { thinking: string; streaming: boolean }) {
	const [open, setOpen] = useState(true);
	return (
		<details
			className="agent-thinking"
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary>{streaming ? "思考中…" : "思考过程"}</summary>
			<div className="agent-thinking-body">{thinking}</div>
		</details>
	);
}

function upsert<T extends { id: string }>(values: T[], value: T): T[] {
	const index = values.findIndex((entry) => entry.id === value.id);
	if (index < 0) return [...values, value];
	const next = [...values];
	next[index] = value;
	return next;
}

function timeLabel(value: string): string {
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function AgentUIRequestCard({
	request,
	disabled,
	onRespond,
}: {
	request: AgentUIRequestView;
	disabled: boolean;
	onRespond: (request: AgentUIRequestView, value: unknown) => Promise<void>;
}) {
	const [value, setValue] = useState(request.type === "select" ? (request.options?.[0] ?? "") : "");
	return (
		<article className="agent-ui-request">
			<div className="agent-ui-request-heading">
				<div>
					<span className="eyebrow">Human confirmation required</span>
					<h3>{request.title}</h3>
				</div>
				<small>到期 {new Date(request.expiresAt).toLocaleTimeString("zh-CN")}</small>
			</div>
			{request.message && <pre>{request.message}</pre>}
			{request.type === "select" && (
				<select value={value} onChange={(event) => setValue(event.target.value)}>
					{request.options?.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			)}
			{request.type === "input" && (
				<input
					value={value}
					onChange={(event) => setValue(event.target.value)}
					placeholder={request.placeholder || "请输入响应"}
				/>
			)}
			<div className="button-row">
				<button
					className="button secondary"
					type="button"
					disabled={disabled}
					onClick={() => void onRespond(request, request.type === "confirm" ? false : null)}
				>
					拒绝 / 取消
				</button>
				<button
					className="button primary"
					type="button"
					disabled={disabled || (request.type !== "confirm" && !value)}
					onClick={() => void onRespond(request, request.type === "confirm" ? true : value)}
				>
					{request.type === "confirm" ? "明确同意" : "提交响应"}
				</button>
			</div>
		</article>
	);
}

function AgentToolCard({ tool }: { tool: AgentToolView }) {
	return (
		<details className={`agent-tool-card ${tool.status}`} open={tool.status !== "succeeded"}>
			<summary>
				<span className="agent-tool-icon">⌘</span>
				<strong>{tool.name}</strong>
				<span>{tool.status === "running" ? "执行中" : tool.status === "succeeded" ? "已完成" : "失败"}</span>
				<small>{timeLabel(tool.startedAt)}</small>
			</summary>
				{tool.input && (
					<div>
						<span className="agent-tool-field-label">输入</span>
						<pre>{tool.input}</pre>
					</div>
				)}
				{tool.output && (
					<div>
						<span className="agent-tool-field-label">输出</span>
						<pre>{tool.output}</pre>
					</div>
			)}
		</details>
	);
}

function AgentToolGroup({ tools }: { tools: AgentToolView[] }) {
	const hasAttentionItem = tools.some((tool) => tool.status !== "succeeded");
	return (
		<details className="agent-message-tools" open={hasAttentionItem}>
			<summary>
				工具调用 {tools.length} 项
				{hasAttentionItem && <span>有任务仍在执行或失败</span>}
			</summary>
			<div className="agent-message-tool-list">
				{tools.map((tool) => <AgentToolCard key={tool.id} tool={tool} />)}
			</div>
		</details>
	);
}

export interface PaperAgentContext {
	paperId: string;
	namespace: string;
	title: string;
	pdfPath: string;
	pdfSha256?: string;
}

export function AgentPage({
	initialPrompt = "",
	onPromptConsumed,
	embedded = false,
	paperContext,
}: {
	initialPrompt?: string;
	onPromptConsumed?: () => void;
	embedded?: boolean;
	paperContext?: PaperAgentContext;
}) {
	const sessionListUrl = paperContext
		? `/api/agent/sessions?scope=paper&namespace=${encodeURIComponent(paperContext.namespace)}&paperId=${encodeURIComponent(paperContext.paperId)}`
		: "/api/agent/sessions";
	const [config, setConfig] = useState<AgentConfigView>();
	const [configuredKey, setConfiguredKey] = useState("");
	const [menuOpen, setMenuOpen] = useState<{ id: string; left: number; top: number } | null>(null);
	const sessionMenuCloseTimerRef = useRef<number | undefined>(undefined);
	useEffect(
		() => () => {
			if (sessionMenuCloseTimerRef.current) window.clearTimeout(sessionMenuCloseTimerRef.current);
		},
		[],
	);
	const cancelSessionMenuClose = () => {
		if (!sessionMenuCloseTimerRef.current) return;
		window.clearTimeout(sessionMenuCloseTimerRef.current);
		sessionMenuCloseTimerRef.current = undefined;
	};
	const scheduleSessionMenuClose = () => {
		cancelSessionMenuClose();
		sessionMenuCloseTimerRef.current = window.setTimeout(() => {
			setMenuOpen(null);
			sessionMenuCloseTimerRef.current = undefined;
		}, 160);
	};
	const [skillPaletteOpen, setSkillPaletteOpen] = useState(false);
	const [skillFilter, setSkillFilter] = useState("");
	const [loadedSkills, setLoadedSkills] = useState<
		Array<{ name: string; description: string; disableModelInvocation: boolean }>
	>([]);
	const [attachments, setAttachments] = useState<Array<{ path: string; name: string; size: number }>>([]);
	const [activeResultUrl, setActiveResultUrl] = useState<string>();
	const [resultRowCounts, setResultRowCounts] = useState<Record<string, number>>({});
	const [sidebarTables, setSidebarTables] = useState<ParsedLiteratureTable[]>([]);
	const [sidebarLoading, setSidebarLoading] = useState(false);
	const [sidebarError, setSidebarError] = useState("");
	const resultLoadIdRef = useRef(0);
	const [resultPanelOpen, setResultPanelOpen] = useState(false);
	const [resultPanelWidth, setResultPanelWidth] = useState(380);
	const resultResizeRef = useRef<{ x: number; width: number } | null>(null);
	const startResultResize = useCallback((event: React.MouseEvent) => {
		event.preventDefault();
		resultResizeRef.current = { x: event.clientX, width: resultPanelWidth };
		const onMove = (move: MouseEvent) => {
			if (!resultResizeRef.current) return;
			const delta = resultResizeRef.current.x - move.clientX;
			setResultPanelWidth(Math.max(280, Math.min(640, resultResizeRef.current.width + delta)));
		};
		const onUp = () => {
			resultResizeRef.current = null;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [resultPanelWidth]);
	const openSidebarDocument = useCallback(async (target: string) => {
		if (embedded) {
			window.open(target, "_blank", "noopener,noreferrer");
			return;
		}
		const requestId = ++resultLoadIdRef.current;
		setActiveResultUrl(target);
		setResultPanelOpen(true);
		setSidebarLoading(true);
		setSidebarError("");
		try {
			const text = await apiText(target);
			if (requestId !== resultLoadIdRef.current) return;
			const tables = parseLiteratureTables(text)?.tables ?? [];
			setSidebarTables(tables);
			setResultRowCounts((current) => ({
				...current,
				[target]: tables.reduce((total, table) => total + table.rows.length, 0),
			}));
		} catch (reason) {
			if (requestId !== resultLoadIdRef.current) return;
			setSidebarTables([]);
			setSidebarError(reason instanceof Error ? reason.message : "论文清单加载失败");
		} finally {
			if (requestId === resultLoadIdRef.current) setSidebarLoading(false);
		}
	}, [embedded]);

	/** 会话恢复后, 从已提交的工具调用里找回论文清单文档, 恢复右侧侧边栏。 */
	const restoreSidebarFromSession = useCallback(
		async (snapshot: AgentSessionSnapshot) => {
			resultLoadIdRef.current += 1;
			setActiveResultUrl(undefined);
			setResultRowCounts({});
			setSidebarTables([]);
			setSidebarError("");
			setSidebarLoading(false);
			setResultPanelOpen(false);
			const latest = embedded ? undefined : collectAgentResultDocuments(snapshot.messages, snapshot.tools).at(-1);
			if (latest) void openSidebarDocument(latest.url);
		}, [embedded, openSidebarDocument]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);

	const handleFiles = async (files: FileList | null) => {
		if (!files?.length || !active) return;
		setUploading(true);
		setError("");
		try {
			for (const file of Array.from(files)) {
				const data = await file.arrayBuffer();
				let response: Response;
				try {
					response = await fetch(`/api/agent/sessions/${encodeURIComponent(active.id)}/attachments`, {
					method: "POST",
					headers: {
						"content-type": "application/octet-stream",
						"x-filename": encodeURIComponent(file.name),
					},
						body: data,
					});
				} catch (reason) {
					throw friendlyNetworkError(reason);
				}
				if (!response.ok) {
					let message = `${response.status} ${response.statusText}`;
					try {
						const body = (await response.json()) as { error?: string };
						if (body.error) message = body.error;
					} catch {
						// ignore
					}
					throw new Error(message);
				}
				const attachment = (await response.json()) as { path: string; name: string; size: number };
				setAttachments((current) => [...current, attachment]);
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setUploading(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};
	useEffect(() => {
		void api<{ skills: typeof loadedSkills }>("/api/agent/skills")
			.then((value) => setLoadedSkills(value.skills))
			.catch(() => setLoadedSkills([]));
	}, []);
	const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
	const [active, setActive] = useState<AgentSessionSnapshot>();
	const resultDocuments = useMemo(
		() => collectAgentResultDocuments(active?.messages ?? [], active?.tools ?? []),
		[active?.messages, active?.tools],
	);
	const activeResultDocument =
		resultDocuments.find((document) => document.url === activeResultUrl) ?? resultDocuments.at(-1);
	const resultDocumentsByMessage = useMemo(() => {
		const grouped = new Map<string, AgentResultDocument[]>();
		for (const document of resultDocuments) {
			if (!document.anchorMessageId) continue;
			const current = grouped.get(document.anchorMessageId) ?? [];
			current.push(document);
			grouped.set(document.anchorMessageId, current);
		}
		return grouped;
	}, [resultDocuments]);
	const toolsByMessage = useMemo(() => {
		const grouped = new Map<string, AgentToolView[]>();
		const messages = active?.messages ?? [];
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		const messageIds = new Set(assistantMessages.map((message) => message.id));
		for (const tool of active?.tools ?? []) {
			const prior = assistantMessages
				.filter((message) => message.createdAt <= tool.startedAt)
				.at(-1);
			const messageId = tool.assistantMessageId && messageIds.has(tool.assistantMessageId)
				? tool.assistantMessageId
				: (prior ?? assistantMessages.at(-1))?.id;
			if (!messageId) continue;
			const current = grouped.get(messageId) ?? [];
			current.push(tool);
			grouped.set(messageId, current);
		}
		return grouped;
	}, [active?.messages, active?.tools]);
	const [newMode, _setNewMode] = useState<AgentMode>("persistent");
	const [newTitle, setNewTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState<AgentThinkingLevel>("low");
	const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("ask");
	const syncedSettingsSessionId = useRef<string | undefined>(undefined);
	// 切换会话时, 用会话自己的设置同步选择器; 平时的变更不回写, 避免打断用户操作。
	useEffect(() => {
		if (active?.id === syncedSettingsSessionId.current) return;
		syncedSettingsSessionId.current = active?.id;
		setThinkingLevel(active?.thinkingLevel ?? "low");
		setPermissionMode(active?.permissionMode ?? "ask");
	}, [active]);
	/** 会话存在时把 composer 设置持久化到服务端; 失败时返回 false 供调用方回滚。 */
	const applySessionSettings = useCallback(
		async (patch: { thinkingLevel?: AgentThinkingLevel; permissionMode?: AgentPermissionMode }) => {
			if (!active) return true;
			try {
				const snapshot = await api<AgentSessionSnapshot>(
					`/api/agent/sessions/${encodeURIComponent(active.id)}/settings`,
					jsonBody(patch),
				);
				setActive(snapshot);
				setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
				return true;
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
				return false;
			}
		},
		[active],
	);
	const changeThinkingLevel = async (level: AgentThinkingLevel) => {
		const previous = thinkingLevel;
		setThinkingLevel(level);
		if (!(await applySessionSettings({ thinkingLevel: level }))) setThinkingLevel(previous);
	};
	const changePermissionMode = async (mode: AgentPermissionMode) => {
		const previous = permissionMode;
		setPermissionMode(mode);
		if (!(await applySessionSettings({ permissionMode: mode }))) setPermissionMode(previous);
	};
	useEffect(() => {
		if (initialPrompt) {
			setPrompt(initialPrompt);
			onPromptConsumed?.();
		}
	}, [initialPrompt, onPromptConsumed]);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const modelNoticeTimer = useRef<number | undefined>(undefined);
	const [_streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
	const [sidebarOpen, setSidebarOpen] = useState(
		() => window.localStorage.getItem("paper-agent-sidebar-open") !== "closed",
	);

	const transcriptRef = useRef<HTMLDivElement>(null);
	const autoFollowTranscript = useRef(true);
	const [showLatestButton, setShowLatestButton] = useState(false);
	const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
		autoFollowTranscript.current = true;
		setShowLatestButton(false);
		const transcript = transcriptRef.current;
		if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior });
	}, []);
	const handleTranscriptScroll = useCallback(() => {
		const transcript = transcriptRef.current;
		if (!transcript) return;
		const nearBottom = isAgentTranscriptNearBottom(transcript);
		autoFollowTranscript.current = nearBottom;
		setShowLatestButton(!nearBottom);
	}, []);
	const handleTranscriptWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
		if (event.deltaY >= 0) return;
		autoFollowTranscript.current = false;
		setShowLatestButton(true);
	}, []);

	const applyConfig = useCallback((next: AgentConfigView) => {
		setConfig(next);
		const activeKey = `${next.providerId}/${next.modelId}`;
		setConfiguredKey(next.configuredModels.some((model) => model.key === activeKey) ? activeKey : "");
	}, []);
	const showModelNotice = useCallback((message: string) => {
		if (modelNoticeTimer.current !== undefined) window.clearTimeout(modelNoticeTimer.current);
		setNotice(message);
		modelNoticeTimer.current = window.setTimeout(() => {
			setNotice((current) => (current === message ? "" : current));
			modelNoticeTimer.current = undefined;
		}, 2_500);
	}, []);
	useEffect(
		() => () => {
			if (modelNoticeTimer.current !== undefined) window.clearTimeout(modelNoticeTimer.current);
		},
		[],
	);
	useEffect(() => {
		if (!error) return;
		const timer = window.setTimeout(() => setError(""), 6_000);
		return () => window.clearTimeout(timer);
	}, [error]);

	const applyConfigured = useCallback(async (key: string) => {
		if (!key || key === configuredKey) return;
		const previousKey = configuredKey;
		setConfiguredKey(key);
		setBusy(true);
		setError("");
		try {
			const next = await api<AgentConfigView>("/api/agent/config/apply", {
				method: "POST",
				body: JSON.stringify({ key }),
			});
			applyConfig(next);
			showModelNotice(`已切换模型：${key}`);
		} catch (reason) {
			setConfiguredKey(previousKey);
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}, [configuredKey, applyConfig, showModelNotice]);

	const refreshSessions = useCallback(async (preferredId?: string) => {
		const result = await api<{ sessions: AgentSessionSummary[] }>(sessionListUrl);
		setSessions(result.sessions);
		const nextId = preferredId && result.sessions.some((session) => session.id === preferredId)
			? preferredId
			: result.sessions[0]?.id;
		if (!nextId) {
			setActive(undefined);
			return;
		}
		const snapshot = await api<AgentSessionSnapshot>(`/api/agent/sessions/${encodeURIComponent(nextId)}`);
		setActive(snapshot);
		await restoreSidebarFromSession(snapshot);
	}, [restoreSidebarFromSession, sessionListUrl]);

	useEffect(() => {
		void (async () => {
			try {
				const [nextConfig, sessionResult] = await Promise.all([
					api<AgentConfigView>("/api/agent/config"),
					api<{ sessions: AgentSessionSummary[] }>(sessionListUrl),
				]);
				applyConfig(nextConfig);
				setSessions(sessionResult.sessions);
				const initialSession = sessionResult.sessions[0];
				if (initialSession) {
					const snapshot = await api<AgentSessionSnapshot>(
						`/api/agent/sessions/${encodeURIComponent(initialSession.id)}`,
					);
					setActive(snapshot);
					await restoreSidebarFromSession(snapshot);
				}
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setLoading(false);
			}
		})();
	}, [applyConfig, restoreSidebarFromSession, sessionListUrl]);

	const activeId = active?.id;
	const dismissSessionError = useCallback(async (sessionId: string) => {
		setActive((current) =>
			current?.id === sessionId
				? { ...current, error: undefined, status: current.status === "error" ? "idle" : current.status }
				: current,
		);
		setSessions((current) =>
			current.map((session) =>
				session.id === sessionId
					? { ...session, error: undefined, status: session.status === "error" ? "idle" : session.status }
					: session,
			),
		);
		try {
			const snapshot = await api<AgentSessionSnapshot>(
				`/api/agent/sessions/${encodeURIComponent(sessionId)}/dismiss-error`,
				{ method: "POST", body: "{}" },
			);
			setActive((current) => (current?.id === sessionId ? snapshot : current));
			setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, []);
	useEffect(() => {
		if (!activeId || !active?.error) return;
		const timer = window.setTimeout(() => void dismissSessionError(activeId), 8_000);
		return () => window.clearTimeout(timer);
	}, [activeId, active?.error, dismissSessionError]);
	useEffect(() => {
		if (!activeId) {
			setStreamState("idle");
			return;
		}
		const controller = new AbortController();
		const applyEvent = (event: AgentEvent) => {
			if (event.type === "deleted") {
				resultLoadIdRef.current += 1;
				setActive(undefined);
				setSessions((current) => current.filter((session) => session.id !== event.sessionId));
				setActiveResultUrl(undefined);
				setResultRowCounts({});
				setSidebarTables([]);
				setSidebarError("");
				setSidebarLoading(false);
				setResultPanelOpen(false);
				return;
			}
			if (event.type === "notice") {
				setNotice(event.message);
				return;
			}
			if (event.type === "session") {
				setSessions((current) => upsert(current, event.session));
				setActive((current) => (current?.id === event.sessionId ? { ...current, ...event.session } : current));
				return;
			}
			if (event.type === "message") {
				setActive((current) =>
					current?.id === event.sessionId ? { ...current, messages: upsert(current.messages, event.message) } : current,
				);
				return;
			}
			if (event.type === "message_delta") {
				setActive((current) =>
					current?.id === event.sessionId
						? {
								...current,
								messages: current.messages.map((message) =>
									message.id === event.messageId
										? { ...message, content: message.content + event.delta, status: "streaming" }
										: message,
								),
							}
						: current,
				);
				return;
			}
			if (event.type === "thinking_delta") {
				setActive((current) =>
					current?.id === event.sessionId
						? {
								...current,
								messages: current.messages.map((message) =>
									message.id === event.messageId
										? { ...message, thinking: (message.thinking ?? "") + event.delta, status: "streaming" }
										: message,
								),
							}
						: current,
				);
				return;
			}
			if (event.type === "tool") {
				setActive((current) =>
					current?.id === event.sessionId ? { ...current, tools: upsert(current.tools, event.tool) } : current,
				);
				if (
					(event.tool.name === "update_literature_sidebar" || event.tool.name === "edit_literature_sidebar") &&
					event.tool.status === "succeeded" &&
					event.tool.output
				) {
					const result = parseAgentResultOutput(event.tool.output);
					if (result.url) void openSidebarDocument(result.url);
				}
				return;
			}
			if (event.type === "ui_request") {
				setActive((current) =>
					current?.id === event.sessionId
						? { ...current, uiRequests: upsert(current.uiRequests, event.request) }
						: current,
				);
				return;
			}
			if (event.type === "ui_resolved") {
				setActive((current) =>
					current?.id === event.sessionId
						? { ...current, uiRequests: current.uiRequests.filter((request) => request.id !== event.requestId) }
						: current,
				);
			}
			};
			void (async () => {
				while (!controller.signal.aborted) {
				try {
						setStreamState("reconnecting");
					await apiEventStream(
						`/api/agent/sessions/${encodeURIComponent(activeId)}/events`,
						({ event, data }) => {
							if (event === "snapshot") {
								const snapshot = data as AgentSessionSnapshot;
									// 防御旧会话连接残留的 snapshot 覆盖当前会话
									if (snapshot.id && snapshot.id !== activeId) return;
									setActive(snapshot);
									setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
									setError("");
									setStreamState("connected");
									return;
							}
							applyEvent(data as AgentEvent);
						},
						controller.signal,
					);
					if (!controller.signal.aborted) setStreamState("reconnecting");
				} catch (reason) {
					if (controller.signal.aborted) break;
					setStreamState("reconnecting");
					void reason;
				}
				await new Promise<void>((resolve) => {
					const timer = window.setTimeout(resolve, 1_200);
					controller.signal.addEventListener(
						"abort",
						() => {
							window.clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
			}
		})();
		return () => controller.abort();
	}, [activeId, openSidebarDocument]);

	useEffect(() => {
		if (!active || !autoFollowTranscript.current) return;
		const frame = window.requestAnimationFrame(() => {
			if (autoFollowTranscript.current) scrollToLatest("auto");
		});
		return () => window.cancelAnimationFrame(frame);
	}, [active, scrollToLatest]);

	const createSession = async (manageBusy = true) => {
		if (manageBusy) setBusy(true);
		setError("");
		autoFollowTranscript.current = true;
		setShowLatestButton(false);
		try {
			const title = paperContext
				? `${`阅读：${paperContext.title}`}${sessions.length ? ` · 对话 ${sessions.length + 1}` : ""}`.slice(0, 120)
				: newTitle.trim();
			const snapshot = await api<AgentSessionSnapshot>("/api/agent/sessions", {
				method: "POST",
				body: JSON.stringify({
					mode: paperContext ? "persistent" : newMode,
					...(title ? { title } : {}),
					thinkingLevel,
					permissionMode,
					...(paperContext
						? { context: { kind: "paper", namespace: paperContext.namespace, paperId: paperContext.paperId } }
						: {}),
				}),
			});
			setNewTitle("");
			setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
			setActive(snapshot);
			await restoreSidebarFromSession(snapshot);
			return snapshot;
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			return undefined;
		} finally {
			if (manageBusy) setBusy(false);
		}
	};

	const selectSession = async (id: string) => {
		setError("");
		autoFollowTranscript.current = true;
		setShowLatestButton(false);
		try {
			const snapshot = await api<AgentSessionSnapshot>(`/api/agent/sessions/${encodeURIComponent(id)}`);
			setActive(snapshot);
			await restoreSidebarFromSession(snapshot);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const deleteSession = async (id: string) => {
		if (!window.confirm("删除这个论文会话？对话内容将无法恢复。")) return;
		setBusy(true);
		try {
			await api<{ ok: true }>(`/api/agent/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
			await refreshSessions(active?.id === id ? undefined : active?.id);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const renameSession = async (id: string) => {
		const current = orderedSessions.find((session) => session.id === id)?.title ?? "";
		const next = window.prompt("输入新的会话名称", current);
		if (next === null) return;
		const trimmed = next.trim();
		if (!trimmed || trimmed.length > 120) {
			setError("会话名称必须包含 1-120 个字符");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const snapshot = await api<AgentSessionSnapshot>(`/api/agent/sessions/${encodeURIComponent(id)}/rename`, {
				method: "POST",
				body: JSON.stringify({ title: trimmed }),
			});
			setSessions((currentList) => upsert(currentList, summaryFromSnapshot(snapshot)));
			if (active?.id === id) setActive(snapshot);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const send = async () => {
		if ((!active && !paperContext) || !prompt.trim()) return;
		setBusy(true);
		setError("");
		autoFollowTranscript.current = true;
		setShowLatestButton(false);
		try {
			const targetSession = active ?? (await createSession(false));
			if (!targetSession) return;
			const messageAttachments = [
				...attachments.map((attachment) => ({ path: attachment.path, name: attachment.name })),
				...(paperContext
					? [{ path: paperContext.pdfPath, name: `${paperContext.title}.pdf` }]
					: []),
			].filter((attachment, index, all) => all.findIndex((entry) => entry.path === attachment.path) === index);
			const snapshot = await api<AgentSessionSnapshot>(
				`/api/agent/sessions/${encodeURIComponent(targetSession.id)}/messages`,
				{
					method: "POST",
					body: JSON.stringify({
						message: prompt,
						attachments: messageAttachments,
					}),
				},
			);
			setPrompt("");
			setAttachments([]);
			setActive(snapshot);
			setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		if (!active) return;
		setBusy(true);
		try {
			const snapshot = await api<AgentSessionSnapshot>(
				`/api/agent/sessions/${encodeURIComponent(active.id)}/abort`,
				{ method: "POST", body: "{}" },
			);
			setActive(snapshot);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const respond = async (request: AgentUIRequestView, value: unknown) => {
		if (!active) return;
		setBusy(true);
		setError("");
		try {
			setActive(
				await api<AgentSessionSnapshot>(
					`/api/agent/sessions/${encodeURIComponent(active.id)}/ui/${encodeURIComponent(request.id)}/respond`,
					{ method: "POST", body: JSON.stringify({ value }) },
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const running = active?.status === "running" || active?.status === "stopping";
	const configurationReady = Boolean(config?.configured && config.credentialsAvailable);
	const orderedSessions = useMemo(
		() => [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
		[sessions],
	);

	if (loading) {
		return (
		<section className={embedded ? "agent-embedded-loading" : "panel"}>
			<h2>正在加载 Agent 对话…</h2>
		</section>
		);
	}

	return (
		<>
			{error && <DismissibleErrorBanner message={error} onDismiss={() => setError("")} />}
			{notice && <div className="success-banner">{notice}</div>}

			<div
				className={`agent-workspace${embedded ? " agent-workspace-embedded" : ""}`}
				style={
					embedded ? undefined : {
						gridTemplateColumns: sidebarOpen
							? resultPanelOpen
								? `250px minmax(0, 1fr) ${resultPanelWidth}px`
								: "250px minmax(0, 1fr)"
							: resultPanelOpen
								? `0px minmax(0, 1fr) ${resultPanelWidth}px`
								: "0px minmax(0, 1fr)",
					} as React.CSSProperties
				}
			>
				{!embedded && <aside className="panel agent-session-panel">
					<button
						className="agent-new-chat-button"
						type="button"
						onClick={() => {
							setNewTitle("");
							void createSession();
						}}
					>
						+ 开始新对话
					</button>
					<div className="agent-session-list">
						{orderedSessions.map((session) => (
							<article className={active?.id === session.id ? "active" : ""} key={session.id}>
								<button type="button" onClick={() => void selectSession(session.id)}>
									<strong>{session.title}</strong>
									<span>
										{session.mode} · {session.status} · {timeLabel(session.updatedAt)}
									</span>
									{session.pendingUIRequests > 0 && <em>{session.pendingUIRequests} 个确认待处理</em>}
								</button>
								<div className="agent-session-more-wrap">
									<button
										className="agent-session-more"
										type="button"
										aria-label={`更多操作 ${session.title}`}
										onMouseEnter={cancelSessionMenuClose}
										onMouseLeave={scheduleSessionMenuClose}
										onClick={(event) => {
											const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
											setMenuOpen(
												menuOpen?.id === session.id
													? null
													: { id: session.id, left: rect.right - 104, top: rect.bottom + 4 },
												);
										}}
									>
										⋯
									</button>
									{menuOpen?.id === session.id && (
										<div
											className="agent-session-menu"
											role="menu"
											onMouseEnter={cancelSessionMenuClose}
											onMouseLeave={scheduleSessionMenuClose}
											style={{ position: "fixed", left: menuOpen.left, top: menuOpen.top, zIndex: 999 }}
										>
											<button
												type="button"
												onClick={() => {
													setMenuOpen(null);
													void renameSession(session.id);
												}}
											>
												编辑
											</button>
											<button
												type="button"
												onClick={() => {
													setMenuOpen(null);
													void deleteSession(session.id);
												}}
											>
												删除
											</button>
										</div>
									)}
								</div>
							</article>
						))}
							{!orderedSessions.length && <p className="muted">新建一个会话后开始对话。</p>}
					</div>
					<div className="agent-template-list">
						<span className="agent-template-head">任务模板</span>
						{taskTemplates.map((template) => (
							<button key={template.title} type="button" onClick={() => setPrompt(template.prompt)}>
								<strong>{template.title}</strong>
							</button>
						))}
					</div>
				</aside>}

				<section className={`panel agent-chat-panel${embedded ? " agent-chat-panel-embedded" : ""}`}>
					<div className="agent-chat-column">
					<div className="agent-chat-heading">
						{!embedded && <button
							className="agent-sidebar-toggle"
							type="button"
							onClick={() => {
								setSidebarOpen((current) => {
									window.localStorage.setItem("paper-agent-sidebar-open", current ? "closed" : "open");
									return !current;
								});
							}}
							aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
							title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
						>
							<Menu size={16} />
						</button>}
						<h2 className="agent-chat-title">{embedded ? "论文助手" : (active?.title ?? "")}</h2>
						{embedded && paperContext && (
							<div className="paper-session-controls">
								<select
									aria-label="论文会话"
									value={active?.id ?? ""}
									onChange={(event) => {
										if (event.target.value) void selectSession(event.target.value);
										else setActive(undefined);
									}}
								>
									<option value="">新会话</option>
									{orderedSessions.map((session) => (
										<option key={session.id} value={session.id}>{session.title}</option>
									))}
								</select>
								<button
									type="button"
									disabled={busy || !active}
									onClick={() => {
										setActive(undefined);
										setAttachments([]);
									}}
								>
									新建
								</button>
								<button
									type="button"
									disabled={busy || !active}
									onClick={() => active && void deleteSession(active.id)}
								>
									删除
								</button>
							</div>
						)}
						{running && (
							<button className="agent-stop-button" type="button" disabled={busy} onClick={() => void stop()}>
								停止生成
							</button>
						)}
					</div>
					{embedded && paperContext && (
						<div className="paper-agent-context">
							<span>当前 PDF</span>
							<strong>{paperContext.title}</strong>
							{paperContext.pdfSha256 && <code>{paperContext.pdfSha256.slice(0, 10)}</code>}
						</div>
					)}

					{active?.error && (
						<DismissibleErrorBanner message={active.error} onDismiss={() => void dismissSessionError(active.id)} />
					)}
					{active?.uiRequests.map((request) => (
						<AgentUIRequestCard key={request.id} request={request} disabled={busy} onRespond={respond} />
					))}

					<div className="agent-transcript-shell">
					<div
						className="agent-transcript"
						ref={transcriptRef}
						onScroll={handleTranscriptScroll}
						onWheel={handleTranscriptWheel}
					>
						{active?.messages.map((message) => {
							const messageResults = resultDocumentsByMessage.get(message.id) ?? [];
							const messageTools = toolsByMessage.get(message.id) ?? [];
							return (
							<article className={`agent-message ${message.role} ${message.status}`} key={message.id}>
								<header>
									<strong>{message.role === "user" ? "你" : "Paper Agent"}</strong>
									<span>{timeLabel(message.createdAt)}</span>
								</header>
								<div className="agent-message-text">
									{message.content ? (
										message.role === "assistant" ? (
											<AgentMarkdown content={message.content} onOpenResult={(url) => void openSidebarDocument(url)} />
										) : (
											<span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
										)
									) : message.status === "streaming" ? (
										"正在思考并调用研究工具…"
									) : messageResults.length === 0 ? (
										"本轮主要执行了工具调用。"
									) : null}
								</div>
								{messageResults.length > 0 && (
									<div className="agent-result-card-list">
										{messageResults.map((document) => (
											<AgentResultCard
												key={document.id}
												document={document}
												active={activeResultDocument?.url === document.url && resultPanelOpen}
												rowCount={document.rowCount ?? resultRowCounts[document.url]}
												onOpen={() => void openSidebarDocument(document.url)}
											/>
										))}
									</div>
								)}

								{message.thinking ? (
									<ThinkingBlock thinking={message.thinking} streaming={message.status === "streaming"} />
								) : message.status === "streaming" ? (
									<div className="agent-thinking-streaming">正在思考…</div>
								) : null}
								{messageTools.length > 0 && <AgentToolGroup tools={messageTools} />}
								{message.error && <small className="error-text">{message.error}</small>}
							</article>
							);
						})}
						{!active && (
							<div className="agent-chat-empty">
								<Sparkles size={28} />
								<h3>{embedded ? "和 Paper Agent 一起阅读" : "在网页中使用完整的 Paper Agent 工具"}</h3>
								<p>{embedded ? "第一次提问时会创建这篇论文的持续会话，之后打开仍可继续讨论。" : "新建一个会话，然后从下面选一个任务开始，或直接描述你的论文调研目标。"}</p>
								{!embedded && <div className="agent-suggestion-grid">
									{taskTemplates.map((template) => (
										<button key={template.title} type="button" onClick={() => setPrompt(template.prompt)}>
											<strong>{template.title}</strong>
											<span>{template.prompt.slice(0, 56)}…</span>
										</button>
									))}
								</div>}
							</div>
						)}
						<div aria-hidden="true" />
					</div>
					{showLatestButton && (
						<button className="agent-scroll-latest" type="button" onClick={() => scrollToLatest()}>
							回到最新
						</button>
					)}
					</div>

					<div className="agent-composer">
						{embedded && (
							<div className="paper-agent-quick-prompts">
								{paperQuickPrompts.map((quickPrompt) => (
									<button type="button" key={quickPrompt} onClick={() => setPrompt(quickPrompt)}>
										{quickPrompt}
									</button>
								))}
							</div>
						)}
						{skillPaletteOpen && (
							<div className="agent-skill-palette">
								<div className="agent-skill-palette-head">技能（/skill: 名称）</div>
								{loadedSkills
									.filter((skill) => skill.name.includes(skillFilter) || skill.description.includes(skillFilter))
									.map((skill) => (
										<button
											key={skill.name}
											type="button"
											onClick={() => {
												setPrompt(`/skill:${skill.name} `);
												setSkillPaletteOpen(false);
											}}
										>
											{skill.name}
										</button>
									))}
							</div>
						)}
						<textarea
							value={prompt}
							onChange={(event) => {
								const value = event.target.value;
								setPrompt(value);
								if (value.startsWith("/skill:")) {
									setSkillPaletteOpen(false);
								} else if (value.startsWith("/")) {
									setSkillFilter(value.slice(1).toLowerCase());
									setSkillPaletteOpen(true);
								} else {
									setSkillPaletteOpen(false);
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									void send();
								}
							}}
							placeholder="描述任务，或输入 / 选择技能… Ctrl / Cmd + Enter 发送"
							rows={4}
							disabled={(!active && !paperContext) || running}
						/>
						{attachments.length > 0 && (
							<div className="agent-attachment-chips">
								{attachments.map((attachment) => (
									<span className="agent-attachment-chip" key={attachment.path}>
										{attachment.name}
										<button
											type="button"
											aria-label={`移除 ${attachment.name}`}
											onClick={() => setAttachments((current) => current.filter((entry) => entry.path !== attachment.path))}
										>
											×
										</button>
									</span>
								))}
							</div>
						)}
						<div className="agent-composer-actions">
							<div className="agent-composer-actions-left">
								<button
									className="agent-attach-button"
									type="button"
									title="上传附件（PDF / 文本 / 图片，最多 10 个）"
									disabled={!active || running || uploading}
									onClick={() => fileInputRef.current?.click()}
								>
									{uploading ? "上传中…" : "＋"}
								</button>
								<input
									ref={fileInputRef}
									type="file"
									multiple
									style={{ display: "none" }}
									onChange={(event) => void handleFiles(event.target.files)}
								/>
								<label className="agent-composer-pill" title="思考强度：控制模型推理深度">
									<Brain size={13} />
									<select
										className="agent-composer-pill-select"
										aria-label="思考强度"
										value={thinkingLevel}
										disabled={busy}
										onChange={(event) => void changeThinkingLevel(event.target.value as AgentThinkingLevel)}
									>
										{thinkingLevelOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<label
									className={`agent-composer-pill${permissionMode === "auto" ? " auto" : ""}`}
									title={permissionMode === "auto" ? "自动批准所有确认请求（写入、下载、团队提议等不再逐项询问）" : "写入、下载等敏感操作会先弹出确认卡片"}
								>
									<ShieldCheck size={13} />
									<select
										className="agent-composer-pill-select"
										aria-label="权限模式"
										value={permissionMode}
										disabled={busy}
										onChange={(event) => void changePermissionMode(event.target.value as AgentPermissionMode)}
									>
										{permissionModeOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<small className="agent-composer-hint">写入、下载、团队提议与配置变更会在上方出现人工确认卡片。</small>
							</div>
							<div className="agent-composer-actions-right">
								<select
									className="agent-model-switcher"
									aria-label="切换对话模型"
									title="切换对话模型"
									value={configuredKey}
									disabled={busy || running || !config?.configuredModels.length}
									onChange={(event) => void applyConfigured(event.target.value)}
								>
									{!configuredKey && <option value="">选择模型</option>}
									{[...new Set(config?.configuredModels.map((model) => model.providerId) ?? [])].map((providerId) => (
										<optgroup key={providerId} label={providerId}>
											{config?.configuredModels
												.filter((model) => model.providerId === providerId)
												.map((model) => (
													<option key={model.key} value={model.key} disabled={!model.credentialsAvailable}>
														{model.modelId}{model.credentialsAvailable ? "" : "（缺少密钥）"}
													</option>
												))}
										</optgroup>
									))}
								</select>
								<button
									className="button primary agent-send-button"
									type="button"
									disabled={(!active && !paperContext) || !prompt.trim() || running || busy || !configurationReady}
									onClick={() => void send()}
								>
									发送
								</button>
							</div>
						</div>
					</div>
					</div>
				</section>

				{!embedded && resultPanelOpen && (
					<aside className="panel agent-result-panel">
						<button
							type="button"
							className="agent-result-resizer"
							aria-label="调整论文清单宽度"
							onMouseDown={startResultResize}
						/>
						<AgentResultSidebar
							key={activeResultDocument?.id ?? "empty-result"}
							documents={resultDocuments}
							activeDocument={activeResultDocument}
							activeRowCount={
								activeResultDocument
									? resultRowCounts[activeResultDocument.url] ?? activeResultDocument.rowCount
									: undefined
							}
							tables={sidebarTables}
							loading={sidebarLoading}
							error={sidebarError}
							onSelect={(url) => void openSidebarDocument(url)}
							onClose={() => setResultPanelOpen(false)}
						/>
					</aside>
				)}
			</div>
		</>
	);
}
