import { join } from "node:path";
import { type ExtensionFactory, loadSkills } from "@earendil-works/pi-coding-agent";
import {
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
	DEFAULT_UI_TIMEOUT_MS,
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
	protected readonly configuredModels: PaperAgentModelConfig[];
	protected readonly sessionStore: WebAgentSessionStore;
	protected endpoint: WebAgentEndpointConfig;
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
			input: model.input,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			compat: model.compat,
			thinkingLevelMap: model.thinkingLevelMap,
			apiKeyEnvironmentVariable: model.apiKeyEnvironmentVariable,
			headers: model.headers,
		};
		const oldIdentity = this.endpointIdentity(this.endpoint);
		const nextIdentity = this.endpointIdentity(nextEndpoint);
		if (oldIdentity !== nextIdentity || this.memoryApiKey !== undefined) this.configRevision += 1;
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
