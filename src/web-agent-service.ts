import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ExtensionUIDialogOptions,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadPaperAgentConfig, type ModelApiKind, type PaperAgentModelConfig } from "./app-config.ts";
import paperAgentExtension, { paperSystemPrompt } from "./index.ts";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPPORTED_APIS = new Set<ModelApiKind>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);
const MAX_MESSAGES = 240;
const MAX_TOOLS = 240;
const MAX_MESSAGE_CHARACTERS = 500_000;
const MAX_TOOL_CHARACTERS = 16_000;
const DEFAULT_UI_TIMEOUT_MS = 5 * 60_000;

export type WebAgentMode = "once" | "persistent";
export type WebAgentSessionStatus = "idle" | "running" | "stopping" | "error";
export type WebAgentCredentialSource = "memory" | "config" | "environment" | "none";

export interface WebAgentConfiguredModelView {
	key: string;
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKeyEnvironmentVariable?: string;
	credentialsAvailable: boolean;
}

export interface WebAgentConfigView {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKeyEnvironmentVariable?: string;
	configured: boolean;
	credentialsAvailable: boolean;
	credentialSource: WebAgentCredentialSource;
	configuredModels: WebAgentConfiguredModelView[];
}

export interface WebAgentConfigUpdate {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKey?: string;
}

export interface WebAgentMessageView {
	id: string;
	role: "user" | "assistant";
	content: string;
	status: "complete" | "streaming" | "error" | "aborted";
	createdAt: string;
	error?: string;
}

export interface WebAgentToolView {
	id: string;
	name: string;
	status: "running" | "succeeded" | "failed";
	input?: string;
	output?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface WebAgentUIRequestView {
	id: string;
	type: "confirm" | "select" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	createdAt: string;
	expiresAt: string;
}

export interface WebAgentSessionSummary {
	id: string;
	title: string;
	mode: WebAgentMode;
	status: WebAgentSessionStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	pendingUIRequests: number;
}

export interface WebAgentSessionSnapshot extends WebAgentSessionSummary {
	messages: WebAgentMessageView[];
	tools: WebAgentToolView[];
	uiRequests: WebAgentUIRequestView[];
}

interface WebAgentEventBase {
	id: number;
	sessionId: string;
	createdAt: string;
}

export type WebAgentEvent =
	| (WebAgentEventBase & { type: "session"; session: WebAgentSessionSummary })
	| (WebAgentEventBase & { type: "message"; message: WebAgentMessageView })
	| (WebAgentEventBase & { type: "message_delta"; messageId: string; delta: string })
	| (WebAgentEventBase & { type: "tool"; tool: WebAgentToolView })
	| (WebAgentEventBase & { type: "ui_request"; request: WebAgentUIRequestView })
	| (WebAgentEventBase & { type: "ui_resolved"; requestId: string })
	| (WebAgentEventBase & { type: "notice"; level: "info" | "warning" | "error"; message: string })
	| (WebAgentEventBase & { type: "deleted" });

type WebAgentEventPayload = WebAgentEvent extends infer Event
	? Event extends WebAgentEventBase
		? Omit<Event, keyof WebAgentEventBase>
		: never
	: never;

export interface WebAgentEventSubscription {
	snapshot: WebAgentSessionSnapshot;
	unsubscribe(): void;
}

export interface WebAgentServiceApi {
	getConfig(): WebAgentConfigView | Promise<WebAgentConfigView>;
	updateConfig(input: WebAgentConfigUpdate): WebAgentConfigView | Promise<WebAgentConfigView>;
	applyConfiguredModel(key: string): WebAgentConfigView | Promise<WebAgentConfigView>;
	clearKey(): WebAgentConfigView | Promise<WebAgentConfigView>;
	listSessions(): WebAgentSessionSummary[] | Promise<WebAgentSessionSummary[]>;
	createSession(input: { mode: WebAgentMode; title?: string }): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	renameSession(id: string, title: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	getSession(id: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	deleteSession(id: string): void | Promise<void>;
	sendMessage(id: string, input: { message: string }): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	abortSession(id: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	respondToUI(id: string, requestId: string, value: unknown): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	subscribeSession(id: string, listener: (event: WebAgentEvent) => void): WebAgentEventSubscription;
	close(): void | Promise<void>;
}

export class WebAgentServiceError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface WebAgentEndpointConfig {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKeyEnvironmentVariable?: string;
}

interface PendingUIRequest {
	view: WebAgentUIRequestView;
	resolve(value: boolean | string | undefined): void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface ManagedWebAgentSession {
	id: string;
	title: string;
	mode: WebAgentMode;
	status: WebAgentSessionStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	messages: WebAgentMessageView[];
	tools: WebAgentToolView[];
	pendingUI: Map<string, PendingUIRequest>;
	listeners: Set<(event: WebAgentEvent) => void>;
	eventId: number;
	pi?: AgentSession;
	unsubscribePi?: () => void;
	runPromise?: Promise<void>;
	activeAssistantMessageId?: string;
	abortRequested: boolean;
}

interface PersistedSessionView {
	id: string;
	title: string;
	mode: WebAgentMode;
	createdAt: string;
	updatedAt: string;
	error?: string;
	messages: WebAgentMessageView[];
	tools: WebAgentToolView[];
}

export interface WebAgentServiceOptions {
	projectRoot: string;
	uiRequestTimeoutMs?: number;
	extensionFactory?: ExtensionFactory;
	systemPrompt?: string;
	additionalSkillPaths?: string[];
}

function timestamp(): string {
	return new Date().toISOString();
}

function validatedBaseUrl(value: string): string {
	if (!value.trim()) throw new WebAgentServiceError(400, "Base URL 不能为空");
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		throw new WebAgentServiceError(400, "Base URL 必须是绝对 URL");
	}
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
		throw new WebAgentServiceError(400, "Base URL 必须使用 HTTPS；仅 loopback 本地测试服务允许 HTTP");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new WebAgentServiceError(400, "Base URL 不得包含凭据、查询参数或片段");
	}
	return parsed.toString().replace(/\/$/, "");
}

function cloneMessage(message: WebAgentMessageView): WebAgentMessageView {
	return { ...message };
}

function cloneTool(tool: WebAgentToolView): WebAgentToolView {
	return { ...tool };
}

function cloneUIRequest(request: WebAgentUIRequestView): WebAgentUIRequestView {
	return { ...request, options: request.options ? [...request.options] : undefined };
}

export class WebAgentService implements WebAgentServiceApi {
	private readonly projectRoot: string;
	private readonly uiRequestTimeoutMs: number;
	private readonly extensionFactory: ExtensionFactory;
	private readonly systemPrompt: string;
	private readonly additionalSkillPaths: string[];
	private readonly configuredModels: PaperAgentModelConfig[];
	private readonly piSessionDir: string;
	private readonly sessionViewDir: string;
	private endpoint: WebAgentEndpointConfig;
	private environmentCredentialScope?: string;
	private memoryApiKey?: string;
	private readonly sessions = new Map<string, ManagedWebAgentSession>();
	private configRevision = 0;
	private closed = false;

	private constructor(options: WebAgentServiceOptions, endpoint: WebAgentEndpointConfig, configuredModels: PaperAgentModelConfig[]) {
		this.projectRoot = options.projectRoot;
		this.configuredModels = configuredModels;
		this.piSessionDir = join(options.projectRoot, ".paper-agent", "web-agent-memory", "pi-sessions");
		this.sessionViewDir = join(options.projectRoot, ".paper-agent", "web-agent-memory", "session-views");
		mkdirSync(this.piSessionDir, { recursive: true });
		mkdirSync(this.sessionViewDir, { recursive: true });
		this.uiRequestTimeoutMs = Math.max(100, options.uiRequestTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS);
		this.extensionFactory = options.extensionFactory ?? paperAgentExtension;
		this.systemPrompt = options.systemPrompt ?? paperSystemPrompt;
		this.additionalSkillPaths = options.additionalSkillPaths ?? [
			join(options.projectRoot, "skills", "literature-corpus-manager"),
		];
		this.endpoint = endpoint;
		this.environmentCredentialScope = endpoint.apiKeyEnvironmentVariable
			? this.credentialScope(endpoint)
			: undefined;
	}

	static async create(options: WebAgentServiceOptions): Promise<WebAgentService> {
		const config = await loadPaperAgentConfig(options.projectRoot);
		const configuredModels = config.models ?? (config.model ? [config.model] : []);
		const service = new WebAgentService(
			options,
			{
				providerId: config.model?.providerId ?? "",
				modelId: config.model?.modelId ?? "",
				baseUrl: config.model?.baseUrl ?? "",
				api: config.model?.api ?? "openai-completions",
				apiKeyEnvironmentVariable: config.model?.apiKeyEnvironmentVariable,
			},
			configuredModels,
		);
		await service.restoreSessions();
		return service;
	}

	private assertOpen(): void {
		if (this.closed) throw new WebAgentServiceError(503, "Web Agent 服务已关闭");
	}

	private async restoreSessions(): Promise<void> {
		let files: string[];
		try {
			files = await readdir(this.sessionViewDir);
		} catch {
			return;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const view = JSON.parse(await readFile(join(this.sessionViewDir, file), "utf8")) as PersistedSessionView;
				if (!view.id || !Array.isArray(view.messages)) continue;
				this.sessions.set(view.id, {
					id: view.id,
					title: view.title || "恢复的会话",
					mode: view.mode === "once" ? "once" : "persistent",
					status: "idle",
					createdAt: view.createdAt ?? timestamp(),
					updatedAt: view.updatedAt ?? timestamp(),
					error: typeof view.error === "string" ? view.error : undefined,
					messages: Array.isArray(view.messages) ? view.messages : [],
					tools: Array.isArray(view.tools) ? view.tools : [],
					pendingUI: new Map(),
					listeners: new Set(),
					eventId: 0,
					abortRequested: false,
				});
			} catch {
				// 损坏的快照文件跳过, 不影响其余会话恢复。
			}
		}
	}

	private async persistView(session: ManagedWebAgentSession): Promise<void> {
		const view: PersistedSessionView = {
			id: session.id,
			title: session.title,
			mode: session.mode,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			error: session.error,
			messages: session.messages,
			tools: session.tools,
		};
		const target = join(this.sessionViewDir, `${session.id}.json`);
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(view), { encoding: "utf8", mode: 0o600 });
			await rename(temporary, target);
		} catch {
			// 持久化是尽力而为: IO 失败不应中断正在运行的会话。
		}
	}

	private async findPiSessionFile(sessionId: string): Promise<string | undefined> {
		try {
			const files = await readdir(this.piSessionDir);
			const match = files.find((file) => file.endsWith(`_${sessionId}.jsonl`));
			return match ? join(this.piSessionDir, match) : undefined;
		} catch {
			return undefined;
		}
	}

	private credentialScope(endpoint: WebAgentEndpointConfig): string {
		return `${endpoint.providerId}\n${endpoint.baseUrl}\n${endpoint.api}`;
	}

	private environmentKey(): string | undefined {
		if (!this.endpoint.apiKeyEnvironmentVariable) return undefined;
		if (this.credentialScope(this.endpoint) !== this.environmentCredentialScope) return undefined;
		return process.env[this.endpoint.apiKeyEnvironmentVariable];
	}

	private secretValues(): string[] {
		const environmentKey = this.environmentKey();
		return [...new Set([this.memoryApiKey, environmentKey].filter((value): value is string => Boolean(value)))];
	}

	private redact(value: unknown): string {
		let text = value instanceof Error ? value.message : String(value);
		for (const secret of this.secretValues()) {
			if (secret.length >= 3) text = text.split(secret).join("[REDACTED]");
		}
		return text
			.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
			.replace(/\b(Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n,;}]+/gi, "$1: [REDACTED]")
			.replace(/\b(x-api-key|api[_ -]?key)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1: [REDACTED]");
	}

	private serializeUnknown(value: unknown): string | undefined {
		if (value === undefined) return undefined;
		const seen = new WeakSet<object>();
		let serialized: string;
		try {
			serialized = JSON.stringify(
				value,
				(_key, entry) => {
					if (typeof entry === "bigint") return entry.toString();
					if (typeof entry === "string") return this.redact(entry);
					if (entry && typeof entry === "object") {
						if (seen.has(entry)) return "[Circular]";
						seen.add(entry);
					}
					return entry;
				},
				2,
			);
		} catch {
			serialized = String(value);
		}
		return this.redact(serialized).slice(0, MAX_TOOL_CHARACTERS);
	}

	private credential(): { key?: string; source: WebAgentCredentialSource } {
		if (this.memoryApiKey) return { key: this.memoryApiKey, source: "memory" };
		const configuredKey = this.configuredModelKey();
		if (configuredKey) return { key: configuredKey, source: "config" };
		const environmentKey = this.environmentKey();
		return environmentKey ? { key: environmentKey, source: "environment" } : { source: "none" };
	}

	private configuredModelKey(): string | undefined {
		const endpoint = this.endpoint;
		if (!endpoint.providerId || !endpoint.modelId || !endpoint.baseUrl) return undefined;
		const model = this.configuredModels.find(
			(entry) =>
				entry.providerId === endpoint.providerId &&
				entry.modelId === endpoint.modelId &&
				entry.baseUrl === endpoint.baseUrl &&
				entry.api === endpoint.api &&
				typeof entry.apiKey === "string" &&
				entry.apiKey.length > 0,
		);
		return model?.apiKey;
	}

	getConfig(): WebAgentConfigView {
		const credential = this.credential();
		const configured = Boolean(
			this.endpoint.providerId && this.endpoint.modelId && this.endpoint.baseUrl && this.endpoint.api,
		);
		return {
			providerId: this.endpoint.providerId,
			modelId: this.endpoint.modelId,
			baseUrl: this.endpoint.baseUrl,
			api: this.endpoint.api,
			apiKeyEnvironmentVariable:
				this.credentialScope(this.endpoint) === this.environmentCredentialScope
					? this.endpoint.apiKeyEnvironmentVariable
					: undefined,
			configured,
			credentialsAvailable: Boolean(credential.key),
			credentialSource: credential.source,
			configuredModels: this.configuredModels.map((model) => ({
				key: `${model.providerId}/${model.modelId}`,
				providerId: model.providerId,
				modelId: model.modelId,
				baseUrl: model.baseUrl,
				api: model.api,
				apiKeyEnvironmentVariable: model.apiKeyEnvironmentVariable,
				credentialsAvailable: Boolean(
					(typeof model.apiKey === "string" && model.apiKey.length > 0) ||
						(model.apiKeyEnvironmentVariable && process.env[model.apiKeyEnvironmentVariable]),
				),
			})),
		};
	}

	async updateConfig(input: WebAgentConfigUpdate): Promise<WebAgentConfigView> {
		this.assertOpen();
		const providerId = input.providerId?.trim();
		const modelId = input.modelId?.trim();
		if (!PROVIDER_ID.test(providerId)) {
			throw new WebAgentServiceError(400, "Provider ID 必须是 1-64 位安全标识符");
		}
		if (!modelId || modelId.length > 200) throw new WebAgentServiceError(400, "Model ID 必须包含 1-200 个字符");
		if (!SUPPORTED_APIS.has(input.api)) throw new WebAgentServiceError(400, "不支持该 API 类型");
		const nextEndpoint: WebAgentEndpointConfig = {
			providerId,
			modelId,
			baseUrl: validatedBaseUrl(input.baseUrl),
			api: input.api,
			apiKeyEnvironmentVariable: this.endpoint.apiKeyEnvironmentVariable,
		};
		let nextKey = this.memoryApiKey;
		if (input.apiKey !== undefined) {
			if (!input.apiKey.trim()) throw new WebAgentServiceError(400, "API key 不能为空");
			if (input.apiKey.length > 16_384) throw new WebAgentServiceError(400, "API key 过长");
			nextKey = input.apiKey.trim();
		}
		const oldIdentity = `${this.endpoint.providerId}\n${this.endpoint.modelId}\n${this.endpoint.baseUrl}\n${this.endpoint.api}`;
		const nextIdentity = `${nextEndpoint.providerId}\n${nextEndpoint.modelId}\n${nextEndpoint.baseUrl}\n${nextEndpoint.api}`;
		const oldCredentialScope = this.credentialScope(this.endpoint);
		const nextCredentialScope = this.credentialScope(nextEndpoint);
		const endpointChanged = oldIdentity !== nextIdentity;
		const keySubmitted = input.apiKey !== undefined;
		if (oldCredentialScope !== nextCredentialScope && !keySubmitted) nextKey = undefined;
		if (endpointChanged || keySubmitted) {
			this.configRevision += 1;
			await this.destroyAllSessions();
		}
		this.endpoint = nextEndpoint;
		this.memoryApiKey = nextKey;
		return this.getConfig();
	}

	async applyConfiguredModel(key: string): Promise<WebAgentConfigView> {
		this.assertOpen();
		const model = this.configuredModels.find((entry) => `${entry.providerId}/${entry.modelId}` === key);
		if (!model) throw new WebAgentServiceError(404, `未找到已配置的模型: ${key}`);
		const nextEndpoint: WebAgentEndpointConfig = {
			providerId: model.providerId,
			modelId: model.modelId,
			baseUrl: model.baseUrl,
			api: model.api,
			apiKeyEnvironmentVariable: model.apiKeyEnvironmentVariable,
		};
		const oldIdentity = `${this.endpoint.providerId}\n${this.endpoint.modelId}\n${this.endpoint.baseUrl}\n${this.endpoint.api}`;
		const nextIdentity = `${nextEndpoint.providerId}\n${nextEndpoint.modelId}\n${nextEndpoint.baseUrl}\n${nextEndpoint.api}`;
		if (oldIdentity !== nextIdentity || this.memoryApiKey !== undefined) {
			this.configRevision += 1;
			await this.destroyAllSessions();
		}
		this.endpoint = nextEndpoint;
		this.environmentCredentialScope = nextEndpoint.apiKeyEnvironmentVariable
			? this.credentialScope(nextEndpoint)
			: undefined;
		this.memoryApiKey = undefined;
		return this.getConfig();
	}

	async clearKey(): Promise<WebAgentConfigView> {
		this.assertOpen();
		this.configRevision += 1;
		await this.destroyAllSessions();
		this.memoryApiKey = undefined;
		return this.getConfig();
	}

	private summary(session: ManagedWebAgentSession): WebAgentSessionSummary {
		return {
			id: session.id,
			title: session.title,
			mode: session.mode,
			status: session.status,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			error: session.error ? this.redact(session.error) : undefined,
			pendingUIRequests: session.pendingUI.size,
		};
	}

	private snapshot(session: ManagedWebAgentSession): WebAgentSessionSnapshot {
		return {
			...this.summary(session),
			messages: session.messages.map(cloneMessage),
			tools: session.tools.map(cloneTool),
			uiRequests: [...session.pendingUI.values()].map((entry) => cloneUIRequest(entry.view)),
		};
	}

	listSessions(): WebAgentSessionSummary[] {
		this.assertOpen();
		return [...this.sessions.values()]
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map((session) => this.summary(session));
	}

	createSession(input: { mode: WebAgentMode; title?: string }): WebAgentSessionSnapshot {
		this.assertOpen();
		if (input.mode !== "once" && input.mode !== "persistent") {
			throw new WebAgentServiceError(400, "会话模式必须是 once 或 persistent");
		}
		const createdAt = timestamp();
		const title = input.title?.trim();
		if (title && title.length > 120) throw new WebAgentServiceError(400, "会话标题不能超过 120 个字符");
		const session: ManagedWebAgentSession = {
			id: randomUUID(),
			title: title || `${input.mode === "once" ? "单次" : "持续"}会话 ${this.sessions.size + 1}`,
			mode: input.mode,
			status: "idle",
			createdAt,
			updatedAt: createdAt,
			messages: [],
			tools: [],
			pendingUI: new Map(),
			listeners: new Set(),
			eventId: 0,
			abortRequested: false,
		};
		this.sessions.set(session.id, session);
		void this.persistView(session);
		return this.snapshot(session);
	}

	async renameSession(id: string, title: string): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		const trimmed = title.trim();
		if (!trimmed || trimmed.length > 120) {
			throw new WebAgentServiceError(400, "会话标题必须包含 1-120 个字符");
		}
		session.title = trimmed;
		this.touch(session);
		this.emitSession(session);
		return this.snapshot(session);
	}

	private managedSession(id: string): ManagedWebAgentSession {
		const session = this.sessions.get(id);
		if (!session) throw new WebAgentServiceError(404, "Agent 会话不存在");
		return session;
	}

	getSession(id: string): WebAgentSessionSnapshot {
		this.assertOpen();
		return this.snapshot(this.managedSession(id));
	}

	private emit(session: ManagedWebAgentSession, event: WebAgentEventPayload): void {
		const value = {
			...event,
			id: ++session.eventId,
			sessionId: session.id,
			createdAt: timestamp(),
		} as WebAgentEvent;
		for (const listener of session.listeners) listener(value);
	}

	private emitSession(session: ManagedWebAgentSession): void {
		this.emit(session, { type: "session", session: this.summary(session) });
	}

	subscribeSession(id: string, listener: (event: WebAgentEvent) => void): WebAgentEventSubscription {
		this.assertOpen();
		const session = this.managedSession(id);
		session.listeners.add(listener);
		return {
			snapshot: this.snapshot(session),
			unsubscribe: () => session.listeners.delete(listener),
		};
	}

	private touch(session: ManagedWebAgentSession): void {
		session.updatedAt = timestamp();
		void this.persistView(session);
	}

	private appendMessage(session: ManagedWebAgentSession, message: WebAgentMessageView): void {
		session.messages.push(message);
		if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
		this.touch(session);
		this.emit(session, { type: "message", message: cloneMessage(message) });
	}

	private updateMessage(session: ManagedWebAgentSession, message: WebAgentMessageView): void {
		this.touch(session);
		this.emit(session, { type: "message", message: cloneMessage(message) });
	}

	private appendTool(session: ManagedWebAgentSession, tool: WebAgentToolView): void {
		session.tools.push(tool);
		if (session.tools.length > MAX_TOOLS) session.tools.splice(0, session.tools.length - MAX_TOOLS);
		this.touch(session);
		this.emit(session, { type: "tool", tool: cloneTool(tool) });
	}

	private existingTool(session: ManagedWebAgentSession, id: string): WebAgentToolView | undefined {
		return session.tools.find((tool) => tool.id === id);
	}

	private assistantMessage(session: ManagedWebAgentSession): WebAgentMessageView {
		const active = session.activeAssistantMessageId
			? session.messages.find((message) => message.id === session.activeAssistantMessageId)
			: undefined;
		if (active) return active;
		const message: WebAgentMessageView = {
			id: randomUUID(),
			role: "assistant",
			content: "",
			status: "streaming",
			createdAt: timestamp(),
		};
		session.activeAssistantMessageId = message.id;
		this.appendMessage(session, message);
		return message;
	}

	private projectedAssistantText(message: unknown): { text: string; error?: string; aborted: boolean } {
		if (!message || typeof message !== "object") return { text: "", aborted: false };
		const source = message as {
			content?: Array<{ type?: string; text?: unknown }>;
			errorMessage?: unknown;
			stopReason?: unknown;
		};
		const text = (source.content ?? [])
			.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
			.map((entry) => entry.text as string)
			.join("");
		return {
			text: this.redact(text).slice(0, MAX_MESSAGE_CHARACTERS),
			error: source.errorMessage ? this.redact(source.errorMessage) : undefined,
			aborted: source.stopReason === "aborted",
		};
	}

	private handlePiEvent(session: ManagedWebAgentSession, event: AgentSessionEvent): void {
		if (!this.sessions.has(session.id)) return;
		if (event.type === "message_start") {
			const message = event.message as { role?: string };
			if (message.role === "assistant") this.assistantMessage(session);
			return;
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			const message = this.assistantMessage(session);
			const remaining = MAX_MESSAGE_CHARACTERS - message.content.length;
			if (remaining <= 0) return;
			const delta = this.redact(event.assistantMessageEvent.delta).slice(0, remaining);
			message.content += delta;
			this.touch(session);
			this.emit(session, { type: "message_delta", messageId: message.id, delta });
			return;
		}
		if (event.type === "message_end") {
			const source = event.message as { role?: string };
			if (source.role !== "assistant") return;
			const message = this.assistantMessage(session);
			const projected = this.projectedAssistantText(event.message);
			if (projected.text || !message.content) message.content = projected.text;
			message.error = projected.error;
			message.status = projected.aborted ? "aborted" : projected.error ? "error" : "complete";
			if (projected.error && !projected.aborted) session.error = projected.error;
			session.activeAssistantMessageId = undefined;
			this.updateMessage(session, message);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.appendTool(session, {
				id: event.toolCallId,
				name: event.toolName,
				status: "running",
				input: this.serializeUnknown(event.args),
				startedAt: timestamp(),
			});
			return;
		}
		if (event.type === "tool_execution_update") {
			const tool = this.existingTool(session, event.toolCallId);
			if (!tool) return;
			tool.output = this.serializeUnknown(event.partialResult);
			this.touch(session);
			this.emit(session, { type: "tool", tool: cloneTool(tool) });
			return;
		}
		if (event.type === "tool_execution_end") {
			const tool = this.existingTool(session, event.toolCallId);
			if (!tool) return;
			tool.status = event.isError ? "failed" : "succeeded";
			tool.output = this.serializeUnknown(event.result);
			tool.finishedAt = timestamp();
			this.touch(session);
			this.emit(session, { type: "tool", tool: cloneTool(tool) });
			return;
		}
		if (event.type === "agent_settled") {
			session.status = session.error ? "error" : "idle";
			this.touch(session);
			this.emitSession(session);
		}
	}

	private settleUIRequest(
		session: ManagedWebAgentSession,
		requestId: string,
		value: boolean | string | undefined,
	): boolean {
		const pending = session.pendingUI.get(requestId);
		if (!pending) return false;
		session.pendingUI.delete(requestId);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending.resolve(value);
		this.touch(session);
		this.emit(session, { type: "ui_resolved", requestId });
		this.emitSession(session);
		return true;
	}

	private rejectPendingUI(session: ManagedWebAgentSession): void {
		for (const [id, pending] of [...session.pendingUI]) {
			this.settleUIRequest(session, id, pending.view.type === "confirm" ? false : undefined);
		}
	}

	private requestUI(
		session: ManagedWebAgentSession,
		type: WebAgentUIRequestView["type"],
		title: string,
		fields: Pick<WebAgentUIRequestView, "message" | "options" | "placeholder">,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean | string | undefined> {
		if (this.closed || !this.sessions.has(session.id) || opts?.signal?.aborted) {
			return Promise.resolve(type === "confirm" ? false : undefined);
		}
		const createdAt = Date.now();
		const timeoutMs = Math.min(Math.max(100, opts?.timeout ?? this.uiRequestTimeoutMs), 30 * 60_000);
		const view: WebAgentUIRequestView = {
			id: randomUUID(),
			type,
			title: this.redact(title).slice(0, 500),
			message: fields.message ? this.redact(fields.message).slice(0, 20_000) : undefined,
			options: fields.options?.map((option) => this.redact(option).slice(0, 1_000)).slice(0, 100),
			placeholder: fields.placeholder ? this.redact(fields.placeholder).slice(0, 1_000) : undefined,
			createdAt: new Date(createdAt).toISOString(),
			expiresAt: new Date(createdAt + timeoutMs).toISOString(),
		};
		return new Promise<boolean | string | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.settleUIRequest(session, view.id, type === "confirm" ? false : undefined);
			}, timeoutMs);
			const pending: PendingUIRequest = { view, resolve, timer, signal: opts?.signal };
			if (opts?.signal) {
				pending.onAbort = () => this.settleUIRequest(session, view.id, type === "confirm" ? false : undefined);
				opts.signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			session.pendingUI.set(view.id, pending);
			this.touch(session);
			this.emit(session, { type: "ui_request", request: cloneUIRequest(view) });
			this.emitSession(session);
		});
	}

	private uiContext(session: ManagedWebAgentSession): ExtensionUIContext {
		const context = {
			select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
				this.requestUI(session, "select", title, { options }, opts) as Promise<string | undefined>,
			confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
				this.requestUI(session, "confirm", title, { message }, opts) as Promise<boolean>,
			input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
				this.requestUI(session, "input", title, { placeholder }, opts) as Promise<string | undefined>,
			notify: (message: string, level: "info" | "warning" | "error" = "info") =>
				this.emit(session, { type: "notice", level, message: this.redact(message).slice(0, 20_000) }),
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setWorkingVisible: () => undefined,
			setWorkingIndicator: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: (title: string, prefill?: string) =>
				this.requestUI(session, "input", title, { placeholder: prefill }) as Promise<string | undefined>,
			addAutocompleteProvider: () => undefined,
			setEditorComponent: () => undefined,
			getEditorComponent: () => undefined,
			theme: {},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Themes are unavailable in Web Agent mode" }),
			getToolsExpanded: () => true,
			setToolsExpanded: () => undefined,
		};
		return context as unknown as ExtensionUIContext;
	}

	private async createPiSession(session: ManagedWebAgentSession, revision: number): Promise<AgentSession> {
		const credential = this.credential();
		if (!this.endpoint.providerId || !this.endpoint.modelId || !this.endpoint.baseUrl) {
			throw new WebAgentServiceError(409, "请先配置 Provider、Model 和 Base URL");
		}
		if (!credential.key) {
			const environmentHint = this.endpoint.apiKeyEnvironmentVariable
				? `，或设置环境变量 ${this.endpoint.apiKeyEnvironmentVariable}`
				: "";
			throw new WebAgentServiceError(409, `请先在网页提交 API key${environmentHint}`);
		}
		const emptyCredentialStore = {
			read: async (_providerId: string, options?: { signal?: AbortSignal }) => {
				options?.signal?.throwIfAborted();
				return undefined;
			},
			list: async (options?: { signal?: AbortSignal }) => {
				options?.signal?.throwIfAborted();
				return [];
			},
			modify: async (
				_providerId: string,
				fn: (current: undefined) => Promise<undefined>,
				options?: { signal?: AbortSignal },
			) => {
				options?.signal?.throwIfAborted();
				return fn(undefined);
			},
			delete: async (_providerId: string, options?: { signal?: AbortSignal }) => {
				options?.signal?.throwIfAborted();
			},
		};
		try {
			const modelRuntime = await ModelRuntime.create({
				credentials: emptyCredentialStore as never,
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider(this.endpoint.providerId, {
				name: this.endpoint.providerId,
				baseUrl: this.endpoint.baseUrl,
				api: this.endpoint.api,
				apiKey: "$PAPER_AGENT_WEB_EPHEMERAL_KEY",
				authHeader: this.endpoint.api === "openai-completions" || this.endpoint.api === "openai-responses",
				models: [
					{
						id: this.endpoint.modelId,
						name: this.endpoint.modelId,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 16_384,
					},
				],
			});
			await modelRuntime.setRuntimeApiKey(this.endpoint.providerId, credential.key);
			const model = modelRuntime.getModel(this.endpoint.providerId, this.endpoint.modelId);
			if (!model) throw new Error("Pi 未能注册所选模型");
			const resourceLoader = new DefaultResourceLoader({
				cwd: this.projectRoot,
				agentDir: join(this.projectRoot, ".paper-agent", "web-agent-memory"),
				noExtensions: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalSkillPaths: this.additionalSkillPaths,
				extensionFactories: [{ name: "paper-agent-web", factory: this.extensionFactory }],
				systemPrompt: this.systemPrompt,
			});
			await resourceLoader.reload();
			const piSessionFile = await this.findPiSessionFile(session.id);
			const sessionManager = piSessionFile
				? SessionManager.open(piSessionFile, this.piSessionDir, this.projectRoot)
				: SessionManager.create(this.projectRoot, this.piSessionDir, { id: session.id });
			const result = await createAgentSession({
				cwd: this.projectRoot,
				agentDir: join(this.projectRoot, ".paper-agent", "web-agent-memory"),
				model,
				thinkingLevel: "off",
				modelRuntime,
				resourceLoader,
				sessionManager,
				settingsManager: SettingsManager.inMemory(
					{ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } },
					{ projectTrusted: true },
				),
				noTools: "builtin",
			});
			await result.session.bindExtensions({ uiContext: this.uiContext(session), mode: "rpc" });
			const forbidden = result.session
				.getActiveToolNames()
				.filter((name) => ["read", "bash", "edit", "write"].includes(name));
			if (forbidden.length) {
				result.session.dispose();
				throw new Error(`安全检查失败：Pi 内置工具仍处于启用状态 (${forbidden.join(", ")})`);
			}
			if (revision !== this.configRevision || !this.sessions.has(session.id) || this.closed) {
				result.session.dispose();
				throw new WebAgentServiceError(409, "模型配置已变化，请重新发送消息");
			}
			return result.session;
		} catch (error) {
			if (error instanceof WebAgentServiceError) throw error;
			throw new WebAgentServiceError(502, `无法启动 Agent 会话：${this.redact(error)}`);
		}
	}

	private async ensurePiSession(session: ManagedWebAgentSession, revision: number): Promise<AgentSession> {
		if (session.pi) return session.pi;
		const pi = await this.createPiSession(session, revision);
		session.pi = pi;
		session.unsubscribePi = pi.subscribe((event) => this.handlePiEvent(session, event));
		return pi;
	}

	private disposePiSession(session: ManagedWebAgentSession): void {
		this.rejectPendingUI(session);
		session.unsubscribePi?.();
		session.unsubscribePi = undefined;
		session.pi?.dispose();
		session.pi = undefined;
		session.activeAssistantMessageId = undefined;
	}

	private async runPrompt(session: ManagedWebAgentSession, pi: AgentSession, message: string): Promise<void> {
		try {
			await pi.prompt(message, { source: "rpc" });
		} catch (error) {
			if (!session.abortRequested) {
				session.error = this.redact(error);
				session.status = "error";
				const assistant = session.activeAssistantMessageId
					? session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
					: undefined;
				if (assistant) {
					assistant.status = "error";
					assistant.error = session.error;
					this.updateMessage(session, assistant);
				}
			}
		} finally {
			if (session.abortRequested) {
				const assistant = session.activeAssistantMessageId
					? session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
					: undefined;
				if (assistant) {
					assistant.status = "aborted";
					this.updateMessage(session, assistant);
				}
				session.error = undefined;
				session.status = "idle";
			}
			if (session.status === "running" || session.status === "stopping") {
				session.status = session.error ? "error" : "idle";
			}
			session.activeAssistantMessageId = undefined;
			session.runPromise = undefined;
			session.abortRequested = false;
			this.touch(session);
			if (session.mode === "once") this.disposePiSession(session);
			this.emitSession(session);
		}
	}

	async sendMessage(id: string, input: { message: string }): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (session.runPromise) throw new WebAgentServiceError(409, "该 Agent 会话正在生成，请先停止或等待完成");
		const message = input.message?.trim();
		if (!message || message.length > 20_000) {
			throw new WebAgentServiceError(400, "消息必须包含 1-20000 个字符");
		}
		const revision = this.configRevision;
		const pi = await this.ensurePiSession(session, revision);
		if (revision !== this.configRevision || !this.sessions.has(id)) {
			this.disposePiSession(session);
			throw new WebAgentServiceError(409, "模型配置已变化，请重新发送消息");
		}
		session.error = undefined;
		session.status = "running";
		session.abortRequested = false;
		const safeMessage = this.redact(message);
		const userMessage: WebAgentMessageView = {
			id: randomUUID(),
			role: "user",
			content: safeMessage,
			status: "complete",
			createdAt: timestamp(),
		};
		this.appendMessage(session, userMessage);
		this.emitSession(session);
		session.runPromise = this.runPrompt(session, pi, safeMessage);
		return this.snapshot(session);
	}

	async abortSession(id: string): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (!session.runPromise || !session.pi) return this.snapshot(session);
		session.abortRequested = true;
		session.status = "stopping";
		this.rejectPendingUI(session);
		this.touch(session);
		this.emitSession(session);
		try {
			await session.pi.abort();
			await session.runPromise;
		} catch {
			// runPrompt performs the final state transition and redaction.
		}
		return this.snapshot(session);
	}

	async respondToUI(id: string, requestId: string, value: unknown): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		const pending = session.pendingUI.get(requestId);
		if (!pending) throw new WebAgentServiceError(404, "确认请求不存在或已过期");
		let response: boolean | string | undefined;
		if (pending.view.type === "confirm") {
			if (typeof value !== "boolean") throw new WebAgentServiceError(400, "确认请求需要布尔值");
			response = value;
		} else if (value === null || value === undefined) {
			response = undefined;
		} else {
			if (typeof value !== "string" || value.length > 20_000) {
				throw new WebAgentServiceError(400, "响应必须是字符串或 null");
			}
			if (pending.view.type === "select" && !pending.view.options?.includes(value)) {
				throw new WebAgentServiceError(400, "请选择提供的选项之一");
			}
			response = value;
		}
		this.settleUIRequest(session, requestId, response);
		return this.snapshot(session);
	}

	private async disposeManagedSession(session: ManagedWebAgentSession): Promise<void> {
		if (session.runPromise && session.pi) {
			session.abortRequested = true;
			this.rejectPendingUI(session);
			try {
				await session.pi.abort();
				await session.runPromise;
			} catch {
				// The session is disposed below even when a provider abort fails.
			}
		}
		this.disposePiSession(session);
		this.emit(session, { type: "deleted" });
		session.listeners.clear();
	}

	async deleteSession(id: string): Promise<void> {
		this.assertOpen();
		const session = this.managedSession(id);
		this.sessions.delete(id);
		await this.disposeManagedSession(session);
		await rm(join(this.sessionViewDir, `${id}.json`), { force: true }).catch(() => undefined);
		const piFile = await this.findPiSessionFile(id);
		if (piFile) await rm(piFile, { force: true }).catch(() => undefined);
	}

	private async destroyAllSessions(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => this.disposeManagedSession(session)));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.configRevision += 1;
		await this.destroyAllSessions();
		this.memoryApiKey = undefined;
	}
}

export async function createWebAgentService(options: WebAgentServiceOptions): Promise<WebAgentService> {
	return WebAgentService.create(options);
}
