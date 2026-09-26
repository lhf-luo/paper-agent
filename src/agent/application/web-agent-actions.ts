import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type WebAgentAttachment,
	type WebAgentAttachmentRef,
	type WebAgentMessageView,
	type WebAgentPaperMessageContext,
	WebAgentServiceError,
	type WebAgentSessionSnapshot,
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

import { WebAgentRuntime } from "./web-agent-runtime.ts";
import { type ManagedWebAgentSession, timestamp } from "./web-agent-support.ts";

export class WebAgentActions extends WebAgentRuntime {
	private paperCleanupTimer?: ReturnType<typeof setInterval>;
	private paperCleanupRunning?: Promise<void>;

	startPaperSessionCleanup(): void {
		void this.cleanupDeletedPaperSessions();
		this.paperCleanupTimer = setInterval(() => void this.cleanupDeletedPaperSessions(), 1_000);
		this.paperCleanupTimer.unref?.();
	}

	private async cleanupDeletedPaperSessions(): Promise<void> {
		if (this.paperCleanupRunning) return this.paperCleanupRunning;
		this.paperCleanupRunning = (async () => {
			for (const id of this.sessionStore.pendingPaperCleanupIds()) {
				const session = this.sessions.get(id);
				if (session) {
					this.sessions.delete(id);
					await this.disposeManagedSession(session);
				}
				await this.sessionStore.cleanupDeletedPaperSession(id);
			}
		})().finally(() => {
			this.paperCleanupRunning = undefined;
		});
		return this.paperCleanupRunning;
	}
	async sendMessage(
		id: string,
		input: { message: string; attachments?: WebAgentAttachmentRef[]; paperContext?: WebAgentPaperMessageContext },
	): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (session.runPromise) throw new WebAgentServiceError(409, "该 Agent 会话正在生成，请先停止或等待完成");
		const message = input.message?.trim();
		if (!message || message.length > 20_000) {
			throw new WebAgentServiceError(400, "消息必须包含 1-20000 个字符");
		}
		const attachments = (input.attachments ?? []).slice(0, 10);
		const reading = input.paperContext;
		if (
			reading &&
			(session.context?.kind !== "paper" ||
				reading.namespace !== session.context.namespace ||
				reading.paperId !== session.context.paperId)
		) {
			throw new WebAgentServiceError(400, "当前阅读论文与 Agent 会话绑定的论文不一致");
		}
		let text = message;
		if (attachments.length > 0) {
			const lines = attachments.map((attachment) => `- ${attachment.name} (${attachment.path})`).join("\n");
			text += `\n\n[附件]\n${lines}`;
		}
		const paperHeader =
			session.context?.kind === "paper"
				? [
						"[当前阅读论文]",
						`namespace: ${JSON.stringify(session.context.namespace)}`,
						`paper_id: ${JSON.stringify(session.context.paperId)}`,
						...(reading
							? [
									`title: ${JSON.stringify(reading.title)}`,
									`current_pdf_path: ${JSON.stringify(reading.pdfPath)}`,
									...(reading.pdfSha256 ? [`current_pdf_sha256: ${reading.pdfSha256}`] : []),
								]
							: []),
						"用户说“这篇论文”时默认指此论文；若用户明确指定其他来源，以用户要求为准。PDF 路径仅用于按需读取，不表示已阅读其内容。",
					].join("\n")
				: undefined;
		const promptText = paperHeader ? `${paperHeader}\n\n${text}` : text;
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
		const safePrompt = this.redact(promptText);
		const userMessage: WebAgentMessageView = {
			id: randomUUID(),
			role: "user",
			content: safeMessage,
			...(attachments.length
				? { attachmentNames: attachments.map((attachment) => this.redact(attachment.name)) }
				: {}),
			status: "complete",
			createdAt: timestamp(),
		};
		this.appendMessage(session, userMessage);
		this.emitSession(session);
		session.runPromise = this.runPrompt(session, pi, safePrompt);
		return this.snapshot(session);
	}

	async uploadAttachment(id: string, input: { name: string; data: Uint8Array }): Promise<WebAgentAttachment> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (input.data.byteLength > 50 * 1024 * 1024) {
			throw new WebAgentServiceError(400, "附件不能超过 50MB");
		}
		const safeName =
			input.name
				.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
				.replace(/\s+/g, "_")
				.slice(0, 120) || "attachment";
		const dir = join(this.projectRoot, ".paper-agent", "web-agent-memory", "uploads", session.id);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${randomUUID().slice(0, 8)}-${safeName}`);
		await writeFile(path, input.data);
		return { path, name: safeName, size: input.data.byteLength };
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

	async dismissError(id: string): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		session.error = undefined;
		if (session.status === "error") session.status = "idle";
		this.touch(session);
		this.emitSession(session);
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

	protected async disposeManagedSession(session: ManagedWebAgentSession): Promise<void> {
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
		await this.sessionStore.deleteSession(id);
	}

	protected async destroyAllSessions(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => this.disposeManagedSession(session)));
		await this.sessionStore.flush();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (this.paperCleanupTimer) clearInterval(this.paperCleanupTimer);
		await this.paperCleanupRunning;
		this.closed = true;
		this.configRevision += 1;
		await this.destroyAllSessions();
		this.sessionStore.close();
		this.memoryApiKey = undefined;
	}
}
