import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { WebAgentServiceError } from "../domain/web-agent-contracts.ts";

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

import { WebAgentPiEvents } from "./web-agent-pi-events.ts";
import type { ManagedWebAgentSession } from "./web-agent-support.ts";

export abstract class WebAgentRuntime extends WebAgentPiEvents {
	protected async createPiSession(session: ManagedWebAgentSession, revision: number): Promise<AgentSession> {
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
				headers: this.endpoint.headers,
				authHeader: this.endpoint.api === "openai-completions" || this.endpoint.api === "openai-responses",
				models: [
					{
						id: this.endpoint.modelId,
						name: this.endpoint.modelId,
						reasoning: this.endpoint.reasoning,
						input: this.endpoint.input,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: this.endpoint.contextWindow,
						maxTokens: this.endpoint.maxTokens,
						compat: this.endpoint.compat,
						thinkingLevelMap: this.endpoint.thinkingLevelMap,
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
			const piSessionFile = await this.sessionStore.findPiSessionFile(session.id);
			const sessionManager = piSessionFile
				? SessionManager.open(piSessionFile, this.sessionStore.piSessionDir, this.projectRoot)
				: SessionManager.create(this.projectRoot, this.sessionStore.piSessionDir, { id: session.id });
			const result = await createAgentSession({
				cwd: this.projectRoot,
				agentDir: join(this.projectRoot, ".paper-agent", "web-agent-memory"),
				model,
				thinkingLevel: "low",
				modelRuntime,
				resourceLoader,
				sessionManager,
				settingsManager: SettingsManager.inMemory(
					{
						compaction: { enabled: true },
						retry: { enabled: true, maxRetries: 2 },
						shellPath: this.shellPath,
					},
					{ projectTrusted: true },
				),
				noTools: "builtin",
			});
			await result.session.bindExtensions({ uiContext: this.uiContext(session), mode: "rpc" });
			const activeTools = new Set(result.session.getActiveToolNames());
			for (const name of this.builtinTools) activeTools.add(name);
			result.session.setActiveToolsByName([...activeTools]);
			const enabledTools = new Set(result.session.getActiveToolNames());
			const missingTools = this.builtinTools.filter((name) => !enabledTools.has(name));
			if (missingTools.length) {
				result.session.dispose();
				throw new Error(`Configured Pi built-in tools are unavailable: ${missingTools.join(", ")}`);
			}
			const forbidden = result.session
				.getActiveToolNames()
				.filter(
					(name) =>
						["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name) &&
						!this.builtinTools.includes(name as (typeof this.builtinTools)[number]),
				);
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

	protected async ensurePiSession(session: ManagedWebAgentSession, revision: number): Promise<AgentSession> {
		if (session.pi && session.piRevision === revision) return session.pi;
		if (session.pi) this.disposePiSession(session);
		const pi = await this.createPiSession(session, revision);
		session.pi = pi;
		session.piRevision = revision;
		session.unsubscribePi = pi.subscribe((event) => this.handlePiEvent(session, event));
		return pi;
	}

	protected disposePiSession(session: ManagedWebAgentSession): void {
		this.rejectPendingUI(session);
		session.unsubscribePi?.();
		session.unsubscribePi = undefined;
		session.pi?.dispose();
		session.pi = undefined;
		session.piRevision = undefined;
		session.activeAssistantMessageId = undefined;
	}

	protected async runPrompt(session: ManagedWebAgentSession, pi: AgentSession, message: string): Promise<void> {
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
}
