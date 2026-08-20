import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, apiEventStream, apiText } from "./api";
import type { ParsedLiteratureTable } from "./literature-markdown";
import { parseLiteratureTables } from "./literature-markdown";
import type {
	AgentConfigView,
	AgentEvent,
	AgentMode,
	AgentSessionSnapshot,
	AgentSessionSummary,
	AgentToolView,
	AgentUIRequestView,
} from "./types";

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
		prompt: "为这篇论文生成略读卡：请替换为 PDF 路径或论文 ID。按 skim-card 技能的五问法（解决什么问题 / 现有方法为何不够 / 核心机制 / 哪个实验最直接支持 / 留下什么边界）回答，输出「问题 | research gap | 核心创新 | 关键证据 | 主要局限 | 精读/保留/排除」格式，并给出处置建议。gap 与创新点必须回到原文确认，标注证据位置；读完按规范写入 research 略读卡记录。",
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

function AgentResultSidebar({
	tables,
	loading,
	onClose,
}: {
	tables: ParsedLiteratureTable[];
	loading: boolean;
	onClose: () => void;
}) {
	return (
		<div className="agent-result-sidebar">
			<header className="agent-result-head">
				<strong>论文清单</strong>
				<button type="button" className="agent-result-close" aria-label="关闭结果侧边栏" onClick={onClose}>
					×
				</button>
			</header>
			{loading ? (
				<div className="agent-result-empty">加载中…</div>
			) : tables.length === 0 ? (
				<div className="agent-result-empty">
					点击对话中的「📄 查看论文清单」链接，在此显示 Agent 生成的论文清单文档。
				</div>
			) : (
				<div className="agent-result-groups">
					{tables.map((table) => (
						<section className="agent-result-group" key={table.focus}>
							<header className="agent-result-focus">
								<span className="focus-badge">focus</span>
								<strong>{table.focus || "未分类"}</strong>
								<span className="agent-result-count">{table.rows.length}</span>
							</header>
							<div className="agent-result-table-scroll">
								<table className="agent-result-table">
									<thead>
										<tr>
											{table.headers.map((header) => (
												<th key={header}>{header}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{table.rows.map((row) => (
											<tr key={row[0]?.text ?? ""}>
												{row.map((cell, index) => (
													<td key={`${cell.text}-${index}`}>
														{index === 0 && cell.url ? (
															<a className="agent-result-table-title" href={cell.url} target="_blank" rel="noreferrer">
																{cell.text}
															</a>
														) : (
															<span>{cell.text}</span>
														)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</section>
					))}
				</div>
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
	return text.replace(RESULT_LINK_PATTERN, "[📄 查看论文清单]($1)");
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

function _credentialLabel(config?: AgentConfigView): string {
	if (!config?.credentialsAvailable) return "未提供凭据";
	switch (config.credentialSource) {
		case "memory":
			return "服务进程内存";
		case "config":
			return "config.json 明文";
		default:
			return "环境变量";
	}
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
		<details className={`agent-tool-card ${tool.status}`} open={tool.status === "running"}>
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

export function AgentPage({
	initialPrompt = "",
	onPromptConsumed,
}: {
	initialPrompt?: string;
	onPromptConsumed?: () => void;
}) {
	const [config, setConfig] = useState<AgentConfigView>();
	const [configuredKey, _setConfiguredKey] = useState("");
	const [menuOpen, setMenuOpen] = useState<{ id: string; left: number; top: number } | null>(null);
	const [skillPaletteOpen, setSkillPaletteOpen] = useState(false);
	const [skillFilter, setSkillFilter] = useState("");
	const [loadedSkills, setLoadedSkills] = useState<
		Array<{ name: string; description: string; disableModelInvocation: boolean }>
	>([]);
	const [attachments, setAttachments] = useState<Array<{ path: string; name: string; size: number }>>([]);
	const [sidebarDocUrl, setSidebarDocUrl] = useState<string | undefined>();
	const [sidebarTables, setSidebarTables] = useState<ParsedLiteratureTable[]>([]);
	const [sidebarLoading, setSidebarLoading] = useState(false);
	const [resultPanelOpen, setResultPanelOpen] = useState(false);
	const [sidebarAvailable, setSidebarAvailable] = useState(false);

	const openSidebarDocument = useCallback(async (url?: string) => {
		const target = url ?? sidebarDocUrl;
		if (!target) return;
		setResultPanelOpen(true);
		setSidebarLoading(true);
		try {
			const text = await apiText(target);
			setSidebarTables(parseLiteratureTables(text)?.tables ?? []);
		} catch {
			setSidebarTables([]);
		} finally {
			setSidebarLoading(false);
		}
	}, [sidebarDocUrl]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);

	const handleFiles = async (files: FileList | null) => {
		if (!files?.length || !active) return;
		setUploading(true);
		setError("");
		try {
			for (const file of Array.from(files)) {
				const data = await file.arrayBuffer();
				const response = await fetch(`/api/agent/sessions/${encodeURIComponent(active.id)}/attachments`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${sessionStorage.getItem("paper-agent-session-token") ?? ""}`,
						"content-type": "application/octet-stream",
						"x-filename": encodeURIComponent(file.name),
					},
					body: data,
				});
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
	const [newMode, _setNewMode] = useState<AgentMode>("persistent");
	const [newTitle, setNewTitle] = useState("");
	const [prompt, setPrompt] = useState("");
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
	const [_streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
	const [sidebarOpen, setSidebarOpen] = useState(
		() => window.localStorage.getItem("paper-agent-sidebar-open") !== "closed",
	);
	const transcriptEnd = useRef<HTMLDivElement>(null);

	const applyConfig = useCallback((next: AgentConfigView) => {
		setConfig(next);
	}, []);

	const _applyConfigured = useCallback(async () => {
		if (!configuredKey) return;
		setBusy(true);
		setError("");
		try {
			const next = await api<AgentConfigView>("/api/agent/config/apply", {
				method: "POST",
				body: JSON.stringify({ key: configuredKey }),
			});
			applyConfig(next);
			setNotice("已切换到 config.json 中配置的模型。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}, [configuredKey, applyConfig]);

	const refreshSessions = useCallback(async (preferredId?: string) => {
		const result = await api<{ sessions: AgentSessionSummary[] }>("/api/agent/sessions");
		setSessions(result.sessions);
		const nextId = preferredId && result.sessions.some((session) => session.id === preferredId)
			? preferredId
			: result.sessions[0]?.id;
		if (!nextId) {
			setActive(undefined);
			return;
		}
		setActive(await api<AgentSessionSnapshot>(`/api/agent/sessions/${encodeURIComponent(nextId)}`));
	}, []);

	useEffect(() => {
		void (async () => {
			try {
				const [nextConfig, sessionResult] = await Promise.all([
					api<AgentConfigView>("/api/agent/config"),
					api<{ sessions: AgentSessionSummary[] }>("/api/agent/sessions"),
				]);
				applyConfig(nextConfig);
				setSessions(sessionResult.sessions);
				if (sessionResult.sessions[0]) {
					setActive(
						await api<AgentSessionSnapshot>(
							`/api/agent/sessions/${encodeURIComponent(sessionResult.sessions[0].id)}`,
						),
					);
				}
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setLoading(false);
			}
		})();
	}, [applyConfig]);

	const activeId = active?.id;
	useEffect(() => {
		if (!activeId) {
			setStreamState("idle");
			return;
		}
		const controller = new AbortController();
		const applyEvent = (event: AgentEvent) => {
			if (event.type === "deleted") {
				setActive(undefined);
				setSessions((current) => current.filter((session) => session.id !== event.sessionId));
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
				if (event.tool.name === "update_literature_sidebar" && event.tool.status === "succeeded" && event.tool.output) {
					try {
						const output = JSON.parse(event.tool.output) as { details?: { mdUrl?: string } };
						if (output.details?.mdUrl) {
							setSidebarDocUrl(output.details.mdUrl);
							setSidebarAvailable(true);
							void openSidebarDocument(output.details.mdUrl);
						}
					} catch {
						// 忽略不可解析的工具输出
					}
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
									setActive(snapshot);
									setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
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
					setError(reason instanceof Error ? reason.message : String(reason));
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
			if (!active) return;
			transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
		}, [active]);

	const createSession = async () => {
		setBusy(true);
		setError("");
		try {
			const snapshot = await api<AgentSessionSnapshot>("/api/agent/sessions", {
				method: "POST",
				body: JSON.stringify({ mode: newMode, ...(newTitle.trim() ? { title: newTitle.trim() } : {}) }),
			});
			setNewTitle("");
			setSessions((current) => upsert(current, summaryFromSnapshot(snapshot)));
			setActive(snapshot);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const selectSession = async (id: string) => {
		setError("");
		try {
			setActive(await api<AgentSessionSnapshot>(`/api/agent/sessions/${encodeURIComponent(id)}`));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const deleteSession = async (id: string) => {
		if (!window.confirm("删除这个内存会话？对话上下文将无法恢复。")) return;
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
		if (!active || !prompt.trim()) return;
		setBusy(true);
		setError("");
		try {
			const snapshot = await api<AgentSessionSnapshot>(
				`/api/agent/sessions/${encodeURIComponent(active.id)}/messages`,
				{
					method: "POST",
					body: JSON.stringify({
						message: prompt,
						attachments: attachments.map((attachment) => ({ path: attachment.path, name: attachment.name })),
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
		<section className="panel">
			<h2>正在加载 Agent 对话…</h2>
		</section>
		);
	}

	return (
		<>
			{error && <div className="error-banner">{error}</div>}
			{notice && <div className="success-banner">{notice}</div>}

			<div
				className="agent-workspace"
				style={
					{
						gridTemplateColumns: sidebarOpen ? "250px minmax(0, 1fr)" : "0px minmax(0, 1fr)",
						"--agent-sb-w": sidebarOpen ? "250px" : "0px",
					} as React.CSSProperties
				}
			>
				<aside className="panel agent-session-panel">
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
				</aside>

				<section className="panel agent-chat-panel">
					<div className="agent-chat-heading">
						<button
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
							{sidebarOpen ? "☰" : "☰"}
						</button>
						<h2 className="agent-chat-title">{active?.title ?? ""}</h2>
						{running && (
							<button className="agent-stop-button" type="button" disabled={busy} onClick={() => void stop()}>
								停止生成
							</button>
						)}
					</div>

					{active?.error && <div className="error-banner">{active.error}</div>}
					{active?.uiRequests.map((request) => (
						<AgentUIRequestCard key={request.id} request={request} disabled={busy} onRespond={respond} />
					))}

					<div className="agent-transcript">
						{active?.messages.map((message) => (
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
									) : (
										"本轮主要执行了工具调用。"
									)}
								</div>

								{message.thinking ? (
									<ThinkingBlock thinking={message.thinking} streaming={message.status === "streaming"} />
								) : message.status === "streaming" ? (
									<div className="agent-thinking-streaming">正在思考…</div>
								) : null}
								{message.error && <small className="error-text">{message.error}</small>}
							</article>
						))}
						{active && active.tools.length > 0 && (
							<div className="agent-tool-timeline">
								<span className="eyebrow">工具调用</span>
								{active.tools.map((tool) => (
									<AgentToolCard key={tool.id} tool={tool} />
								))}
							</div>
						)}
						{!active && (
							<div className="agent-chat-empty">
								<span>✦</span>
								<h3>在网页中使用完整的 Paper Agent 工具</h3>
								<p>新建一个会话，然后从下面选一个任务开始，或直接描述你的论文调研目标。</p>
								<div className="agent-suggestion-grid">
									{taskTemplates.map((template) => (
										<button key={template.title} type="button" onClick={() => setPrompt(template.prompt)}>
											<strong>{template.title}</strong>
											<span>{template.prompt.slice(0, 56)}…</span>
										</button>
									))}
								</div>
							</div>
						)}
						{sidebarAvailable && active?.messages.some((message) => message.role === "assistant") && (
							<div className="agent-results-entry">
								<button type="button" onClick={() => void openSidebarDocument()}>
									📄 查看论文清单
								</button>
							</div>
						)}
						<div ref={transcriptEnd} />
					</div>

					<div className="agent-composer">
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
							disabled={!active || running}
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
								<small className="agent-composer-hint">写入、下载、团队提议与配置变更会在上方出现人工确认卡片。</small>
							</div>
							<button
								className="button primary"
								type="button"
								disabled={!active || !prompt.trim() || running || busy || !configurationReady}
								onClick={() => void send()}
							>
								发送
							</button>
						</div>
					</div>
				</section>

				{resultPanelOpen && (
					<aside className="agent-result-overlay">
						<AgentResultSidebar
							tables={sidebarTables}
							loading={sidebarLoading}
							onClose={() => setResultPanelOpen(false)}
						/>
					</aside>
				)}
			</div>
		</>
	);
}
