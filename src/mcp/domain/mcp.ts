export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
	disabled: boolean;
	timeoutMs: number;
}

export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
}
export interface McpServerState {
	id: string;
	status: "disabled" | "disconnected" | "connecting" | "ready" | "error";
	toolNames: string[];
	connectionCount: number;
	error?: string;
	checkedAt?: string;
}
export interface McpView {
	config: McpConfig;
	configPath: string;
	version: string;
	servers: McpServerState[];
}
export interface McpControl {
	view(): Promise<McpView>;
	save(config: unknown, expectedVersion: string): Promise<McpView>;
	test(id: string): Promise<McpView>;
	disconnect(id: string): Promise<McpView>;
}
export class McpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
export const MCP_SECRET_MASK = "********";

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpError(400, `${label} 必须是对象`);
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || value.length > max || value.includes("\0"))
		throw new McpError(400, `${label} 必须是有效字符串（最多 ${max} 字符）`);
	return value;
}

/** Accept the standard mcpServers format; this release supports local stdio servers. */
export function validateMcpConfig(value: unknown, previous?: McpConfig): McpConfig {
	const root = object(value, "MCP 配置");
	if (Object.keys(root).some((key) => key !== "mcpServers")) throw new McpError(400, "MCP 配置只接受 mcpServers");
	const entries = Object.entries(object(root.mcpServers, "mcpServers"));
	if (entries.length > 12) throw new McpError(400, "最多配置 12 个 MCP 服务");
	const servers: Record<string, McpServerConfig> = Object.create(null);
	for (const [id, raw] of entries) {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id))
			throw new McpError(400, "MCP 服务名称需以字母开头，最多 32 个字母、数字、下划线或短横线");
		const server = object(raw, id);
		if (Object.keys(server).some((key) => !["command", "args", "env", "disabled", "timeoutMs"].includes(key)))
			throw new McpError(400, `${id} 仅支持 command、args、env、disabled、timeoutMs（stdio）`);
		const command = text(server.command, `${id}.command`, 2048).trim();
		if (!command || /[\r\n]/.test(command)) throw new McpError(400, `${id}.command 不能为空或包含换行`);
		if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 64))
			throw new McpError(400, `${id}.args 必须是最多 64 项的数组`);
		const args = ((server.args ?? []) as unknown[]).map((arg) => text(arg, `${id}.args`, 8192));
		if (server.disabled !== undefined && typeof server.disabled !== "boolean")
			throw new McpError(400, `${id}.disabled 必须是布尔值`);
		const timeoutMs = server.timeoutMs ?? 60_000;
		if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 300_000)
			throw new McpError(400, `${id}.timeoutMs 需在 1000 至 300000 之间`);
		const env: Record<string, string> = Object.create(null);
		for (const [key, rawValue] of Object.entries(server.env === undefined ? {} : object(server.env, `${id}.env`))) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new McpError(400, `${id}.env 的变量名无效`);
			const value = text(rawValue, `${id}.env.${key}`, 16_384);
			const secret = value === MCP_SECRET_MASK ? previous?.mcpServers[id]?.env?.[key] : value;
			if (secret === undefined) throw new McpError(400, `${id}.env.${key} 需要填写实际值`);
			env[key] = secret;
		}
		servers[id] = {
			command,
			args,
			...(Object.keys(env).length ? { env } : {}),
			disabled: server.disabled === true,
			timeoutMs: Number(timeoutMs),
		};
	}
	return { mcpServers: servers };
}

export function redactMcpConfig(config: McpConfig): McpConfig {
	return {
		mcpServers: Object.fromEntries(
			Object.entries(config.mcpServers).map(([id, server]) => [
				id,
				{
					...server,
					env: server.env
						? Object.fromEntries(Object.keys(server.env).map((key) => [key, MCP_SECRET_MASK]))
						: undefined,
				},
			]),
		),
	};
}

export function playwrightMcpPreset(): McpServerConfig {
	return {
		command: "npx",
		args: ["-y", "@playwright/mcp@latest", "--extension"],
		disabled: false,
		timeoutMs: 120_000,
	};
}
