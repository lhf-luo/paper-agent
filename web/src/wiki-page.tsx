import {
	AlertTriangle,
	BookOpen,
	ChevronDown,
	ChevronRight,
	FileText,
	Folder,
	FolderOpen,
	RefreshCw,
	Search,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation, EmptyState, LoadingBlock } from "./components";
import type {
	ConfirmationGrant,
	PreparedOperation,
	WikiLintIssue,
	WikiManagementFile,
	WikiPageSummary,
	WikiPage as WikiPageView,
	WikiSourcePageDeletionPreview,
	WikiTreeNode,
} from "./types";

interface WikiListResponse {
	namespace: string;
	pages: WikiPageSummary[];
	tree?: WikiTreeNode[];
	sync: { pageCount: number; issues: WikiLintIssue[]; indexedAt: string };
}

interface PreparedWikiSourcePageDeletion {
	status: "ready" | "blocked" | "no-op";
	preview: WikiSourcePageDeletionPreview;
	operation?: PreparedOperation;
}

interface WikiCleanupState {
	paperId: string;
	includeMixedPageIds: Set<string>;
	prepared: PreparedWikiSourcePageDeletion;
	dirty: boolean;
}

function collectFolderPaths(nodes: WikiTreeNode[]): string[] {
	return nodes.flatMap((node) =>
		node.kind === "folder" ? [node.path, ...collectFolderPaths(node.children ?? [])] : [],
	);
}

function WikiTreeBranch({
	nodes,
	selectedId,
	selectedManagementPath,
	expanded,
	onToggle,
	onOpen,
	onOpenManagement,
}: {
	nodes: WikiTreeNode[];
	selectedId?: string;
	selectedManagementPath?: string;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onOpen: (id: string) => void;
	onOpenManagement: (path: string) => void;
}) {
	return (
		<div className="wiki-tree-branch">
			{nodes.map((node) => {
				if (node.kind === "folder") {
					const open = expanded.has(node.path);
					return (
						<div className="wiki-tree-node" key={node.path}>
							<button
								className="wiki-tree-row"
								type="button"
								aria-expanded={open}
								onClick={() => onToggle(node.path)}
							>
								{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								{open ? <FolderOpen size={15} /> : <Folder size={15} />}
								<span>{node.name}</span>
							</button>
							{open && node.children?.length ? (
								<WikiTreeBranch
									nodes={node.children}
									selectedId={selectedId}
									expanded={expanded}
									onToggle={onToggle}
									onOpen={onOpen}
									onOpenManagement={onOpenManagement}
									selectedManagementPath={selectedManagementPath}
								/>
							) : null}
						</div>
					);
				}
				if (node.kind === "page" && node.id) {
					return (
						<button
							className={`wiki-tree-row page${selectedId === node.id ? " active" : ""}`}
							key={node.path}
							type="button"
							title={node.title ?? node.name}
							onClick={() => onOpen(node.id!)}
						>
							<FileText size={14} />
							<span>{node.title ?? node.name}</span>
						</button>
					);
				}
				if (node.kind === "management") {
					return (
						<button
							className={`wiki-tree-row management${selectedManagementPath === node.path ? " active" : ""}`}
							key={node.path}
							type="button"
							onClick={() => onOpenManagement(node.path)}
						>
							<FileText size={14} />
							<span>{node.name}</span>
						</button>
					);
				}
				return (
					<div className="wiki-tree-row file" key={node.path}>
						<FileText size={14} />
						<span>{node.name}</span>
					</div>
				);
			})}
		</div>
	);
}

export function WikiPage({ defaultNamespace }: { defaultNamespace: string }) {
	const [namespace, setNamespace] = useState(defaultNamespace);
	const [query, setQuery] = useState("");
	const [pages, setPages] = useState<WikiPageSummary[]>([]);
	const [tree, setTree] = useState<WikiTreeNode[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<{ page: WikiPageView; backlinks: Array<{ id: string; title: string }> }>();
	const [selectedManagement, setSelectedManagement] = useState<WikiManagementFile>();
	const [issues, setIssues] = useState<WikiLintIssue[]>([]);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [cleanup, setCleanup] = useState<WikiCleanupState>();
	const [cleanupLoading, setCleanupLoading] = useState(false);
	const [cleanupBusy, setCleanupBusy] = useState(false);

	const missingPaperSources = useMemo(() => {
		const grouped = new Map<string, { paperId: string; issueCount: number; pageIds: Set<string> }>();
		for (const issue of issues) {
			if (issue.code !== "missing-source" || issue.sourceKind !== "paper" || !issue.sourceId) continue;
			const current = grouped.get(issue.sourceId) ?? {
				paperId: issue.sourceId,
				issueCount: 0,
				pageIds: new Set<string>(),
			};
			current.issueCount += 1;
			if (issue.pageId) current.pageIds.add(issue.pageId);
			grouped.set(issue.sourceId, current);
		}
		return [...grouped.values()].sort((left, right) => left.paperId.localeCompare(right.paperId));
	}, [issues]);
	const groupedMissingPaperIds = useMemo(
		() => new Set(missingPaperSources.map((item) => item.paperId)),
		[missingPaperSources],
	);
	const remainingIssues = useMemo(
		() =>
			issues.filter(
				(issue) =>
					issue.code !== "missing-source" ||
					issue.sourceKind !== "paper" ||
					!issue.sourceId ||
					!groupedMissingPaperIds.has(issue.sourceId),
			),
		[issues, groupedMissingPaperIds],
	);

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const result = await api<WikiListResponse>(
				`/api/wiki/pages?namespace=${encodeURIComponent(namespace)}&query=${encodeURIComponent(query)}`,
			);
			setPages(result.pages);
			setTree(result.tree ?? []);
			setExpanded((current) => {
				const next = new Set(current);
				for (const path of collectFolderPaths(result.tree ?? [])) {
					if (!current.size) next.add(path);
				}
				return next;
			});
			setIssues(result.sync.issues);
			if (selected && !result.pages.some((page) => page.id === selected.page.id)) setSelected(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [namespace, query, selected]);

	useEffect(() => {
		void load();
	}, [load]);

	const openPage = async (id: string) => {
		setError("");
		try {
			setSelected(await api(`/api/wiki/pages/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`));
			setSelectedManagement(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const openManagementFile = async (path: string) => {
		setError("");
		try {
			const result = await api<{ namespace: string; file: WikiManagementFile }>(
				`/api/wiki/management-file?namespace=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
			);
			setSelectedManagement(result.file);
			setSelected(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const openExternal = async (action: "folder" | "obsidian") => {
		setError("");
		try {
			await api("/api/wiki/open", jsonBody({ action, namespace }));
			if (action === "folder") {
				setMessage("已打开知识库文件夹。");
				window.setTimeout(() => setMessage(""), 4_000);
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const prepareCleanup = async (paperId: string, includeMixedPageIds: string[] = []) => {
		setCleanupLoading(true);
		setError("");
		try {
			const prepared = await api<PreparedWikiSourcePageDeletion>(
				"/api/wiki/source-pages/delete/prepare",
				jsonBody({ namespace, paperId, includeMixedPageIds }),
			);
			setCleanup({ paperId, includeMixedPageIds: new Set(includeMixedPageIds), prepared, dirty: false });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setCleanupLoading(false);
		}
	};

	const toggleMixedPage = (pageId: string) => {
		setCleanup((current) => {
			if (!current) return current;
			const includeMixedPageIds = new Set(current.includeMixedPageIds);
			if (includeMixedPageIds.has(pageId)) includeMixedPageIds.delete(pageId);
			else includeMixedPageIds.add(pageId);
			return { ...current, includeMixedPageIds, dirty: true };
		});
	};

	const executeCleanup = async () => {
		if (!cleanup?.prepared.operation || cleanup.dirty) return;
		setCleanupBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(cleanup.prepared.operation)) as ConfirmationGrant;
			const result = await api<{ deletedPages: Array<{ id: string; title: string }>; deletedEvidenceCount: number }>(
				"/api/wiki/source-pages/delete/execute",
				jsonBody({
					namespace,
					paperId: cleanup.paperId,
					includeMixedPageIds: [...cleanup.includeMixedPageIds],
					previewFingerprint: cleanup.prepared.preview.fingerprint,
					grant,
				}),
			);
			setCleanup(undefined);
			setMessage(`已删除 ${result.deletedPages.length} 个 Wiki 页面和 ${result.deletedEvidenceCount} 条来源证据。`);
			window.setTimeout(() => setMessage(""), 5_000);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setCleanupBusy(false);
		}
	};

	return (
		<div className="wiki-page">
			{cleanup && (
				<AccessibleModal
					title="清理失效论文来源"
					description={`论文 ${cleanup.paperId} 已不在个人库中。请选择是否连同混合来源页面一起删除。`}
					onClose={() => {
						if (!cleanupBusy && !cleanupLoading) setCleanup(undefined);
					}}
					maxWidth={720}
				>
					<div className="wiki-cleanup-preview">
						<div className="wiki-cleanup-summary">
							<span>{cleanup.prepared.preview.deletablePages.length} 个完全依赖该论文的页面</span>
							<span>{cleanup.prepared.preview.mixedPages.length} 个混合来源页面</span>
							<span>{cleanup.prepared.preview.externalBacklinks.length} 个外部反向链接</span>
						</div>
						{cleanup.prepared.preview.deletablePages.length > 0 && (
							<section>
								<h4>将删除的页面</h4>
								<ul>
									{cleanup.prepared.preview.deletablePages.map((page) => (
										<li key={page.id}>
											<strong>{page.title}</strong>
											<small>{page.relativePath}</small>
										</li>
									))}
								</ul>
							</section>
						)}
						{cleanup.prepared.preview.mixedPages.length > 0 && (
							<section>
								<h4>混合来源页面</h4>
								<p>这些页面还有其他来源，默认保留。只有明确勾选后才会删除整个页面。</p>
								<div className="wiki-cleanup-mixed-list">
									{cleanup.prepared.preview.mixedPages.map((page) => (
										<label key={page.id}>
											<input
												type="checkbox"
												checked={cleanup.includeMixedPageIds.has(page.id)}
												onChange={() => toggleMixedPage(page.id)}
											/>
											<span>
												<strong>{page.title}</strong>
												<small>其他来源：{page.otherSources.join("、")}</small>
											</span>
										</label>
									))}
								</div>
							</section>
						)}
						{cleanup.prepared.preview.externalBacklinks.length > 0 && (
							<section className="wiki-cleanup-blocked" role="alert">
								<AlertTriangle size={18} style={{ color: "var(--accent-amber-text)" }} />
								<div>
									<strong>暂时无法删除</strong>
									<p>下列保留页面仍链接到待删除页面。需先保留相关目标，或处理这些反向链接。</p>
									<ul>
										{cleanup.prepared.preview.externalBacklinks.map((page) => (
											<li key={page.pageId}>{page.title}</li>
										))}
									</ul>
								</div>
							</section>
						)}
						{cleanup.dirty ? (
							<div className="wiki-cleanup-actions">
								<p>混合页面选择已变化，请重新生成精确删除预览。</p>
								<button
									className="button secondary"
									type="button"
									disabled={cleanupLoading}
									onClick={() => void prepareCleanup(cleanup.paperId, [...cleanup.includeMixedPageIds])}
								>
									<RefreshCw size={15} /> {cleanupLoading ? "正在检查…" : "更新删除预览"}
								</button>
							</div>
						) : cleanup.prepared.operation ? (
							<ConsentCard
								operation={cleanup.prepared.operation}
								busy={cleanupBusy}
								onCancel={() => setCleanup(undefined)}
								onConfirm={executeCleanup}
							/>
						) : (
							<div className="wiki-cleanup-actions">
								<p>
									{cleanup.prepared.status === "no-op"
										? "没有可删除的关联页面。"
										: "当前预览被反向链接阻止，未生成删除操作。"}
								</p>
								<button className="button secondary" type="button" onClick={() => setCleanup(undefined)}>
									关闭
								</button>
							</div>
						)}
					</div>
				</AccessibleModal>
			)}
			<header className="wiki-toolbar">
				<div>
					<span className="eyebrow">Research Wiki</span>
					<h1>知识库</h1>
				</div>
				<label className="wiki-namespace">
					<span>空间</span>
					<input
						value={namespace}
						onChange={(event) => {
							setNamespace(event.target.value);
							setSelected(undefined);
							setSelectedManagement(undefined);
						}}
					/>
				</label>
				<button className="button secondary" type="button" onClick={() => void load()}>
					<RefreshCw size={15} /> 同步
				</button>
				<button className="button secondary" type="button" onClick={() => void openExternal("folder")}>
					<FolderOpen size={15} /> 文件夹
				</button>
				<button className="button primary" type="button" onClick={() => void openExternal("obsidian")}>
					<BookOpen size={15} /> Obsidian
				</button>
			</header>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			<div className="wiki-workspace">
				<aside className="wiki-list-pane">
					<label className="wiki-search">
						<Search size={15} />
						<input value={query} placeholder="搜索知识页面" onChange={(event) => setQuery(event.target.value)} />
					</label>
					{loading ? (
						<LoadingBlock />
					) : query ? (
						pages.length ? (
							<div className="wiki-page-list">
								{pages.map((page) => (
									<button
										className={selected?.page.id === page.id ? "active" : ""}
										key={page.id}
										type="button"
										onClick={() => void openPage(page.id)}
									>
										<strong>{page.title}</strong>
										<span>
											{page.type} · {page.status}
										</span>
									</button>
								))}
							</div>
						) : (
							<EmptyState title="没有匹配的知识页面" text="尝试使用标题、别名或论文来源搜索。" />
						)
					) : tree.length ? (
						<div className="wiki-tree">
							<WikiTreeBranch
								nodes={tree}
								selectedId={selected?.page.id}
								selectedManagementPath={selectedManagement?.path}
								expanded={expanded}
								onToggle={(path) =>
									setExpanded((current) => {
										const next = new Set(current);
										if (next.has(path)) next.delete(path);
										else next.add(path);
										return next;
									})
								}
								onOpen={(id) => void openPage(id)}
								onOpenManagement={(path) => void openManagementFile(path)}
							/>
						</div>
					) : (
						<EmptyState title="知识库还是空的" text="在 Agent 对话中明确要求将研究结论沉淀到 Wiki。" />
					)}
				</aside>
				<main className="wiki-document-pane">
					{selectedManagement ? (
						<article className="wiki-document">
							<header>
								<div className="wiki-status-row">
									<span>管理文件</span>
									<span>只读</span>
								</div>
								<h2>{selectedManagement.name}</h2>
								<p>{selectedManagement.path}</p>
							</header>
							<div className="markdown-body">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedManagement.markdown}</ReactMarkdown>
							</div>
							<footer className="wiki-sources">
								<p>该文件由系统维护，用于导航或记录变更，不是可引用的知识页面。</p>
							</footer>
						</article>
					) : selected ? (
						<article className="wiki-document">
							<header>
								<div className="wiki-status-row">
									<span>{selected.page.type}</span>
									<span>{selected.page.status}</span>
								</div>
								<h2>{selected.page.title}</h2>
								<p>{selected.page.relativePath}</p>
							</header>
							<div className="markdown-body">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.page.markdown}</ReactMarkdown>
							</div>
							<footer className="wiki-sources">
								<strong>来源</strong>
								<p>论文：{selected.page.paperIds.join("、") || "无"}</p>
								<p>调研笔记：{selected.page.sourceNoteIds.join("、") || "无"}</p>
								<p>
									声明级证据：
									{selected.page.evidence
										.map(
											(evidence) =>
												`${evidence.id} ${evidence.kind}${evidence.locator.pdfPage ? ` p.${evidence.locator.pdfPage}` : ""}`,
										)
										.join("、") || "无"}
								</p>
								{selected.page.claims.length > 0 && (
									<p>
										已识别 Claim：
										{selected.page.claims
											.map((claim) => `${claim.id} ${claim.evidenceIds.join("/")}`)
											.join("、")}
									</p>
								)}
								<p>反向链接：{selected.backlinks.map((page) => page.title).join("、") || "无"}</p>
							</footer>
						</article>
					) : (
						<EmptyState title="选择一个知识页面" text="页面正文来自 Markdown，SQLite 仅维护可重建索引。" />
					)}
				</main>
				<aside className="wiki-lint-pane">
					<h2>检查结果</h2>
					<p>{issues.length ? `${issues.length} 个问题` : "结构与来源正常"}</p>
					{missingPaperSources.length > 0 && (
						<section className="wiki-missing-source-groups" aria-label="可清理的失效论文来源">
							{missingPaperSources.map((source) => (
								<div className="wiki-missing-source-card" key={source.paperId}>
									<div>
										<strong>个人库论文已删除</strong>
										<code title={source.paperId}>{source.paperId}</code>
										<span>
											影响 {source.pageIds.size} 个页面、{source.issueCount} 条证据
										</span>
									</div>
									<button
										className="button danger compact"
										type="button"
										disabled={cleanupLoading}
										onClick={() => void prepareCleanup(source.paperId)}
									>
										<Trash2 size={14} /> {cleanupLoading ? "检查中…" : "清理关联页面"}
									</button>
								</div>
							))}
						</section>
					)}
					{remainingIssues.map((issue, index) => (
						<div className={`wiki-issue ${issue.severity}`} key={`${issue.path}-${issue.code}-${index}`}>
							<strong>
								{issue.code} · {issue.path}
							</strong>
							<span>{issue.message}</span>
						</div>
					))}
				</aside>
			</div>
		</div>
	);
}
