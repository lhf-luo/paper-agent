export type WebAgentMode = "once" | "persistent";
export type WebAgentSessionStatus = "idle" | "running" | "stopping" | "error";
export type WebAgentCredentialSource = "memory" | "config" | "environment" | "none";
export type WebAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WebAgentPermissionMode = "ask" | "auto";

export const WEB_AGENT_THINKING_LEVELS: readonly WebAgentThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface WebAgentSessionContext {
	kind: "paper";
	namespace: string;
	paperId: string;
}

export interface WebAgentConfiguredModelView {
	key: string;
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	input: ModelInputModality[];
	apiKeyEnvironmentVariable?: string;
	credentialsAvailable: boolean;
}

export interface WebAgentConfigView {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: ModelApiKind;
	input: ModelInputModality[];
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
	input?: ModelInputModality[];
	apiKey?: string;
}

export interface WebAgentMessageView {
	id: string;
	role: "user" | "assistant";
	content: string;
	thinking?: string;
	status: "complete" | "streaming" | "error" | "aborted";
	createdAt: string;
	error?: string;
}

export interface WebAgentToolView {
	id: string;
	assistantMessageId?: string;
	name: string;
	status: "running" | "succeeded" | "failed";
	input?: string;
	output?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface WebAgentSessionFilter {
	/**
	 * `general` — sessions with no paper context.
	 * `paper` — sessions bound to one paper (requires namespace and paperId).
	 * `personal` — any session bound to a paper in the given personal namespace, across papers.
	 */
	scope?: "general" | "paper" | "personal";
	namespace?: string;
	paperId?: string;
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
	context?: WebAgentSessionContext;
	status: WebAgentSessionStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	pendingUIRequests: number;
	thinkingLevel?: WebAgentThinkingLevel;
	permissionMode: WebAgentPermissionMode;
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
	| (WebAgentEventBase & { type: "thinking_delta"; messageId: string; delta: string })
	| (WebAgentEventBase & { type: "tool"; tool: WebAgentToolView })
	| (WebAgentEventBase & { type: "ui_request"; request: WebAgentUIRequestView })
	| (WebAgentEventBase & { type: "ui_resolved"; requestId: string })
	| (WebAgentEventBase & { type: "notice"; level: "info" | "warning" | "error"; message: string })
	| (WebAgentEventBase & { type: "deleted" });

export type WebAgentEventPayload = WebAgentEvent extends infer Event
	? Event extends WebAgentEventBase
		? Omit<Event, keyof WebAgentEventBase>
		: never
	: never;

export interface WebAgentEventSubscription {
	snapshot: WebAgentSessionSnapshot;
	unsubscribe(): void;
}

export interface WebAgentAttachmentRef {
	path: string;
	name: string;
}

export interface WebAgentAttachment extends WebAgentAttachmentRef {
	size: number;
}

export interface WebAgentServiceApi {
	projectRoot: string;
	getConfig(): WebAgentConfigView | Promise<WebAgentConfigView>;
	listSkills(): Array<{ name: string; description: string; disableModelInvocation: boolean }>;
	updateConfig(input: WebAgentConfigUpdate): WebAgentConfigView | Promise<WebAgentConfigView>;
	applyConfiguredModel(key: string): WebAgentConfigView | Promise<WebAgentConfigView>;
	clearKey(): WebAgentConfigView | Promise<WebAgentConfigView>;
	listSessions(filter?: WebAgentSessionFilter): WebAgentSessionSummary[] | Promise<WebAgentSessionSummary[]>;
	createSession(input: {
		mode: WebAgentMode;
		title?: string;
		context?: WebAgentSessionContext;
		thinkingLevel?: WebAgentThinkingLevel;
		permissionMode?: WebAgentPermissionMode;
	}): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	renameSession(id: string, title: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	updateSessionSettings(
		id: string,
		input: {
			thinkingLevel?: WebAgentThinkingLevel;
			permissionMode?: WebAgentPermissionMode;
		},
	): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	getSession(id: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	deleteSession(id: string): void | Promise<void>;
	dismissError?(id: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	sendMessage(
		id: string,
		input: { message: string; attachments?: WebAgentAttachmentRef[] },
	): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	uploadAttachment(
		id: string,
		input: { name: string; data: Uint8Array },
	): WebAgentAttachment | Promise<WebAgentAttachment>;
	abortSession(id: string): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
	respondToUI(
		id: string,
		requestId: string,
		value: unknown,
	): WebAgentSessionSnapshot | Promise<WebAgentSessionSnapshot>;
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

import type { ModelApiKind, ModelInputModality } from "../../config/domain/config-types.ts";
