import { join } from "node:path";
import { type ExtensionFactory, loadSkills } from "@earendil-works/pi-coding-agent";
import {
	loadPaperAgentConfig,
	type PaperAgentModelConfig,
	type PiBuiltinToolName,
	relayHeadersForModelApi,
} from "../../config/application/config-service.ts";
import {
	type WebAgentConfigUpdate,
	type WebAgentConfigView,
	type WebAgentCredentialSource,
	WebAgentServiceError,
} from "../domain/web-agent-contracts.ts";
import { type PersistedSessionView, WebAgentSessionStore } from "../infrastructure/web-agent-session-store.ts";

export type {
	WebAgentAttachment,
	WebAgentAttachmentRef,
	WebAgentConfigUpdate,
	WebAgentConfiguredModelView,
	WebAgentConfigView,
	WebAgentCredentialSource,
	WebAgentEvent,
	WebAgentEventSubscription,
	WebAgentMessageView,
	WebAgentMode,
	WebAgentServiceApi,
	WebAgentSessionSnapshot,
	WebAgentSessionStatus,
	WebAgentSessionSummary,
	WebAgentToolView,
	WebAgentUIRequestView,
} from "../domain/web-agent-contracts.ts";
export { WebAgentServiceError } from "../domain/web-agent-contracts.ts";

import {
	cloneMessage,
	cloneTool,
	configuredModelKey,
	DEFAULT_UI_TIMEOUT_MS,
	emptyEndpointConfig,
	endpointFromConfiguredModel,
	MAX_TOOL_CHARACTERS,
	type ManagedWebAgentSession,
	PROVIDER_ID,
	SUPPORTED_APIS,
	timestamp,
	validatedBaseUrl,
	type WebAgentEndpointConfig,
	type WebAgentServiceOptions,
} from "./web-agent-support.ts";
export abstract class WebAgentServiceBase {
	readonly projectRoot: string;
	protected readonly uiRequestTimeoutMs: number;
	protected readonly extensionFactory: ExtensionFactory;
	protected readonly systemPrompt: string;
	protected readonly projectSkillRoot: string;
	protected readonly additionalSkillPaths: string[];
	protected readonly builtinTools: PiBuiltinToolName[];
	protected readonly shellPath?: string;
	/**
	 * 已配置模型随项目配置变化，因此不是 readonly：设置页新增或删除供应商后，
	 * 这里会在读取配置视图或切换模型时重新对齐磁盘。
	 */
	protected configuredModels: PaperAgentModelConfig[];
	protected readonly sessionStore: WebAgentSessionStore;
	protected endpoint: WebAgentEndpointConfig;
	/**
	 * 端点由 `PUT /api/agent/config` 直接提交、而非取自项目配置时为 true。这类端点
	 * 可能根本不在 `models.json` 里，因此模型列表变化时不能覆盖或清空它。
	 */
	protected endpointOverridden = false;
	protected environmentCredentialScope?: string;
	protected memoryApiKey?: string;
	protected readonly sessions = new Map<string, ManagedWebAgentSession>();
	protected configRevision = 0;
	protected closed = false;
	protected abstract destroyAllSessions(): Promise<void>;

	protected constructor(
		options: WebAgentServiceOptions,
		endpoint: WebAgentEndpointConfig,
		configuredModels: PaperAgentModelConfig[],
	) {
		this.projectRoot = options.projectRoot;
		this.configuredModels = configuredModels;
		this.sessionStore = new WebAgentSessionStore(options.projectRoot, options.paperSessionDatabasePath);
		this.uiRequestTimeoutMs = Math.max(100, options.uiRequestTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS);
		this.extensionFactory = options.extensionFactory ?? (() => undefined);
		this.systemPrompt = options.systemPrompt ?? "You are Paper Agent.";
		this.projectSkillRoot = join(options.projectRoot, ".agents", "skills");
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.builtinTools = [...(options.builtinTools ?? [])];
		this.shellPath = options.shellPath;
		this.endpoint = endpoint;
		this.environmentCredentialScope = endpoint.apiKeyEnvironmentVariable ? this.credentialScope(endpoint) : undefined;
	}

	protected assertOpen(): void {
		if (this.closed) throw new WebAgentServiceError(503, "Web Agent 服务已关闭");
	}

	protected async restoreSessions(): Promise<void> {
		for (const view of await this.sessionStore.restore()) {
			anchorLegacyTools(view.messages, view.tools);
			this.sessions.set(view.id, {
				id: view.id,
				title: view.title || "Restored session",
				mode: view.mode === "once" ? "once" : "persistent",
				context: view.context ? { ...view.context } : undefined,
				status: "idle",
				createdAt: view.createdAt ?? timestamp(),
				updatedAt: view.updatedAt ?? timestamp(),
				error: undefined,
				messages: view.messages,
				tools: view.tools,
				pendingUI: new Map(),
				listeners: new Set(),
				eventId: 0,
					toolMessageAnchors: new Map(
						view.tools.flatMap((tool) => (tool.assistantMessageId ? [[tool.id, tool.assistantMessageId]] : [])),
					),
					abortRequested: false,
					thinkingLevel: view.thinkingLevel,
					permissionMode: view.permissionMode ?? "ask",
			});
		}
	}

	protected persistedView(session: ManagedWebAgentSession): PersistedSessionView {
		return {
			id: session.id,
			title: session.title,
			mode: session.mode,
			context: session.context ? { ...session.context } : undefined,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			error: session.error,
			messages: session.messages.map(cloneMessage),
			tools: session.tools.map(cloneTool),
			thinkingLevel: session.thinkingLevel,
			permissionMode: session.permissionMode,
		};
	}

	protected persistView(session: ManagedWebAgentSession): void {
		this.sessionStore.persist(this.persistedView(session));
	}

	/**
	 * 重新读取 `.paper-agent/config/` 并与内存状态对齐。设置页新增、删除或切换供应商
	 * 后磁盘上的模型列表会变化；在读取配置视图与切换模型前调用这里，用户不必重启服务。
	 * 读取失败（例如配置正在被写入）时保留上一次可用的列表，不打断正在进行的会话。
	 */
	protected async reloadConfiguredModels(): Promise<void> {
		let models: PaperAgentModelConfig[];
		let active: PaperAgentModelConfig | undefined;
		try {
			const config = await loadPaperAgentConfig(this.projectRoot);
			models = config.models ?? (config.model ? [config.model] : []);
			active = config.model;
		} catch {
			return;
		}
		this.configuredModels = models;
		// 页面直接提交的端点由页面自己决定，模型列表变化不覆盖它，只刷新可选列表。
		if (this.endpointOverridden) return;
		// 否则端点跟随配置：仍存在的当前模型保留（并刷新元数据），被删除时回退到配置的
		// active 模型，没有 active 就回到"未选择"。
		const current = this.endpoint;
		const findCurrent = (model: PaperAgentModelConfig): boolean =>
			model.providerId === current.providerId &&
			model.modelId === current.modelId &&
			model.api === current.api;
		const target = models.find(findCurrent) ?? active;
		const next = target ? endpointFromConfiguredModel(target) : emptyEndpointConfig();
		if (this.endpointIdentity(next) === this.endpointIdentity(current)) return;
		this.configRevision += 1;
		this.endpoint = next;
		this.environmentCredentialScope = next.apiKeyEnvironmentVariable ? this.credentialScope(next) : undefined;
	}

	protected credentialScope(endpoint: WebAgentEndpointConfig): string {
		return `${endpoint.providerId}\n${endpoint.baseUrl}\n${endpoint.api}`;
	}

	protected endpointIdentity(endpoint: WebAgentEndpointConfig): string {
		return `${endpoint.providerId}\n${endpoint.modelId}\n${endpoint.baseUrl}\n${endpoint.api}\n${endpoint.input.join(",")}\n${JSON.stringify(endpoint.headers ?? {})}`;
	}

	protected environmentKey(): string | undefined {
		if (!this.endpoint.apiKeyEnvironmentVariable) return undefined;
		if (this.credentialScope(this.endpoint) !== this.environmentCredentialScope) return undefined;
		return process.env[this.endpoint.apiKeyEnvironmentVariable];
	}

	protected secretValues(): string[] {
		const environmentKey = this.environmentKey();
		return [
			...new Set(
				[this.memoryApiKey, this.configuredModelKey(), environmentKey].filter((value): value is string =>
					Boolean(value),
				),
			),
		];
	}

	protected redact(value: unknown): string {
		let text = value instanceof Error ? value.message : String(value);
		for (const secret of this.secretValues()) {
			if (secret.length >= 3) text = text.split(secret).join("[REDACTED]");
		}
		return text
			.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
			.replace(/\b(Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n,;}]+/gi, "$1: [REDACTED]")
			.replace(/\b(x-api-key|api[_ -]?key)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1: [REDACTED]");
	}

	protected serializeUnknown(value: unknown): string | undefined {
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

	protected credential(): { key?: string; source: WebAgentCredentialSource } {
		if (this.memoryApiKey) return { key: this.memoryApiKey, source: "memory" };
		const configuredKey = this.configuredModelKey();
		if (configuredKey) return { key: configuredKey, source: "config" };
		const environmentKey = this.environmentKey();
		return environmentKey ? { key: environmentKey, source: "environment" } : { source: "none" };
	}

	protected configuredModelKey(): string | undefined {
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

	listSkills(): Array<{ name: string; description: string; disableModelInvocation: boolean }> {
		const result = loadSkills({
			cwd: this.projectRoot,
			agentDir: join(this.projectRoot, ".paper-agent", "web-agent-memory"),
			skillPaths: [...new Set([this.projectSkillRoot, ...this.additionalSkillPaths])],
			includeDefaults: true,
		});
		return result.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
		}));
	}

	async getConfig(): Promise<WebAgentConfigView> {
		// 设置页可能刚改过 models.json，读取前先对齐，否则新增或删除的供应商不会出现。
		this.assertOpen();
		await this.reloadConfiguredModels();
		const credential = this.credential();
		const configured = Boolean(
			this.endpoint.providerId && this.endpoint.modelId && this.endpoint.baseUrl && this.endpoint.api,
		);
		return {
			providerId: this.endpoint.providerId,
			modelId: this.endpoint.modelId,
			baseUrl: this.endpoint.baseUrl,
			api: this.endpoint.api,
			input: this.endpoint.input,
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
				input: model.input,
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
		await this.reloadConfiguredModels();
		const providerId = input.providerId?.trim();
		const modelId = input.modelId?.trim();
		if (!PROVIDER_ID.test(providerId)) {
			throw new WebAgentServiceError(400, "Provider ID 必须是 1-64 位安全标识符");
		}
		if (!modelId || modelId.length > 200) throw new WebAgentServiceError(400, "Model ID 必须包含 1-200 个字符");
		if (!SUPPORTED_APIS.has(input.api)) throw new WebAgentServiceError(400, "不支持该 API 类型");
		const configuredModel = this.configuredModels.find(
			(model) => model.providerId === providerId && model.modelId === modelId && model.api === input.api,
		);
		const nextEndpoint: WebAgentEndpointConfig = {
			providerId,
			modelId,
			baseUrl: validatedBaseUrl(input.baseUrl),
			api: input.api,
			input: input.input ?? configuredModel?.input ?? ["text"],
			reasoning: configuredModel?.reasoning ?? false,
			contextWindow: configuredModel?.contextWindow ?? 128_000,
			maxTokens: configuredModel?.maxTokens ?? 16_384,
			compat: configuredModel?.compat,
			thinkingLevelMap: configuredModel?.thinkingLevelMap,
			apiKeyEnvironmentVariable: this.endpoint.apiKeyEnvironmentVariable,
			headers: relayHeadersForModelApi(input.api),
		};
		let nextKey = this.memoryApiKey;
		if (input.apiKey !== undefined) {
			if (!input.apiKey.trim()) throw new WebAgentServiceError(400, "API key 不能为空");
			if (input.apiKey.length > 16_384) throw new WebAgentServiceError(400, "API key 过长");
			nextKey = input.apiKey.trim();
		}
		const oldIdentity = this.endpointIdentity(this.endpoint);
		const nextIdentity = this.endpointIdentity(nextEndpoint);
		const oldCredentialScope = this.credentialScope(this.endpoint);
		const nextCredentialScope = this.credentialScope(nextEndpoint);
		const endpointChanged = oldIdentity !== nextIdentity;
		const keySubmitted = input.apiKey !== undefined;
		if (oldCredentialScope !== nextCredentialScope && !keySubmitted) nextKey = undefined;
		if (endpointChanged || keySubmitted) this.configRevision += 1;
		// 页面直接提交的端点优先于项目配置，后续模型列表变化不再覆盖它。
		this.endpointOverridden = true;
		this.endpoint = nextEndpoint;
		this.memoryApiKey = nextKey;
		return this.getConfig();
	}

	async applyConfiguredModel(key: string): Promise<WebAgentConfigView> {
		this.assertOpen();
		// 设置页可能刚新增了供应商，先对齐磁盘再查找，否则新模型会被判为"未配置"。
		await this.reloadConfiguredModels();
		const model = this.configuredModels.find((entry) => configuredModelKey(entry) === key);
		if (!model) throw new WebAgentServiceError(404, `未找到已配置的模型: ${key}`);
		const nextEndpoint = endpointFromConfiguredModel(model);
		const oldIdentity = this.endpointIdentity(this.endpoint);
		const nextIdentity = this.endpointIdentity(nextEndpoint);
		if (oldIdentity !== nextIdentity || this.memoryApiKey !== undefined) this.configRevision += 1;
		// 该端点取自项目配置列表，因此继续跟随列表：模型被删除时 reload 会回退或清空。
		this.endpointOverridden = false;
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
		this.memoryApiKey = undefined;
		return this.getConfig();
	}
}

function anchorLegacyTools(messages: PersistedSessionView["messages"], tools: PersistedSessionView["tools"]): void {
	const assistants = messages.filter((message) => message.role === "assistant");
	for (const tool of tools) {
		if (tool.assistantMessageId || !assistants.length) continue;
		const started = Date.parse(tool.startedAt);
		const preceding = assistants.filter((message) => Date.parse(message.createdAt) <= started).at(-1);
		tool.assistantMessageId = (preceding ?? assistants[0]).id;
	}
}
