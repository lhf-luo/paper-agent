import { randomUUID } from "node:crypto";
import type { McpControl, McpServerConfig, McpServerState, McpView } from "../domain/mcp.ts";
import { McpError, redactMcpConfig } from "../domain/mcp.ts";
import { McpConfigStore, mcpFingerprint } from "../infrastructure/mcp-config-store.ts";
import { McpConnection, type McpRemoteTool } from "../infrastructure/mcp-connection.ts";

interface ConnectionEntry {
	sessionId: string;
	serverId: string;
	configHash: string;
	connection: McpConnection;
}
export interface McpSessionTool {
	serverId: string;
	remote: McpRemoteTool;
	call(args: Record<string, unknown>, signal?: AbortSignal): ReturnType<McpConnection["call"]>;
}

export class McpService implements McpControl {
	readonly configStore: McpConfigStore;
	private readonly entries = new Map<string, ConnectionEntry>();
	private readonly checks = new Map<string, McpServerState & { configHash: string }>();
	private readonly closing = new Set<Promise<void>>();
	private epoch = 0;
	private closed = false;
	readonly projectRoot: string;
	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.configStore = new McpConfigStore(projectRoot);
	}
	async revision(): Promise<string> {
		return `${(await this.configStore.read()).version}:${this.epoch}`;
	}
	async view(): Promise<McpView> {
		const { config, version } = await this.configStore.read();
		return {
			config: redactMcpConfig(config),
			version,
			configPath: this.configStore.path,
			servers: Object.entries(config.mcpServers).map(([id, server]) => this.state(id, server)),
		};
	}
	private state(id: string, config: McpServerConfig): McpServerState {
		const entries = [...this.entries.values()].filter(
			(e) => e.serverId === id && e.configHash === mcpFingerprint(config) && !e.connection.closed,
		);
		const check = this.checks.get(id);
		const cached = check?.configHash === mcpFingerprint(config) ? check : undefined;
		return {
			id,
			status: config.disabled ? "disabled" : entries.length ? "ready" : (cached?.status ?? "disconnected"),
			toolNames: entries[0]?.connection.tools.map((t) => t.name) ?? cached?.toolNames ?? [],
			connectionCount: entries.length,
			error: cached?.error,
			checkedAt: cached?.checkedAt,
		};
	}
	async save(config: unknown, expectedVersion: string): Promise<McpView> {
		this.assertOpen();
		await this.configStore.save(config, expectedVersion);
		return this.view();
	}
	private assertOpen(): void {
		if (this.closed) throw new McpError(503, "MCP 服务已关闭");
	}
	private async open(sessionId: string, id: string, config: McpServerConfig): Promise<ConnectionEntry> {
		this.assertOpen();
		const key = `${sessionId}:${id}`;
		if (this.entries.get(key)?.connection.activeCalls) throw new McpError(409, "MCP 会话仍在执行工具");
		await this.release(key);
		const connection = new McpConnection(config, this.projectRoot, sessionId, () => {
			this.epoch++;
			this.checks.delete(id);
		});
		const entry = { sessionId, serverId: id, configHash: mcpFingerprint(config), connection };
		this.entries.set(key, entry);
		this.checks.set(id, {
			id,
			configHash: entry.configHash,
			status: "connecting",
			toolNames: [],
			connectionCount: 0,
		});
		try {
			await connection.connect();
			if (this.closed || this.entries.get(key) !== entry) {
				await connection.close();
				throw new Error("MCP 会话已关闭");
			}
			this.checks.set(id, {
				id,
				configHash: entry.configHash,
				status: "ready",
				toolNames: connection.tools.map((t) => t.name),
				connectionCount: 1,
				checkedAt: new Date().toISOString(),
			});
			return entry;
		} catch (error) {
			if (this.entries.get(key) === entry) this.entries.delete(key);
			this.checks.set(id, {
				id,
				configHash: entry.configHash,
				status: "error",
				toolNames: [],
				connectionCount: 0,
				error: connection.redact(error),
				checkedAt: new Date().toISOString(),
			});
			throw error;
		}
	}
	async attach(sessionId: string, onError: (message: string) => void): Promise<McpSessionTool[]> {
		const { config } = await this.configStore.read();
		const groups = await Promise.all(
			Object.entries(config.mcpServers)
				.filter(([, s]) => !s.disabled)
				.map(async ([id, server]) => {
					try {
						const entry = await this.open(sessionId, id, server);
						return entry.connection.tools.map(
							(remote): McpSessionTool => ({
								serverId: id,
								remote,
								call: async (args, signal) => {
									const current = (await this.configStore.read()).config.mcpServers[id];
									if (!current || current.disabled || mcpFingerprint(current) !== entry.configHash)
										throw new Error("MCP 配置已改变，请重新发送消息加载新工具");
									return entry.connection.call(remote.name, args, signal);
								},
							}),
						);
					} catch (error) {
						this.epoch++;
						onError(`MCP ${id} 连接失败：${error instanceof Error ? error.message : String(error)}`);
						return [];
					}
				}),
		);
		return groups.flat();
	}
	async test(id: string): Promise<McpView> {
		const config = (await this.configStore.read()).config.mcpServers[id];
		if (!config) throw new McpError(404, "MCP 服务不存在");
		const sessionId = `probe-${randomUUID()}`;
		try {
			await this.open(sessionId, id, config);
		} catch {
			/* Report the sanitized connection error in the status view. */
		} finally {
			await this.releaseSession(sessionId);
		}
		return this.view();
	}
	async disconnect(id: string): Promise<McpView> {
		if (!(await this.configStore.read()).config.mcpServers[id]) throw new McpError(404, "MCP 服务不存在");
		const targets = [...this.entries.entries()].filter(([, e]) => e.serverId === id);
		if (targets.some(([, e]) => e.connection.activeCalls))
			throw new McpError(409, "MCP 工具正在运行，请完成或停止任务后断开");
		this.epoch++;
		this.checks.delete(id);
		for (const [key] of targets) await this.release(key);
		return this.view();
	}
	private release(key: string): Promise<void> {
		const entry = this.entries.get(key);
		if (!entry) return Promise.resolve();
		this.entries.delete(key);
		const closing = entry.connection.close();
		this.closing.add(closing);
		void closing.finally(() => this.closing.delete(closing));
		return closing;
	}
	async releaseSession(id: string): Promise<void> {
		await Promise.all([...this.entries].filter(([, e]) => e.sessionId === id).map(([key]) => this.release(key)));
	}
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.entries.keys()].map((key) => this.release(key)));
		await Promise.all(this.closing);
	}
}
