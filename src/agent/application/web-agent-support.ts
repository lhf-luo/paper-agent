import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	ModelApiKind,
	ModelInputModality,
	PiBuiltinToolName,
} from "../../config/application/config-service.ts";

export const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SUPPORTED_APIS = new Set<ModelApiKind>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);
export const MAX_MESSAGES = 240;
export const MAX_TOOLS = 240;
export const MAX_MESSAGE_CHARACTERS = 500_000;
export const MAX_TOOL_CHARACTERS = 16_000;
export const DEFAULT_UI_TIMEOUT_MS = 5 * 60_000;

import {
	type WebAgentEvent,
	type WebAgentMessageView,
	type WebAgentMode,
	WebAgentServiceError,
	type WebAgentSessionContext,
	type WebAgentSessionStatus,
	type WebAgentThinkingLevel,
	type WebAgentToolView,
	type WebAgentUIRequestView,
	WEB_AGENT_THINKING_LEVELS,
} from "../domain/web-agent-contracts.ts";

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
	WebAgentSessionContext,
	WebAgentToolView,
	WebAgentUIRequestView,
} from "../domain/web-agent-contracts.ts";
export { WebAgentServiceError } from "../domain/web-agent-contracts.ts";

export interface WebAgentEndpointConfig {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	input: ModelInputModality[];
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
	apiKeyEnvironmentVariable?: string;
	headers?: Record<string, string>;
}

export interface PendingUIRequest {
	view: WebAgentUIRequestView;
	resolve(value: boolean | string | undefined): void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface ManagedWebAgentSession {
	id: string;
	title: string;
	mode: WebAgentMode;
	context?: WebAgentSessionContext;
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
	piRevision?: number;
	unsubscribePi?: () => void;
	runPromise?: Promise<void>;
	activeAssistantMessageId?: string;
	toolMessageAnchors: Map<string, string>;
	abortRequested: boolean;
	thinkingLevel?: WebAgentThinkingLevel;
	permissionMode: "ask" | "auto";
}

export function normalizeThinkingLevel(value: unknown): WebAgentThinkingLevel | undefined {
	return typeof value === "string" && (WEB_AGENT_THINKING_LEVELS as readonly string[]).includes(value)
		? (value as WebAgentThinkingLevel)
		: undefined;
}

export function normalizePermissionMode(value: unknown): "ask" | "auto" | undefined {
	return value === "ask" || value === "auto" ? value : undefined;
}

export interface WebAgentServiceOptions {
	projectRoot: string;
	uiRequestTimeoutMs?: number;
	extensionFactory?: ExtensionFactory;
	systemPrompt?: string;
	additionalSkillPaths?: string[];
	builtinTools?: PiBuiltinToolName[];
	shellPath?: string;
	paperSessionDatabasePath?: string;
}

export function timestamp(): string {
	return new Date().toISOString();
}

export function validatedBaseUrl(value: string): string {
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

export function cloneMessage(message: WebAgentMessageView): WebAgentMessageView {
	return { ...message };
}

export function cloneTool(tool: WebAgentToolView): WebAgentToolView {
	return { ...tool };
}

export function cloneUIRequest(request: WebAgentUIRequestView): WebAgentUIRequestView {
	return { ...request, options: request.options ? [...request.options] : undefined };
}
