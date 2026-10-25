import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "../domain/mcp.ts";

export type McpRemoteTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
export type McpToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** Invoke npm's JS entrypoint on Windows, avoiding cmd.exe quoting and orphaned wrappers. */
export function mcpLaunchParameters(config: McpServerConfig, platform = process.platform) {
	if (platform === "win32" && /^(npx|npm)(\.cmd)?$/i.test(config.command)) {
		const bin = /^npx/i.test(config.command) ? "npx-cli.js" : "npm-cli.js";
		const entry = join(dirname(process.execPath), "node_modules", "npm", "bin", bin);
		if (existsSync(entry)) return { command: process.execPath, args: [entry, ...config.args] };
	}
	return { command: config.command, args: config.args };
}

export class McpConnection {
	readonly client: Client;
	readonly transport: StdioClientTransport;
	tools: McpRemoteTool[] = [];
	activeCalls = 0;
	closed = false;
	private tail: Promise<unknown> = Promise.resolve();
	private stderr = "";
	readonly config: McpServerConfig;
	constructor(config: McpServerConfig, root: string, name: string, onUnexpectedClose?: () => void) {
		this.config = config;
		this.client = new Client({ name: `paper-agent-${name}`, version: "0.1.0" }, { capabilities: {} });
		this.client.onclose = () => {
			const unexpected = !this.closed;
			this.closed = true;
			if (unexpected) onUnexpectedClose?.();
		};
		const network = Object.fromEntries(
			[
				"HTTP_PROXY",
				"HTTPS_PROXY",
				"NO_PROXY",
				"http_proxy",
				"https_proxy",
				"no_proxy",
				"LOCALAPPDATA",
				"APPDATA",
				"TEMP",
				"TMP",
			].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
		);
		this.transport = new StdioClientTransport({
			...mcpLaunchParameters(config),
			cwd: root,
			env: { ...getDefaultEnvironment(), ...network, ...config.env },
			stderr: "pipe",
			maxBufferSize: 10 * 1024 * 1024,
		});
		this.transport.stderr?.on("data", (data: Buffer) => {
			this.stderr = (this.stderr + data.toString()).slice(-4000);
		});
	}
	redact(value: unknown): string {
		let message = value instanceof Error ? value.message : String(value);
		for (const secret of Object.values(this.config.env ?? {}).sort((a, b) => b.length - a.length))
			if (secret) message = message.split(secret).join("[REDACTED]");
		return message.slice(0, 4000);
	}
	async connect(signal?: AbortSignal): Promise<void> {
		try {
			await this.client.connect(this.transport, { signal, timeout: this.config.timeoutMs });
			let cursor: string | undefined;
			const cursors = new Set<string>();
			do {
				const page = await this.client.listTools(cursor ? { cursor } : {}, {
					signal,
					timeout: this.config.timeoutMs,
				});
				this.tools.push(...page.tools);
				cursor = page.nextCursor;
				if (cursor && cursors.has(cursor)) throw new Error("MCP 工具分页游标重复");
				if (cursor) cursors.add(cursor);
				if (this.tools.length > 256) throw new Error("单个 MCP 服务最多支持 256 个工具");
			} while (cursor);
		} catch (error) {
			await this.close();
			throw new Error(
				this.redact(`${error instanceof Error ? error.message : error}${this.stderr ? `\n${this.stderr}` : ""}`),
			);
		}
	}
	async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const operation = this.tail
			.catch(() => undefined)
			.then(async () => {
				signal?.throwIfAborted();
				if (this.closed) throw new Error("MCP 连接已断开，请重新发送消息建立连接");
				this.activeCalls++;
				try {
					return await this.client.callTool({ name, arguments: args }, { signal, timeout: this.config.timeoutMs });
				} catch (error) {
					throw new Error(this.redact(error));
				} finally {
					this.activeCalls--;
				}
			});
		this.tail = operation;
		return operation;
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.client.close().catch(() => undefined);
		await this.transport.close().catch(() => undefined);
	}
}
