import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiEventStream } from "./api";
import type {
	AgentApiKind,
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

const apiKinds: Array<{ value: AgentApiKind; label: string }> = [
	{ value: "openai-completions", label: "OpenAI Chat Completions" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
];

interface AgentConfigForm {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: AgentApiKind;
}

function summaryFromSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSummary {
	const { messages: _messages, tools: _tools, uiRequests: _uiRequests, ...summary } = snapshot;
	return summary;
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

function credentialLabel(config?: AgentConfigView): string {
	if (!config?.credentialsAvailable) return "未提供凭据";
	return config.credentialSource === "memory" ? "服务进程内存" : "环境变量";
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

export function AgentPage() {
	const [config, setConfig] = useState<AgentConfigView>();
	const [form, setForm] = useState<AgentConfigForm>({
		providerId: "",
		modelId: "",
		baseUrl: "",
		api: "openai-completions",
	});
	const [apiKey, setApiKey] = useState("");
	const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
	const [active, setActive] = useState<AgentSessionSnapshot>();
	const [newMode, setNewMode] = useState<AgentMode>("persistent");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
	const transcriptEnd = useRef<HTMLDivElement>(null);

	const applyConfig = useCallback((next: AgentConfigView) => {
		setConfig(next);
		setForm({ providerId: next.providerId, modelId: next.modelId, baseUrl: next.baseUrl, api: next.api });
	}, []);

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
			if (event.type === "tool") {
				setActive((current) =>
					current?.id === event.sessionId ? { ...current, tools: upsert(current.tools, event.tool) } : current,
				);
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
	}, [activeId]);

		useEffect(() => {
			if (!active) return;
			transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
		}, [active]);

	const saveConfig = async () => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const next = await api<AgentConfigView>("/api/agent/config", {
				method: "PUT",
				body: JSON.stringify({ ...form, ...(apiKey ? { apiKey } : {}) }),
			});
			setApiKey("");
			applyConfig(next);
			await refreshSessions();
			setNotice("模型配置已应用。网页输入的密钥仅保留在当前服务进程内存中。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const clearKey = async () => {
		setBusy(true);
		setError("");
		try {
			const next = await api<AgentConfigView>("/api/agent/key", { method: "DELETE" });
			setApiKey("");
			applyConfig(next);
			await refreshSessions();
			setNotice(next.credentialSource === "environment" ? "内存密钥已清除；当前将使用项目环境变量。" : "内存密钥和旧会话已清除。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const createSession = async () => {
		setBusy(true);
		setError("");
		try {
			const snapshot = await api<AgentSessionSnapshot>("/api/agent/sessions", {
				method: "POST",
				body: JSON.stringify({ mode: newMode }),
			});
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

	const send = async () => {
		if (!active || !prompt.trim()) return;
		setBusy(true);
		setError("");
		try {
			const snapshot = await api<AgentSessionSnapshot>(
				`/api/agent/sessions/${encodeURIComponent(active.id)}/messages`,
				{ method: "POST", body: JSON.stringify({ message: prompt }) },
			);
			setPrompt("");
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
			<header className="page-heading">
				<div>
					<span className="eyebrow">Paper Agent runtime</span>
					<h1>Agent 对话</h1>
					<p>直接提出论文检索、PDF 分析、Artifact、个人库、团队库与调研整理需求；所有高风险写入仍需你在网页明确确认。</p>
				</div>
				<div className="agent-runtime-status">
					<span className={configurationReady ? "ready" : "missing"} />
					<div>
						<strong>{configurationReady ? "可开始对话" : "需要模型配置或密钥"}</strong>
						<small>{credentialLabel(config)}</small>
					</div>
				</div>
			</header>

			{error && <div className="error-banner">{error}</div>}
			{notice && <div className="success-banner">{notice}</div>}

			<section className="panel agent-config-panel">
				<div className="panel-heading">
					<div>
						<span className="eyebrow">Ephemeral model access</span>
						<h2>模型与凭据</h2>
					</div>
					<span className={`agent-credential-badge ${config?.credentialSource ?? "none"}`}>
						{credentialLabel(config)}
					</span>
				</div>
				<div className="agent-secret-warning">
					<strong>密钥仅保留在本次 Paper Agent 服务进程的内存中</strong>
					<span>不会写入项目配置、Pi auth/models 文件、浏览器存储、对话记录或错误响应。服务重启后需重新输入。</span>
				</div>
				<div className="agent-config-grid">
					<label>
						<span>Provider ID</span>
						<input
							value={form.providerId}
							onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value }))}
							placeholder="openai-compatible"
						/>
					</label>
					<label>
						<span>Model ID</span>
						<input
							value={form.modelId}
							onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))}
							placeholder="model-name"
						/>
					</label>
					<label className="wide">
						<span>Base URL</span>
						<input
							value={form.baseUrl}
							onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
							placeholder="https://api.example.com/v1"
						/>
					</label>
					<label>
						<span>API 类型</span>
						<select
							value={form.api}
							onChange={(event) => setForm((current) => ({ ...current, api: event.target.value as AgentApiKind }))}
						>
							{apiKinds.map((entry) => (
								<option key={entry.value} value={entry.value}>
									{entry.label}
								</option>
							))}
						</select>
					</label>
					<label>
						<span>API key（留空表示不替换）</span>
						<input
							type="password"
							autoComplete="off"
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
							placeholder="仅进入服务进程内存"
						/>
					</label>
				</div>
				<div className="agent-config-actions">
					<div>
						{config?.apiKeyEnvironmentVariable ? (
							<small>项目环境变量：{config.apiKeyEnvironmentVariable}</small>
						) : (
							<small>未配置项目级密钥环境变量；可直接使用上方内存密钥。</small>
						)}
					</div>
					<div className="button-row">
						<button className="button secondary" type="button" disabled={busy} onClick={() => void clearKey()}>
							清除内存密钥
						</button>
						<button className="button primary" type="button" disabled={busy} onClick={() => void saveConfig()}>
							应用配置
						</button>
					</div>
				</div>
			</section>

			<div className="agent-workspace">
				<aside className="panel agent-session-panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">In-memory sessions</span>
							<h2>会话</h2>
						</div>
						<small>{orderedSessions.length} 个</small>
					</div>
					<div className="agent-new-session">
						<select value={newMode} onChange={(event) => setNewMode(event.target.value as AgentMode)}>
							<option value="persistent">persistent · 保留上下文</option>
							<option value="once">once · 每轮重置模型上下文</option>
						</select>
						<button className="button primary" type="button" disabled={busy} onClick={() => void createSession()}>
							新建会话
						</button>
					</div>
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
								<button
									className="agent-session-delete"
									type="button"
									aria-label={`删除 ${session.title}`}
									onClick={() => void deleteSession(session.id)}
								>
									×
								</button>
							</article>
						))}
						{!orderedSessions.length && <p className="muted">新建 once 或 persistent 内存会话后开始对话。</p>}
					</div>
					<div className="agent-template-list">
						<span className="eyebrow">常用任务模板</span>
						{taskTemplates.map((template) => (
							<button key={template.title} type="button" onClick={() => setPrompt(template.prompt)}>
								<strong>{template.title}</strong>
								<span>填入输入框后可继续修改</span>
							</button>
						))}
					</div>
				</aside>

				<section className="panel agent-chat-panel">
					<div className="agent-chat-heading">
						<div>
							<span className="eyebrow">Streaming research conversation</span>
							<h2>{active?.title ?? "选择或新建会话"}</h2>
						</div>
						<div className="agent-chat-state">
							<span className={streamState} />
							<small>{streamState === "connected" ? "实时连接" : streamState === "reconnecting" ? "正在重连" : "未连接"}</small>
							{running && (
								<button className="button danger" type="button" disabled={busy} onClick={() => void stop()}>
									停止生成
								</button>
							)}
						</div>
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
									{message.content || (message.status === "streaming" ? "正在思考并调用研究工具…" : "本轮主要执行了工具调用。")}
								</div>
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
								<p>配置模型，创建会话，然后从模板开始，或直接描述你的论文调研目标。</p>
							</div>
						)}
						<div ref={transcriptEnd} />
					</div>

					<div className="agent-composer">
						<textarea
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									void send();
								}
							}}
							placeholder="描述你的论文调研任务。Ctrl / Cmd + Enter 发送。"
							rows={4}
							disabled={!active || running}
						/>
						<div>
							<small>写入、下载、团队提议与配置变更会在上方出现人工确认卡片。</small>
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
			</div>
		</>
	);
}
