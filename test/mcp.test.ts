import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpResult, mcpToolName, registerWebAgentMcpTools } from "../src/agent/application/web-agent-mcp-tools.ts";
import { McpService } from "../src/mcp/application/mcp-service.ts";
import { validateMcpConfig } from "../src/mcp/domain/mcp.ts";
import type { McpConnection } from "../src/mcp/infrastructure/mcp-connection.ts";
import { captureAgentToolCatalog, type RegisteredAgentTool } from "../src/shared/presentation/agent-tool-catalog.ts";

const roots: string[] = [];
const services: McpService[] = [];
const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const config = (args: string[] = []) =>
	validateMcpConfig({
		mcpServers: { fixture: { command: process.execPath, args: [fixture, ...args], timeoutMs: 2000 } },
	});
async function service() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-mcp-"));
	roots.push(root);
	const service = new McpService(root);
	services.push(service);
	await service.save(config(), (await service.view()).version);
	return service;
}
const parsed = (result: Awaited<ReturnType<McpConnection["call"]>>) =>
	JSON.parse(String(result.content?.find((c) => c.type === "text")?.text));
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project MCP connections", () => {
	it("validates stdio configuration, masks secrets, preserves masked values and rejects stale writes", async () => {
		const mcp = await service();
		const previous = await mcp.view();
		const input = config();
		input.mcpServers.fixture.env = { TEST_TOKEN: "private-value" };
		const saved = await mcp.save(input, previous.version);
		expect(JSON.stringify(saved)).not.toContain("private-value");
		expect(saved.config.mcpServers.fixture.env?.TEST_TOKEN).toBe("********");
		await mcp.save(saved.config, saved.version);
		expect(JSON.parse(await readFile(saved.configPath, "utf8")).mcpServers.fixture.env.TEST_TOKEN).toBe(
			"private-value",
		);
		await expect(mcp.save(config(), previous.version)).rejects.toMatchObject({ status: 409 });
		expect(() => validateMcpConfig({ mcpServers: { bad: { url: "https://example.org/mcp" } } })).toThrow("stdio");
		expect(() => validateMcpConfig({ mcpServers: { bad: { command: "node", env: { TOKEN: "********" } } } })).toThrow(
			"实际值",
		);
	});
	it("uses the real MCP SDK handshake and paginated tool discovery; probe closes its child process", async () => {
		const mcp = await service();
		const tested = await mcp.test("fixture");
		expect(tested.servers[0]).toMatchObject({
			status: "ready",
			connectionCount: 0,
			toolNames: ["echo", "wait", "error", "image", "exit"],
		});
		const errors: string[] = [];
		const first = await mcp.attach("first", (message) => errors.push(message));
		const second = await mcp.attach("second", (message) => errors.push(message));
		const one = parsed(await first[0].call({ text: "one" }));
		const two = parsed(await second[0].call({ text: "two" }));
		expect(one.pid).not.toBe(two.pid);
		expect(one.sequence).toBe(1);
		expect(two.sequence).toBe(1);
		expect(errors).toEqual([]);
		expect((await mcp.view()).servers[0].connectionCount).toBe(2);
		await mcp.releaseSession("first");
		expect(() => process.kill(one.pid, 0)).toThrow();
		expect((await mcp.view()).servers[0].connectionCount).toBe(1);
	});
	it("serializes calls, cancels through SDK and refuses disconnect while a tool runs", async () => {
		const mcp = await service();
		const tools = await mcp.attach("run", () => {});
		const wait = tools.find((t) => t.remote.name === "wait")!;
		const echo = tools[0];
		const waiting = wait.call({ delay: 100 });
		await vi.waitFor(async () => expect((await mcp.view()).servers[0].connectionCount).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 30));
		await expect(mcp.disconnect("fixture")).rejects.toMatchObject({ status: 409 });
		const next = echo.call({ text: "after" });
		expect(parsed(await waiting).sequence).toBe(1);
		expect(parsed(await next).sequence).toBe(2);
		const controller = new AbortController();
		const cancelled = wait.call({ delay: 10000 }, controller.signal);
		const rejection = expect(cancelled).rejects.toThrow();
		setTimeout(() => controller.abort(), 30);
		await rejection;
		expect(parsed(await echo.call({ text: "still usable" })).args.text).toBe("still usable");
		await mcp.disconnect("fixture");
		await expect(echo.call({})).rejects.toThrow("断开");
	});
	it("times out stalled calls and releases the subprocess", async () => {
		const mcp = await service();
		const view = await mcp.view();
		view.config.mcpServers.fixture.timeoutMs = 1000;
		await mcp.save(view.config, view.version);
		const tools = await mcp.attach("timeout", () => {});
		const pid = parsed(await tools[0].call({})).pid;
		await expect(tools.find((tool) => tool.remote.name === "wait")!.call({ delay: 10000 })).rejects.toThrow(
			/timeout|timed out/i,
		);
		await mcp.releaseSession("timeout");
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it("rejects stale or disabled configuration and reconnects after a crashed server", async () => {
		const mcp = await service();
		const tools = await mcp.attach("run", () => {});
		const before = await mcp.revision();
		await tools.find((t) => t.remote.name === "exit")!.call({});
		await vi.waitFor(async () => expect(await mcp.revision()).not.toBe(before));
		const fresh = await mcp.attach("run", () => {});
		expect(parsed(await fresh[0].call({})).sequence).toBe(1);
		const view = await mcp.view();
		view.config.mcpServers.fixture.disabled = true;
		await mcp.save(view.config, view.version);
		await expect(fresh[0].call({})).rejects.toThrow("配置已改变");
		expect(await mcp.attach("disabled-session", () => {})).toEqual([]);
	});
	it("reports connection failures without environment secrets and keeps the Agent usable", async () => {
		const mcp = await service();
		const bad = config(["--fail"]);
		bad.mcpServers.fixture.env = { TEST_TOKEN: "private-fixture-token" };
		await mcp.save(bad, (await mcp.view()).version);
		const warnings: string[] = [];
		expect(await mcp.attach("broken", (message) => warnings.push(message))).toEqual([]);
		expect(warnings[0]).toContain("连接失败");
		expect(warnings.join()).not.toContain("private-fixture-token");
		expect(JSON.stringify(await mcp.test("fixture"))).not.toContain("private-fixture-token");
		expect((await mcp.view()).servers[0].status).toBe("error");
	});
	it("registers prefixed tools, keeps MCP namespace arguments and requires existing UI consent", async () => {
		const mcp = await service();
		const tools: RegisteredAgentTool[] = [];
		const pi = { registerTool: (tool: RegisteredAgentTool) => tools.push(tool) } as unknown as ExtensionAPI;
		const catalog = captureAgentToolCatalog(pi);
		await registerWebAgentMcpTools(pi, mcp, "web", () => {});
		const echo = tools.find((t) => t.name === "mcp__fixture__echo")!;
		const confirm = vi.fn(async () => false);
		const ctx = { hasUI: true, ui: { confirm } } as any;
		await expect(echo.execute("call", { namespace: "external-service" }, undefined, undefined, ctx)).rejects.toThrow(
			"未授权",
		);
		confirm.mockResolvedValue(true);
		const output = await echo.execute("call", { namespace: "external-service" }, undefined, undefined, ctx);
		expect(JSON.parse((output.content[0] as { text: string }).text)).toMatchObject({
			sequence: 1,
			args: { namespace: "external-service" },
		});
		expect(catalog.find("", "mcp__fixture__echo")).toHaveLength(1);
		const image = await tools
			.find((t) => t.name.endsWith("__image"))!
			.execute("image", {}, undefined, undefined, ctx);
		expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		await expect(
			tools.find((t) => t.name.endsWith("__error"))!.execute("error", {}, undefined, undefined, ctx),
		).rejects.toThrow("fixture tool failed");
	});
	it("bounds tool names and large text results", () => {
		const name = mcpToolName("server", "unusual.tool/".repeat(20));
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(name).not.toBe(mcpToolName("server", "unusual.tool/".repeat(19)));
		const output = mcpResult({ content: [{ type: "text", text: "x".repeat(200000) }] });
		expect(output.details.truncated).toBe(true);
		expect((output.content[0] as { text: string }).text).toHaveLength(100000);
	});
});
