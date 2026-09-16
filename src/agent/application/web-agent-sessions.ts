import { randomUUID } from "node:crypto";
import {
	type WebAgentEvent,
	type WebAgentEventPayload,
	type WebAgentEventSubscription,
	type WebAgentMessageView,
	type WebAgentMode,
	type WebAgentPermissionMode,
	WebAgentServiceError,
	type WebAgentSessionContext,
	type WebAgentSessionSnapshot,
	type WebAgentSessionFilter,
	type WebAgentSessionSummary,
	type WebAgentThinkingLevel,
	type WebAgentToolView,
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
	WebAgentToolView,
	WebAgentUIRequestView,
} from "../domain/web-agent-contracts.ts";
export { WebAgentServiceError } from "../domain/web-agent-contracts.ts";

import { WebAgentServiceBase } from "./web-agent-base.ts";
import {
	cloneMessage,
	cloneTool,
	cloneUIRequest,
	MAX_MESSAGE_CHARACTERS,
	MAX_MESSAGES,
	MAX_TOOLS,
	type ManagedWebAgentSession,
	timestamp,
} from "./web-agent-support.ts";

export abstract class WebAgentSessions extends WebAgentServiceBase {
	protected summary(session: ManagedWebAgentSession): WebAgentSessionSummary {
		return {
			id: session.id,
			title: session.title,
			mode: session.mode,
			context: session.context ? { ...session.context } : undefined,
			status: session.status,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			error: session.error ? this.redact(session.error) : undefined,
			pendingUIRequests: session.pendingUI.size,
			thinkingLevel: session.thinkingLevel,
			permissionMode: session.permissionMode,
		};
	}

	protected snapshot(session: ManagedWebAgentSession): WebAgentSessionSnapshot {
		return {
			...this.summary(session),
			messages: session.messages.map(cloneMessage),
			tools: session.tools.map(cloneTool),
			uiRequests: [...session.pendingUI.values()].map((entry) => cloneUIRequest(entry.view)),
		};
	}

	listSessions(filter: WebAgentSessionFilter = { scope: "general" }): WebAgentSessionSummary[] {
		this.assertOpen();
		return [...this.sessions.values()]
			.filter((session) => {
				if (filter.scope === "paper") {
					return (
						session.context?.kind === "paper" &&
						(!filter.namespace || session.context.namespace === filter.namespace) &&
						(!filter.paperId || session.context.paperId === filter.paperId)
					);
				}
				return !session.context;
			})
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map((session) => this.summary(session));
	}

	createSession(input: {
		mode: WebAgentMode;
		title?: string;
		context?: WebAgentSessionContext;
		thinkingLevel?: WebAgentThinkingLevel;
		permissionMode?: WebAgentPermissionMode;
	}): WebAgentSessionSnapshot {
		this.assertOpen();
		if (input.mode !== "once" && input.mode !== "persistent") {
			throw new WebAgentServiceError(400, "会话模式必须是 once 或 persistent");
		}
		const createdAt = timestamp();
		const title = input.title?.trim();
		if (title && title.length > 120) throw new WebAgentServiceError(400, "会话标题不能超过 120 个字符");
		let context: WebAgentSessionContext | undefined;
		if (input.context) {
			if (input.context.kind !== "paper") throw new WebAgentServiceError(400, "不支持的会话上下文");
			if (!input.context.namespace.trim() || !input.context.paperId.trim()) {
				throw new WebAgentServiceError(400, "论文会话上下文缺少 namespace 或 paperId");
			}
			context = {
				kind: "paper",
				namespace: input.context.namespace.trim(),
				paperId: input.context.paperId.trim(),
			};
			if (!this.sessionStore.hasPaper(context)) {
				throw new WebAgentServiceError(404, "个人库中不存在这篇论文，无法创建论文会话");
			}
		}
		const session: ManagedWebAgentSession = {
			id: randomUUID(),
			title: title || `${input.mode === "once" ? "单次" : "持续"}会话 ${this.sessions.size + 1}`,
			mode: input.mode,
			context,
			status: "idle",
			createdAt,
			updatedAt: createdAt,
			messages: [],
			tools: [],
			pendingUI: new Map(),
			listeners: new Set(),
			eventId: 0,
			toolMessageAnchors: new Map(),
			abortRequested: false,
			thinkingLevel: input.thinkingLevel,
			permissionMode: input.permissionMode ?? "ask",
		};
		this.sessions.set(session.id, session);
		this.persistView(session);
		return this.snapshot(session);
	}

	async updateSessionSettings(
		id: string,
		input: {
			thinkingLevel?: WebAgentThinkingLevel;
			permissionMode?: WebAgentPermissionMode;
		},
	): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (
			input.thinkingLevel === undefined &&
			input.permissionMode === undefined
		) {
			throw new WebAgentServiceError(400, "请提供 thinkingLevel 或 permissionMode 之一");
		}
		if (input.thinkingLevel !== undefined) session.thinkingLevel = input.thinkingLevel;
		if (input.permissionMode !== undefined) session.permissionMode = input.permissionMode;
		if (session.pi && input.thinkingLevel !== undefined) {
			try {
				session.pi.setThinkingLevel(input.thinkingLevel);
			} catch (reason) {
				// Pi 会按模型能力收敛思考强度；失败时保留会话设置, 下次创建 Pi 会话再应用。
				this.emit(session, {
					type: "notice",
					level: "warning",
					message: `思考强度设置将在下一轮对话生效：${this.redact(reason)}`,
				});
			}
		}
		this.touch(session);
		this.emitSession(session);
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

	protected managedSession(id: string): ManagedWebAgentSession {
		const session = this.sessions.get(id);
		if (!session) throw new WebAgentServiceError(404, "Agent 会话不存在");
		return session;
	}

	getSession(id: string): WebAgentSessionSnapshot {
		this.assertOpen();
		return this.snapshot(this.managedSession(id));
	}

	protected emit(session: ManagedWebAgentSession, event: WebAgentEventPayload): void {
		const value = {
			...event,
			id: ++session.eventId,
			sessionId: session.id,
			createdAt: timestamp(),
		} as WebAgentEvent;
		for (const listener of session.listeners) listener(value);
	}

	protected emitSession(session: ManagedWebAgentSession): void {
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

	protected touch(session: ManagedWebAgentSession): void {
		session.updatedAt = timestamp();
		this.persistView(session);
	}

	protected appendMessage(session: ManagedWebAgentSession, message: WebAgentMessageView): void {
		session.messages.push(message);
		if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
		this.touch(session);
		this.emit(session, { type: "message", message: cloneMessage(message) });
	}

	protected updateMessage(session: ManagedWebAgentSession, message: WebAgentMessageView): void {
		this.touch(session);
		this.emit(session, { type: "message", message: cloneMessage(message) });
	}

	protected appendTool(session: ManagedWebAgentSession, tool: WebAgentToolView): void {
		session.tools.push(tool);
		if (session.tools.length > MAX_TOOLS) session.tools.splice(0, session.tools.length - MAX_TOOLS);
		this.touch(session);
		this.emit(session, { type: "tool", tool: cloneTool(tool) });
	}

	protected existingTool(session: ManagedWebAgentSession, id: string): WebAgentToolView | undefined {
		return session.tools.find((tool) => tool.id === id);
	}

	protected assistantMessage(session: ManagedWebAgentSession): WebAgentMessageView {
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

	protected projectedThinking(message: unknown): string | undefined {
		if (!message || typeof message !== "object") return undefined;
		const source = message as { content?: Array<{ type?: string; thinking?: unknown }> };
		const thinking = (source.content ?? [])
			.filter((entry) => entry?.type === "thinking" && typeof entry.thinking === "string")
			.map((entry) => entry.thinking as string)
			.join("");
		return thinking ? this.redact(thinking).slice(0, MAX_MESSAGE_CHARACTERS) : undefined;
	}

	protected projectedAssistantText(message: unknown): { text: string; error?: string; aborted: boolean } {
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
}
