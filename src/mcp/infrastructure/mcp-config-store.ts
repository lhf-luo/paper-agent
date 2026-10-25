import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type McpConfig, McpError, validateMcpConfig } from "../domain/mcp.ts";

export function mcpFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class McpConfigStore {
	readonly path: string;
	private writes: Promise<unknown> = Promise.resolve();
	constructor(root: string) {
		this.path = join(root, ".paper-agent", "config", "mcp.json");
	}
	async read(): Promise<{ config: McpConfig; version: string }> {
		let config: McpConfig;
		try {
			config = validateMcpConfig(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new McpError(400, "无法读取 MCP 配置，请检查 mcp.json 的格式");
			config = { mcpServers: {} };
		}
		return { config, version: mcpFingerprint(config) };
	}
	async save(input: unknown, expectedVersion: string): Promise<void> {
		const action = this.writes
			.catch(() => undefined)
			.then(async () => {
				const current = await this.read();
				if (expectedVersion !== current.version) throw new McpError(409, "MCP 配置已变化，请刷新后重试");
				const config = validateMcpConfig(input, current.config);
				await mkdir(dirname(this.path), { recursive: true });
				const temporary = `${this.path}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
					await rename(temporary, this.path);
				} finally {
					await rm(temporary, { force: true });
				}
			});
		this.writes = action;
		await action;
	}
}
