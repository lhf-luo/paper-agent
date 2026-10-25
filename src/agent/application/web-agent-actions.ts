import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type WebAgentAttachment,
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

import { WebAgentInputs } from "./web-agent-inputs.ts";
import type { ManagedWebAgentSession } from "./web-agent-support.ts";

export class WebAgentActions extends WebAgentInputs {
	private paperCleanupTimer?: ReturnType<typeof setInterval>;
	private paperCleanupRunning?: Promise<void>;

	async startPaperSessionCleanup(): Promise<void> {
		void this.cleanupDeletedPaperSessions();
		await this.cleanupOrphanCanvasSessions();
		for (const session of this.sessions.values()) this.canvasResearchFor(session)?.finish("interrupted");
		this.paperCleanupTimer = setInterval(() => void this.cleanupDeletedPaperSessions(), 1_000);
		this.paperCleanupTimer.unref?.();
	}

	private async cleanupOrphanCanvasSessions(): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			if (session.context?.kind === "canvas" && !this.sessionStore.hasCanvas(session.context)) {
				await this.deleteSession(session.id);
			}
		}
	}

	async deleteCanvasSessions(canvasId: string): Promise<void> {
		for (const session of this.listSessions({ scope: "canvas", canvasId })) {
			await this.deleteSession(session.id);
		}
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
		return this.serialInput(this.managedSession(id), () => this.stopSession(id));
	}

	private async stopSession(id: string): Promise<WebAgentSessionSnapshot> {
		this.assertOpen();
		const session = this.managedSession(id);
		if (!session.runPromise || !session.pi) return this.snapshot(session);
		session.abortRequested = true;
		this.queueFor(session).pause(session.pi);
		session.status = "stopping";
		this.rejectPendingUI(session);
		this.touch(session);
		this.emitSession(session);
		try {
			await session.pi.abort();
			await session.runPromise;
			await this.sessionStore.inputs.flush(id);
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
		this.queueFor(session).pause(session.pi);
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
		await this.mcp.close();
		this.sessionStore.close();
		this.memoryApiKey = undefined;
	}
}
