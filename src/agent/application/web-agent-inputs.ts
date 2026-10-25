import { createHash, randomUUID } from "node:crypto";
import { canvasExcludedSkills } from "../domain/session-skills.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	type WebAgentAttachmentRef,
	type WebAgentPaperMessageContext,
	WebAgentServiceError,
	type WebAgentSessionSnapshot,
} from "../domain/web-agent-contracts.ts";
import type { StoredWebAgentInput, WebAgentDelivery } from "../domain/web-agent-inputs.ts";
import { WebAgentRuntime } from "./web-agent-runtime.ts";
import { type ManagedWebAgentSession, timestamp } from "./web-agent-support.ts";

export interface WebAgentSendInput {
	message: string;
	attachments?: WebAgentAttachmentRef[];
	paperContext?: WebAgentPaperMessageContext;
	canvasContext?: { agentNodeId?: string; selectedNodeIds?: string[] };
	delivery?: WebAgentDelivery;
	clientMessageId?: string;
}

export abstract class WebAgentInputs extends WebAgentRuntime {
	protected serialInput<T>(session: ManagedWebAgentSession, action: () => Promise<T>): Promise<T> {
		const operation = (session.inputOperation ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => {
				this.assertOpen();
				if (!this.sessions.has(session.id)) throw new WebAgentServiceError(404, "会话不存在");
				return action();
			});
		session.inputOperation = operation.catch(() => undefined);
		return operation;
	}

	async sendMessage(id: string, input: WebAgentSendInput): Promise<WebAgentSessionSnapshot> {
		return this.serialInput(this.managedSession(id), () => this.submitInput(this.managedSession(id), input));
	}

	private async submitInput(
		session: ManagedWebAgentSession,
		input: WebAgentSendInput,
	): Promise<WebAgentSessionSnapshot> {
		this.validateInput(session, input);
		const id = input.clientMessageId ?? randomUUID();
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					...input,
					clientMessageId: undefined,
					message: input.message.trim(),
					delivery: input.delivery ?? "steer",
				}),
			)
			.digest("hex");
		if (Object.hasOwn(session.inputState.receipts, id)) {
			if (session.inputState.receipts[id] !== fingerprint)
				throw new WebAgentServiceError(409, "消息标识已用于其他内容，请重新发送");
			return this.snapshot(session);
		}
		if (session.runPromise && session.pi?.isIdle && !session.startingRun) await session.runPromise;
		const continuing = Boolean(session.runPromise || session.inputState.paused);
		const prompt = await this.prepareInput(session, input, continuing);
		const pi = continuing ? session.pi : await this.readyPi(session);
		const record: StoredWebAgentInput = {
			id,
			delivery: input.delivery ?? "steer",
			content: this.redact(input.message.trim()),
			prompt: this.redact(prompt),
			attachmentNames: input.attachments?.map((a) => this.redact(a.name)),
			createdAt: timestamp(),
			status: session.inputState.paused ? "paused" : "queued",
			phase: session.inputState.paused ? "paused" : session.runPromise ? "prepared" : "dispatching",
		};
		await this.queueFor(session).accept(record, fingerprint);
		if (session.inputState.paused) return this.snapshot(session);
		if (session.runPromise && pi) {
			try {
				await this.queueFor(session).enqueue(pi, record);
			} catch (error) {
				this.queueFor(session).pause(pi);
				throw error;
			}
		} else {
			try {
				await this.startInput(session, pi ?? (await this.readyPi(session)), record);
			} catch (error) {
				this.queueFor(session).pause(pi);
				session.status = "error";
				session.error = this.redact(error);
				this.emitSession(session);
				throw error;
			}
		}
		return this.snapshot(session);
	}

	private validateInput(session: ManagedWebAgentSession, input: WebAgentSendInput): void {
		const skill = /^\/skill:([^\s]+)/.exec(input.message?.trim() ?? "")?.[1];
		if (session.context?.kind === "canvas" && skill && canvasExcludedSkills.includes(skill))
			throw new WebAgentServiceError(
				400,
				"画布检索请使用 canvas-research；此会话不加载 literature-corpus-manager。",
			);
		if (!input.message?.trim() || input.message.trim().length > 20_000)
			throw new WebAgentServiceError(400, "消息必须包含 1-20000 个字符");
		if (input.delivery !== undefined && input.delivery !== "steer" && input.delivery !== "followUp")
			throw new WebAgentServiceError(400, "无效的发送方式");
		if (input.clientMessageId !== undefined && !/^[a-f0-9-]{36}$/i.test(input.clientMessageId))
			throw new WebAgentServiceError(400, "clientMessageId 必须为 UUID");
		if ((input.attachments?.length ?? 0) > 10) throw new WebAgentServiceError(400, "单条消息最多发送 10 个附件");
		if (
			input.paperContext &&
			(session.context?.kind !== "paper" || input.paperContext.paperId !== session.context.paperId)
		)
			throw new WebAgentServiceError(400, "当前阅读论文与 Agent 会话绑定的论文不一致");
		if (input.canvasContext && session.context?.kind !== "canvas")
			throw new WebAgentServiceError(400, "画布上下文只能用于画布会话");
	}

	private async prepareInput(
		session: ManagedWebAgentSession,
		input: WebAgentSendInput,
		continuing: boolean,
	): Promise<string> {
		let text = input.message.trim();
		if (input.attachments?.length)
			text += `\n\n[附件]\n${input.attachments.map((a) => `- ${a.name} (${a.path})`).join("\n")}`;
		const reading = input.paperContext;
		const paperHeader =
			session.context?.kind === "paper"
				? [
						"[当前阅读论文]",
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
		const canvasHeader = await this.canvasResearchFor(session)?.prepare(input.canvasContext, {
			continueRound: continuing,
		});
		// Keep /skill at the beginning so Pi can expand it natively.
		return [text, canvasHeader, paperHeader].filter(Boolean).join("\n\n");
	}

	private async readyPi(session: ManagedWebAgentSession): Promise<AgentSession> {
		if (this.piModels) await this.reloadConfiguredModels();
		return this.ensurePiSession(session, this.configRevision);
	}

	private async startInput(
		session: ManagedWebAgentSession,
		pi: AgentSession,
		input: StoredWebAgentInput,
	): Promise<void> {
		session.error = undefined;
		session.status = "running";
		session.abortRequested = false;
		await this.queueFor(session).begin(input);
		this.emitSession(session);
		session.startingRun = true;
		session.runPromise = this.runPrompt(session, pi, input.prompt, {
			preflightResult: (result) => {
				session.startingRun = false;
				if (result === "handled") this.queueFor(session).handled(input);
				if (result === "started" && session.abortRequested) void pi.abort();
			},
		});
	}

	async resumeQueue(id: string): Promise<WebAgentSessionSnapshot> {
		const session = this.managedSession(id);
		return this.serialInput(session, async () => {
			if (session.runPromise) throw new WebAgentServiceError(409, "请等待当前运行停止后再继续待发消息");
			if (session.inputState.pending.some((p) => p.status === "uncertain"))
				throw new WebAgentServiceError(409, "部分消息送达状态待确认，请核对历史后清空待发并重新提交，避免重复执行");
			if (!session.inputState.pending.length) return this.snapshot(session);
			if (session.mode === "once" && !session.pi)
				this.emit(session, {
					type: "notice",
					level: "warning",
					message: "一次性会话的原运行上下文已关闭，将在新的上下文中处理待发任务。",
				});
			session.inputState.paused = false;
			for (const item of session.inputState.pending) {
				item.phase = "prepared";
				item.status = "queued";
			}
			try {
				await this.drainInputs(session);
			} catch (error) {
				this.queueFor(session).pause(session.pi);
				throw error;
			}
			await this.sessionStore.inputs.flush(session.id);
			return this.snapshot(session);
		});
	}

	private async drainInputs(session: ManagedWebAgentSession): Promise<void> {
		const queue = this.queueFor(session);
		if (session.inputState.paused || session.runPromise) return;
		const items = queue.ordered();
		if (!items.length) return;
		const pi = await this.readyPi(session);
		queue.detach(pi);
		await this.startInput(session, pi, items[0]);
		for (const item of items.slice(1)) {
			if (session.runPromise && !pi.isIdle) await queue.enqueue(pi, item);
		}
	}

	async clearQueue(id: string): Promise<WebAgentSessionSnapshot> {
		const session = this.managedSession(id);
		return this.serialInput(session, async () => {
			this.queueFor(session).clear(session.pi);
			if (session.mode === "once" && !session.runPromise) this.disposePiSession(session);
			await this.sessionStore.inputs.flush(id);
			return this.snapshot(session);
		});
	}

	protected override onRunFinished(session: ManagedWebAgentSession): void {
		if (session.inputState.paused || !session.inputState.pending.some((p) => p.phase !== "delivering")) return;
		void this.serialInput(session, () => this.drainInputs(session)).catch((error) => {
			this.queueFor(session).pause(session.pi);
			this.emit(session, { type: "notice", level: "error", message: this.redact(error) });
		});
	}
}
