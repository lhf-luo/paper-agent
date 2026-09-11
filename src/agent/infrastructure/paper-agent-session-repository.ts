import { DatabaseSync } from "node:sqlite";
import type {
	WebAgentMessageView,
	WebAgentSessionContext,
	WebAgentToolView,
} from "../domain/web-agent-contracts.ts";

export interface PaperAgentSessionRecord {
	id: string;
	title: string;
	mode: "once" | "persistent";
	context: WebAgentSessionContext;
	createdAt: string;
	updatedAt: string;
	messages: WebAgentMessageView[];
	tools: WebAgentToolView[];
}

export class PaperAgentSessionRepository {
	private readonly database: DatabaseSync;

	constructor(databasePath: string) {
		this.database = new DatabaseSync(databasePath);
		this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000;");
		this.assertSchema();
	}

	private assertSchema(): void {
		const row = this.database
			.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'paper_agent_sessions'")
			.get() as { found: number } | undefined;
		if (!row) throw new Error("Personal SQLite schema is not initialized for paper Agent sessions");
	}

	hasPaper(context: WebAgentSessionContext): boolean {
		return Boolean(
			this.database
				.prepare("SELECT 1 FROM papers WHERE namespace_id = ? AND paper_id = ?")
				.get(context.namespace, context.paperId),
		);
	}

	restore(): PaperAgentSessionRecord[] {
		const sessions = this.database
			.prepare(`SELECT s.id, s.title, s.mode, s.created_at, s.updated_at,
				s.namespace_id, p.paper_id
			FROM paper_agent_sessions s
			JOIN papers p ON p.row_id = s.paper_row_id
			ORDER BY s.updated_at DESC`)
			.all() as unknown as Array<Record<string, string>>;
		return sessions.map((row) => ({
			id: row.id,
			title: row.title,
			mode: row.mode === "once" ? "once" : "persistent",
			context: { kind: "paper", namespace: row.namespace_id, paperId: row.paper_id },
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			messages: this.messages(row.id),
			tools: this.tools(row.id),
		}));
	}

	private messages(sessionId: string): WebAgentMessageView[] {
		return (
			this.database
				.prepare(`SELECT message_id, role, content, thinking, status, error, created_at
					FROM paper_agent_messages WHERE session_id = ? ORDER BY position`)
				.all(sessionId) as unknown as Array<Record<string, string | null>>
		).map((row) => ({
			id: String(row.message_id),
			role: row.role === "user" ? "user" : "assistant",
			content: String(row.content),
			thinking: row.thinking === null ? undefined : String(row.thinking),
			status: interruptedMessageStatus(String(row.status)),
			createdAt: String(row.created_at),
			error: row.error === null ? interruptedMessageError(String(row.status)) : String(row.error),
		}));
	}

	private tools(sessionId: string): WebAgentToolView[] {
		return (
			this.database
				.prepare(`SELECT tool_call_id, assistant_message_id, name, status, input, output,
					started_at, finished_at
					FROM paper_agent_tool_calls WHERE session_id = ? ORDER BY position`)
				.all(sessionId) as unknown as Array<Record<string, string | null>>
		).map((row) => ({
			id: String(row.tool_call_id),
			assistantMessageId: row.assistant_message_id === null ? undefined : String(row.assistant_message_id),
			name: String(row.name),
			status: row.status === "running" ? "failed" : (row.status as "succeeded" | "failed"),
			input: row.input === null ? undefined : String(row.input),
			output:
				row.status === "running" && row.output === null
					? "Paper Agent 上次关闭时此工具仍在运行。"
					: row.output === null
						? undefined
						: String(row.output),
			startedAt: String(row.started_at),
			finishedAt: row.finished_at === null ? undefined : String(row.finished_at),
		}));
	}

	save(view: PaperAgentSessionRecord): void {
		const paper = this.database
			.prepare("SELECT row_id FROM papers WHERE namespace_id = ? AND paper_id = ?")
			.get(view.context.namespace, view.context.paperId) as { row_id: number } | undefined;
		if (!paper) throw new Error(`Personal paper not found: ${view.context.namespace}/${view.context.paperId}`);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database
				.prepare(`INSERT INTO paper_agent_sessions(
					id, namespace_id, paper_row_id, title, mode, created_at, updated_at, last_opened_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title=excluded.title, mode=excluded.mode,
					updated_at=excluded.updated_at, last_opened_at=excluded.last_opened_at`)
				.run(
					view.id,
					view.context.namespace,
					paper.row_id,
					view.title,
					view.mode,
					view.createdAt,
					view.updatedAt,
					view.updatedAt,
				);
			this.database.prepare("DELETE FROM paper_agent_tool_calls WHERE session_id = ?").run(view.id);
			this.database.prepare("DELETE FROM paper_agent_messages WHERE session_id = ?").run(view.id);
			const insertMessage = this.database.prepare(`INSERT INTO paper_agent_messages(
				session_id, message_id, position, role, content, thinking, status, error, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			view.messages.forEach((message, position) => {
				insertMessage.run(
					view.id,
					message.id,
					position,
					message.role,
					message.content,
					message.thinking ?? null,
					message.status,
					message.error ?? null,
					message.createdAt,
				);
			});
			const messageIds = new Set(view.messages.map((message) => message.id));
			const insertTool = this.database.prepare(`INSERT INTO paper_agent_tool_calls(
				session_id, tool_call_id, assistant_message_id, position, name, status,
				input, output, started_at, finished_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			view.tools.forEach((tool, position) => {
				insertTool.run(
					view.id,
					tool.id,
					tool.assistantMessageId && messageIds.has(tool.assistantMessageId) ? tool.assistantMessageId : null,
					position,
					tool.name,
					tool.status,
					tool.input ?? null,
					tool.output ?? null,
					tool.startedAt,
					tool.finishedAt ?? null,
				);
			});
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	deleteSession(sessionId: string): void {
		this.database.prepare("DELETE FROM paper_agent_sessions WHERE id = ?").run(sessionId);
	}

	pendingCleanupIds(): string[] {
		return (
			this.database
				.prepare("SELECT session_id FROM paper_agent_session_cleanup ORDER BY requested_at LIMIT 100")
				.all() as unknown as Array<{ session_id: string }>
		).map((row) => row.session_id);
	}

	completeCleanup(sessionId: string): void {
		this.database.prepare("DELETE FROM paper_agent_session_cleanup WHERE session_id = ?").run(sessionId);
	}

	close(): void {
		this.database.close();
	}
}

function interruptedMessageStatus(status: string): WebAgentMessageView["status"] {
	if (status === "streaming") return "aborted";
	if (status === "complete" || status === "error" || status === "aborted") return status;
	return "error";
}

function interruptedMessageError(status: string): string | undefined {
	return status === "streaming" ? "Paper Agent 上次关闭时此回复尚未完成。" : undefined;
}
