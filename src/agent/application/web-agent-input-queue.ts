import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WebAgentMessageView } from "../domain/web-agent-contracts.ts";
import type {
	StoredWebAgentInput,
	WebAgentDelivery,
	WebAgentInputState,
	WebAgentPendingInput,
} from "../domain/web-agent-inputs.ts";

interface QueueHost {
	persist(state: WebAgentInputState): Promise<void>;
	changed(): void;
	delivered(message: WebAgentMessageView): void;
	notice(message: string): void;
}

/** Projects Pi's native queues; it does not schedule model/tool turns. */
export class WebAgentInputQueue {
	private nativeIds: Record<WebAgentDelivery, string[]> = { steer: [], followUp: [] };
	private consuming: string[] = [];
	private starting?: string;
	private enqueueing?: string;
	private clearing = false;
	private readonly userMessages = new Map<unknown, StoredWebAgentInput>();
	readonly state: WebAgentInputState;
	private readonly host: QueueHost;
	constructor(state: WebAgentInputState, host: QueueHost) {
		this.state = state;
		this.host = host;
	}

	view(): WebAgentPendingInput[] {
		return this.state.pending
			.filter((p) => p.phase !== "delivering")
			.map((p) => ({
				id: p.id,
				delivery: p.delivery,
				content: p.content,
				attachmentNames: p.attachmentNames,
				createdAt: p.createdAt,
				status: p.status,
			}));
	}

	async accept(input: StoredWebAgentInput, fingerprint: string): Promise<void> {
		this.state.receipts[input.id] = fingerprint;
		this.state.pending.push(input);
		try {
			await this.host.persist(this.state);
		} catch (error) {
			this.state.pending = this.state.pending.filter((p) => p !== input);
			delete this.state.receipts[input.id];
			throw error;
		}
		this.host.changed();
	}

	begin(input: StoredWebAgentInput): void {
		this.starting = input.id;
		input.phase = "dispatching";
		this.save();
	}

	async enqueue(pi: AgentSession, input: StoredWebAgentInput): Promise<void> {
		this.enqueueing = input.id;
		input.phase = "dispatching";
		await this.host.persist(this.state);
		try {
			const result = await (input.delivery === "steer"
				? pi.steer(input.prompt, undefined, { source: "rpc" })
				: pi.followUp(input.prompt, undefined, { source: "rpc" }));
			if (result === "handled") this.handled(input);
		} catch (error) {
			input.phase = "paused";
			input.status = "paused";
			this.state.paused = true;
			this.save();
			throw error;
		} finally {
			this.enqueueing = undefined;
		}
	}

	handled(input: StoredWebAgentInput): void {
		this.state.pending = this.state.pending.filter((p) => p !== input);
		if (this.starting === input.id) this.starting = undefined;
		this.host.notice("消息已由扩展处理，未加入模型待发队列。");
		this.save();
	}

	pause(pi?: AgentSession): void {
		this.state.paused = this.state.pending.some((p) => p.phase !== "delivering");
		this.detach(pi);
		for (const input of this.state.pending) {
			if (input.phase === "delivering" || input.phase === "uncertain") continue;
			input.status = "paused";
			input.phase = "paused";
		}
		this.save();
	}

	detach(pi?: AgentSession): void {
		this.clearing = true;
		try {
			pi?.clearQueue();
		} finally {
			this.clearing = false;
			this.nativeIds = { steer: [], followUp: [] };
			this.consuming = [];
		}
	}

	clear(pi?: AgentSession): void {
		this.detach(pi);
		this.state.pending = this.state.pending.filter((p) => p.phase === "delivering");
		this.state.paused = false;
		this.starting = undefined;
		this.save();
	}

	ordered(): StoredWebAgentInput[] {
		return [...this.state.pending.filter((p) => p.phase !== "delivering")].sort(
			(a, b) => Number(a.delivery === "followUp") - Number(b.delivery === "followUp"),
		);
	}

	onEvent(pi: AgentSession | undefined, event: AgentSessionEvent): void {
		if (event.type === "queue_update") {
			this.updateNative("steer", event.steering);
			this.updateNative("followUp", event.followUp);
			this.save();
		}
		if (event.type === "message_start" && event.message.role === "user") {
			this.consume(event.message);
		}
		if (event.type === "message_end" && event.message.role === "user") {
			const input = this.userMessages.get(event.message);
			if (!input || !pi) return;
			this.userMessages.delete(event.message);
			// Pi persists the native message synchronously after notifying listeners.
			queueMicrotask(() => this.acknowledge(pi, input, event.message));
		}
	}

	private updateNative(delivery: WebAgentDelivery, texts: readonly string[]): void {
		if (this.clearing) return;
		const ids = this.nativeIds[delivery];
		while (ids.length > texts.length) {
			const id = ids.shift();
			if (id) this.consuming.push(id);
		}
		if (texts.length > ids.length && this.enqueueing) {
			const input = this.state.pending.find((p) => p.id === this.enqueueing);
			if (input?.delivery === delivery) {
				ids.push(input.id);
				input.nativeText = texts.at(-1);
				input.phase = "queued";
			}
		}
	}

	private consume(message: unknown): void {
		const id = this.consuming.shift() ?? this.starting;
		const input = this.state.pending.find((p) => p.id === id);
		if (!input) return;
		if (id === this.starting) this.starting = undefined;
		input.phase = "delivering";
		input.deliveredAt = new Date().toISOString();
		this.userMessages.set(message, input);
		this.host.delivered({
			id: input.id,
			role: "user",
			content: input.content,
			attachmentNames: input.attachmentNames,
			createdAt: input.createdAt,
			status: "complete",
		});
		this.save();
	}

	private acknowledge(pi: AgentSession, input: StoredWebAgentInput, message: unknown): void {
		try {
			const entry = pi.sessionManager.getEntries().findLast((e) => e.type === "message" && e.message === message);
			if (entry)
				pi.sessionManager.appendCustomEntry("paper-agent-web-input", { id: input.id, messageEntryId: entry.id });
			this.state.pending = this.state.pending.filter((p) => p !== input);
			this.save();
		} catch {
			this.host.notice("消息已送达，但投递记录保存失败；重启后请核对聊天记录。");
		}
	}

	private save(): void {
		this.host.changed();
		void this.host.persist(this.state).catch(() => this.host.notice("待发消息保存失败，请检查磁盘后重试。"));
	}
}
