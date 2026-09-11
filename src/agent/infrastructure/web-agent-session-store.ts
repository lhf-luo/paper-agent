import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	WebAgentMessageView,
	WebAgentMode,
	WebAgentSessionContext,
	WebAgentToolView,
} from "../domain/web-agent-contracts.ts";
import { PaperAgentSessionRepository } from "./paper-agent-session-repository.ts";

export interface PersistedSessionView {
	id: string;
	title: string;
	mode: WebAgentMode;
	context?: WebAgentSessionContext;
	createdAt: string;
	updatedAt: string;
	error?: string;
	messages: WebAgentMessageView[];
	tools: WebAgentToolView[];
}

interface PersistedViewWriteState {
	latest?: PersistedSessionView;
	running?: Promise<void>;
}

export class WebAgentSessionStore {
	readonly piSessionDir: string;
	readonly sessionViewDir: string;
	private readonly resultsDir: string;
	private readonly uploadsDir: string;
	private readonly paperSessions?: PaperAgentSessionRepository;
	private readonly writes = new Map<string, PersistedViewWriteState>();

	constructor(projectRoot: string, paperSessionDatabasePath?: string) {
		this.piSessionDir = join(projectRoot, ".paper-agent", "web-agent-memory", "pi-sessions");
		this.sessionViewDir = join(projectRoot, ".paper-agent", "web-agent-memory", "session-views");
		this.resultsDir = join(projectRoot, ".paper-agent", "web-agent-memory", "results");
		this.uploadsDir = join(projectRoot, ".paper-agent", "web-agent-memory", "uploads");
		this.paperSessions = paperSessionDatabasePath
			? new PaperAgentSessionRepository(paperSessionDatabasePath)
			: undefined;
		mkdirSync(this.piSessionDir, { recursive: true });
		mkdirSync(this.sessionViewDir, { recursive: true });
	}

	async restore(): Promise<PersistedSessionView[]> {
		const views = new Map<string, PersistedSessionView>(
			(this.paperSessions?.restore() ?? []).map((view) => [view.id, view]),
		);
		let files: string[] = [];
		try {
			files = await readdir(this.sessionViewDir);
		} catch {
			return [...views.values()];
		}
		for (const file of files.filter((name) => name.endsWith(".json"))) {
			try {
				const view = JSON.parse(await readFile(join(this.sessionViewDir, file), "utf8")) as PersistedSessionView;
				if (!view.id || !Array.isArray(view.messages)) continue;
				if (view.context?.kind === "paper" && this.paperSessions) {
					if (this.paperSessions.hasPaper(view.context)) {
						this.paperSessions.save({ ...view, context: view.context });
						views.set(view.id, view);
					} else {
						await this.deleteRuntimeFiles(view.id);
					}
					await rm(join(this.sessionViewDir, file), { force: true });
				} else {
					views.set(view.id, view);
				}
			} catch {
				// Ignore one corrupt snapshot without preventing other sessions from loading.
			}
		}
		return [...views.values()];
	}

	persist(view: PersistedSessionView): void {
		let state = this.writes.get(view.id);
		if (!state) {
			state = {};
			this.writes.set(view.id, state);
		}
		state.latest = view;
		if (state.running) return;
		state.running = this.writePending(view.id, state);
	}

	private async writePending(sessionId: string, state: PersistedViewWriteState): Promise<void> {
		try {
			while (state.latest) {
				const view = state.latest;
				state.latest = undefined;
				await this.write(view);
			}
		} catch (error) {
			console.error(`Failed to persist Web Agent session ${sessionId}:`, error);
		} finally {
			state.running = undefined;
			if (!state.latest && this.writes.get(sessionId) === state) this.writes.delete(sessionId);
		}
	}

	private async write(view: PersistedSessionView): Promise<void> {
		if (view.context?.kind === "paper" && this.paperSessions) {
			this.paperSessions.save({ ...view, context: view.context });
			return;
		}
		const target = join(this.sessionViewDir, `${view.id}.json`);
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(view), { encoding: "utf8", mode: 0o600 });
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async flush(sessionId?: string): Promise<void> {
		if (sessionId) {
			while (this.writes.get(sessionId)?.running) await this.writes.get(sessionId)?.running;
			return;
		}
		await Promise.all([...this.writes.keys()].map((id) => this.flush(id)));
	}

	async findPiSessionFile(sessionId: string): Promise<string | undefined> {
		try {
			const match = (await readdir(this.piSessionDir)).find((file) => file.endsWith(`_${sessionId}.jsonl`));
			return match ? join(this.piSessionDir, match) : undefined;
		} catch {
			return undefined;
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.flush(sessionId);
		this.paperSessions?.deleteSession(sessionId);
		await rm(join(this.sessionViewDir, `${sessionId}.json`), { force: true }).catch(() => undefined);
		await this.deleteRuntimeFiles(sessionId);
		this.paperSessions?.completeCleanup(sessionId);
	}

	hasPaper(context: WebAgentSessionContext): boolean {
		return this.paperSessions?.hasPaper(context) ?? true;
	}

	pendingPaperCleanupIds(): string[] {
		return this.paperSessions?.pendingCleanupIds() ?? [];
	}

	async cleanupDeletedPaperSession(sessionId: string): Promise<void> {
		await this.flush(sessionId);
		await rm(join(this.sessionViewDir, `${sessionId}.json`), { force: true }).catch(() => undefined);
		await this.deleteRuntimeFiles(sessionId);
		this.paperSessions?.completeCleanup(sessionId);
	}

	private async deleteRuntimeFiles(sessionId: string): Promise<void> {
		const piFile = await this.findPiSessionFile(sessionId);
		if (piFile) await rm(piFile, { force: true }).catch(() => undefined);
		await this.deleteResultDocuments(sessionId);
		await rm(join(this.uploadsDir, sessionId), { recursive: true, force: true }).catch(() => undefined);
	}

	private async deleteResultDocuments(sessionId: string): Promise<void> {
		const safeSessionId = sessionId.replace(/[^A-Za-z0-9-]/g, "_");
		try {
			const files = await readdir(this.resultsDir);
			await Promise.all(
				files
					.filter((name) => name.startsWith(`${safeSessionId}-`) && name.endsWith(".md"))
					.map((name) => rm(join(this.resultsDir, name), { force: true }).catch(() => undefined)),
			);
		} catch {
			// A missing or unreadable results directory does not block session deletion.
		}
	}

	close(): void {
		this.paperSessions?.close();
	}
}
