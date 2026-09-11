import { BookOpen, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import { EmptyState, LoadingBlock } from "./components";
import type { WikiLintIssue, WikiPageSummary, WikiPage as WikiPageView, WikiTreeNode } from "./types";

interface WikiListResponse {
	namespace: string;
	pages: WikiPageSummary[];
	tree?: WikiTreeNode[];
	sync: { pageCount: number; issues: WikiLintIssue[]; indexedAt: string };
}

function collectFolderPaths(nodes: WikiTreeNode[]): string[] {
	return nodes.flatMap((node) =>
		node.kind === "folder" ? [node.path, ...collectFolderPaths(node.children ?? [])] : [],
	);
}

function WikiTreeBranch({
	nodes,
	selectedId,
	expanded,
	onToggle,
	onOpen,
}: {
	nodes: WikiTreeNode[];
	selectedId?: string;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onOpen: (id: string) => void;
}) {
	return (
		<div className="wiki-tree-branch">
			{nodes.map((node) => {
				if (node.kind === "folder") {
					const open = expanded.has(node.path);
					return (
						<div className="wiki-tree-node" key={node.path}>
							<button className="wiki-tree-row" type="button" aria-expanded={open} onClick={() => onToggle(node.path)}>
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
	const [issues, setIssues] = useState<WikiLintIssue[]>([]);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

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

	return (
		<div className="wiki-page">
			<header className="wiki-toolbar">
				<div>
					<span className="eyebrow">Research Wiki</span>
					<h1>知识库</h1>
				</div>
				<label className="wiki-namespace">
					<span>空间</span>
					<input value={namespace} onChange={(event) => setNamespace(event.target.value)} />
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
							/>
						</div>
					) : (
						<EmptyState title="知识库还是空的" text="在 Agent 对话中明确要求将研究结论沉淀到 Wiki。" />
					)}
				</aside>
				<main className="wiki-document-pane">
					{selected ? (
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
										.map((evidence) => `${evidence.id} ${evidence.kind}${evidence.locator.pdfPage ? ` p.${evidence.locator.pdfPage}` : ""}`)
										.join("、") || "无"}
								</p>
								{selected.page.claims.length > 0 && (
									<p>
										已识别 Claim：
										{selected.page.claims.map((claim) => `${claim.id} ${claim.evidenceIds.join("/")}`).join("、")}
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
					{issues.map((issue, index) => (
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
