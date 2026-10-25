import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WebAgentServiceApi } from "../src/agent/domain/web-agent-contracts.ts";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { McpService } from "../src/mcp/application/mcp-service.ts";
import type { McpView } from "../src/mcp/domain/mcp.ts";

describe("MCP HTTP settings", () => {
	it("saves masked project config, tests tools, disconnects and rejects unknown operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-mcp-routes-"));
		const mcp = new McpService(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const server = await startLocalWebServer(application, {
			staticRoot: root,
			agentService: { projectRoot: root, mcp, close: () => mcp.close() } as unknown as WebAgentServiceApi,
		});
		const request = (path: string, method = "GET", body?: unknown) =>
			fetch(`${server.url}${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		try {
			const initial = (await (await request("/api/mcp")).json()) as McpView;
			expect(initial.config).toEqual({ mcpServers: {} });
			const config = {
				mcpServers: {
					fixture: {
						command: process.execPath,
						args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
						env: { TEST_TOKEN: "route-private-token" },
					},
				},
			};
			const saved = await request("/api/mcp", "PUT", { config, expectedVersion: initial.version });
			expect(saved.status).toBe(200);
			expect(await saved.text()).not.toContain("route-private-token");
			expect((await request("/api/mcp", "PUT", { config, expectedVersion: initial.version })).status).toBe(409);
			expect((await request("/api/mcp", "PUT", { config })).status).toBe(400);
			const tested = (await (await request("/api/mcp/fixture/test", "POST")).json()) as McpView;
			expect(tested.servers[0]).toMatchObject({ status: "ready", connectionCount: 0 });
			expect((await request("/api/mcp/fixture/disconnect", "POST")).status).toBe(200);
			expect((await request("/api/mcp/missing/test", "POST")).status).toBe(404);
			expect((await request("/api/mcp/fixture/call", "POST", {})).status).toBe(404);
		} finally {
			await server.close();
			await application.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
