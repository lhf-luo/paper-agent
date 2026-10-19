import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyWebAgentInputs, type WebAgentInputState } from "../domain/web-agent-inputs.ts";

export class WebAgentInputStore {
	private readonly directory: string;
	private readonly writes = new Map<string, Promise<void>>();
	constructor(root: string) {
		this.directory = join(root, ".paper-agent", "web-agent-memory", "input-queues");
	}

	write(id: string, state: WebAgentInputState): Promise<void> {
		const content = JSON.stringify(state);
		const previous = this.writes.get(id) ?? Promise.resolve();
		const writing = previous
			.catch(() => undefined)
			.then(async () => {
				await mkdir(this.directory, { recursive: true });
				const path = join(this.directory, `${id}.json`);
				const temporary = `${path}.tmp`;
				try {
					await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
					await rename(temporary, path);
				} finally {
					await rm(temporary, { force: true }).catch(() => undefined);
				}
			});
		this.writes.set(id, writing);
		return writing;
	}

	async restore(id: string, piFile?: string): Promise<WebAgentInputState> {
		let state: WebAgentInputState;
		try {
			state = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWebAgentInputs();
			throw new Error(`无法恢复会话 ${id} 的待发消息，请检查 input-queues 文件`, { cause: error });
		}
		if (!state.pending.length) {
			state.paused = false;
			return state;
		}
		const entries = await this.entries(piFile);
		const delivered = new Set(
			entries
				.filter((e) => e.type === "custom" && e.customType === "paper-agent-web-input")
				.filter((e) =>
					entries.some(
						(m) => m.id === e.data?.messageEntryId && m.type === "message" && m.message?.role === "user",
					),
				)
				.map((e) => e.data?.id),
		);
		state.recovered = state.pending.filter((p) => delivered.has(p.id));
		for (const input of state.recovered) {
			const receipt = entries.find(
				(e) => e.type === "custom" && e.customType === "paper-agent-web-input" && e.data?.id === input.id,
			);
			const message = entries.find((e) => e.id === receipt?.data?.messageEntryId)?.message;
			if (message?.timestamp) input.deliveredAt = new Date(message.timestamp).toISOString();
		}
		state.pending = state.pending.filter((p) => !delivered.has(p.id));
		for (const input of state.pending) {
			const possibleDelivery =
				input.phase === "dispatching" ||
				input.phase === "delivering" ||
				(input.phase !== "paused" &&
					input.phase !== "prepared" &&
					entries.some(
						(e) =>
							e.type === "message" &&
							e.message?.role === "user" &&
							Number(e.message.timestamp) >= Date.parse(input.createdAt) &&
							JSON.stringify(e.message.content).includes(
								JSON.stringify(input.nativeText ?? input.prompt).slice(1, -1),
							),
					));
			input.status = input.phase === "uncertain" || possibleDelivery ? "uncertain" : "paused";
			input.phase = input.status;
		}
		state.paused = state.pending.length > 0;
		return state;
	}

	private async entries(path?: string): Promise<Array<any>> {
		if (!path) return [];
		const text = await readFile(path, "utf8").catch(() => "");
		return text.split("\n").flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
	}

	async flush(id?: string): Promise<void> {
		if (id) {
			let writing: Promise<void> | undefined;
			do {
				writing = this.writes.get(id);
				await writing;
			} while (writing !== this.writes.get(id));
		} else await Promise.all([...this.writes.keys()].map((key) => this.flush(key)));
	}

	async delete(id: string): Promise<void> {
		await this.flush(id);
		this.writes.delete(id);
		await rm(join(this.directory, `${id}.json`), { force: true });
	}
}
