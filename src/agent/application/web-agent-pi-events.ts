import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { WebAgentUIRequestView } from "../domain/web-agent-contracts.ts";

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

import { WebAgentSessions } from "./web-agent-sessions.ts";
import {
	cloneTool,
	cloneUIRequest,
	MAX_MESSAGE_CHARACTERS,
	type ManagedWebAgentSession,
	type PendingUIRequest,
	timestamp,
} from "./web-agent-support.ts";

export abstract class WebAgentPiEvents extends WebAgentSessions {
	protected handlePiEvent(session: ManagedWebAgentSession, event: AgentSessionEvent): void {
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
		if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
			const message = this.assistantMessage(session);
			const remaining = MAX_MESSAGE_CHARACTERS - (message.thinking?.length ?? 0);
			if (remaining <= 0) return;
			const delta = this.redact(event.assistantMessageEvent.delta).slice(0, remaining);
			message.thinking = (message.thinking ?? "") + delta;
			this.touch(session);
			this.emit(session, { type: "thinking_delta", messageId: message.id, delta });
			return;
		}
		if (event.type === "message_end") {
			const source = event.message as { role?: string };
			if (source.role !== "assistant") return;
			const message = this.assistantMessage(session);
			const projected = this.projectedAssistantText(event.message);
			if (projected.text || !message.content) message.content = projected.text;
			if (!message.thinking) message.thinking = this.projectedThinking(event.message);
			message.error = projected.error;
			message.status = projected.aborted ? "aborted" : projected.error ? "error" : "complete";
			if (projected.error && !projected.aborted) session.error = projected.error;
			else if (!projected.aborted) session.error = undefined;
			this.rememberToolMessageAnchors(session, message.id, event.message);
			session.activeAssistantMessageId = undefined;
			this.updateMessage(session, message);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.appendTool(session, {
				id: event.toolCallId,
				assistantMessageId:
					session.toolMessageAnchors.get(event.toolCallId) ??
					session.activeAssistantMessageId ??
					session.messages.filter((message) => message.role === "assistant").at(-1)?.id,
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

	private rememberToolMessageAnchors(session: ManagedWebAgentSession, messageId: string, value: unknown): void {
		if (!value || typeof value !== "object") return;
		const content = (value as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		for (const entry of content) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as { type?: unknown; id?: unknown; toolCallId?: unknown };
			if (item.type !== "toolCall" && item.type !== "tool_use") continue;
			const toolCallId = typeof item.id === "string" ? item.id : typeof item.toolCallId === "string" ? item.toolCallId : undefined;
			if (!toolCallId) continue;
			session.toolMessageAnchors.set(toolCallId, messageId);
			const tool = this.existingTool(session, toolCallId);
			if (tool) tool.assistantMessageId = messageId;
		}
	}

	protected settleUIRequest(
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

	protected rejectPendingUI(session: ManagedWebAgentSession): void {
		for (const [id, pending] of [...session.pendingUI]) {
			this.settleUIRequest(session, id, pending.view.type === "confirm" ? false : undefined);
		}
	}

	protected requestUI(
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

	protected uiContext(session: ManagedWebAgentSession): ExtensionUIContext {
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
}
