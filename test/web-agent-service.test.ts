import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/app-config.ts";
import { WebAgentService, WebAgentServiceError, type WebAgentEvent } from "../src/web-agent-service.ts";

const temporaryPaths: string[] = [];
const services: WebAgentService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FakeModelRequest {
	path: string;
	body: Record<string, unknown>;
}

async function startFakeModelServer(options: { secret: string; toolPath?: string }) {
	const requests: FakeModelRequest[] = [];
	const heldResponses = new Set<ServerResponse>();
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		} catch {
			// The assertion below will expose malformed provider requests.
		}
		requests.push({ path: request.url ?? "", body });
		const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
		const lastUser = [...messages].reverse().find((message) => message.role === "user");
		const userText =
			typeof lastUser?.content === "string"
				? lastUser.content
				: Array.isArray(lastUser?.content)
					? (lastUser.content as Array<{ type?: string; text?: string }>)
							.filter((entry) => entry.type === "text")
							.map((entry) => entry.text ?? "")
							.join("")
					: "";
		if (userText.includes("provider-error")) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: `Authorization: Bearer ${options.secret}; api_key=${options.secret}`,
				}),
			);
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		const chunk = (choices: unknown[]) =>
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-paper-agent-test",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "fake-model",
					choices,
				})}\n\n`,
			);
		if (userText.includes("wait-for-abort")) {
			chunk([{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }]);
			heldResponses.add(response);
			request.once("close", () => heldResponses.delete(response));
			return;
		}
		const hasToolResult = messages.some((message) => message.role === "tool");
		const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
		const hasTestWrite = tools.some((tool) => {
			const definition = tool.function as Record<string, unknown> | undefined;
			return definition?.name === "test_write";
		});
		if (options.toolPath && hasTestWrite && !hasToolResult) {
			chunk([
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_test_write",
								type: "function",
								function: { name: "test_write", arguments: JSON.stringify({ path: options.toolPath }) },
							},
						],
					},
					finish_reason: null,
				},
			]);
			chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
			response.end("data: [DONE]\n\n");
			return;
		}
		const answer = hasToolResult ? "write decision received" : `echo:${userText}`;
		chunk([{ index: 0, delta: { role: "assistant", content: answer.slice(0, 5) }, finish_reason: null }]);
		chunk([{ index: 0, delta: { content: answer.slice(5) }, finish_reason: null }]);
		chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: async () => {
			for (const response of heldResponses) response.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Web Agent state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("WebAgentService", () => {
	it("streams through the real Pi SDK without persisting or returning the model API key", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-stream-"));
		temporaryPaths.push(root);
		const secret = "sk-paper-agent-web-test-secret";
		const provider = await startFakeModelServer({ secret });
		try {
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			const session = service.createSession({ mode: "persistent" });
			await expect(service.sendMessage(session.id, { message: "hello" })).rejects.toThrow("请先配置");
			await expect(
				service.updateConfig({
					providerId: "fake-provider",
					modelId: "fake-model",
					baseUrl: "http://example.com/v1",
					api: "openai-completions",
					apiKey: secret,
				}),
			).rejects.toThrow("HTTPS");
			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			const active = service.createSession({ mode: "persistent" });
			const events: WebAgentEvent[] = [];
			const subscription = service.subscribeSession(active.id, (event) => events.push(event));
			await service.sendMessage(active.id, { message: "hello streaming" });
			await waitFor(() => service.getSession(active.id).status !== "running");
			const snapshot = service.getSession(active.id);
			expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", content: "echo:hello streaming" });
			expect(events.some((event) => event.type === "message_delta")).toBe(true);
			expect(service.getConfig()).toMatchObject({
				configured: true,
				credentialsAvailable: true,
				credentialSource: "memory",
			});
			const exposed = JSON.stringify({ config: service.getConfig(), snapshot, events });
			expect(exposed).not.toContain(secret);
			const failing = service.createSession({ mode: "once" });
			await service.sendMessage(failing.id, { message: "provider-error" });
			await waitFor(() => service.getSession(failing.id).status !== "running");
			const failingSnapshot = service.getSession(failing.id);
			expect(JSON.stringify(failingSnapshot)).not.toContain(secret);
			expect(JSON.stringify(failingSnapshot)).not.toMatch(/Bearer\s+sk-/i);
			expect(await pathExists(join(root, ".paper-agent", "config.json"))).toBe(false);
			expect(await pathExists(join(root, ".paper-agent", "web-agent-memory", "auth.json"))).toBe(false);
			subscription.unsubscribe();
		} finally {
			await provider.close();
		}
	});

	it("isolates sessions and destroys them when credentials or endpoint identity changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-isolation-"));
		temporaryPaths.push(root);
		const secret = "sk-isolated-web-agent";
		const provider = await startFakeModelServer({ secret });
		try {
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			const first = service.createSession({ mode: "persistent", title: "first" });
			const second = service.createSession({ mode: "persistent", title: "second" });
			await service.sendMessage(first.id, { message: "alpha-only" });
			await service.sendMessage(second.id, { message: "beta-only" });
			await waitFor(() => service.getSession(first.id).status !== "running" && service.getSession(second.id).status !== "running");
			expect(JSON.stringify(service.getSession(first.id))).toContain("alpha-only");
			expect(JSON.stringify(service.getSession(first.id))).not.toContain("beta-only");
			expect(JSON.stringify(service.getSession(second.id))).toContain("beta-only");
			expect(JSON.stringify(service.getSession(second.id))).not.toContain("alpha-only");

			await service.clearKey();
			expect(service.listSessions()).toEqual([]);
			expect(service.getConfig()).toMatchObject({ credentialsAvailable: false, credentialSource: "none" });

			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			service.createSession({ mode: "persistent" });
			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: `${provider.baseUrl}/alternate`,
				api: "openai-completions",
			});
			expect(service.listSessions()).toEqual([]);
			expect(service.getConfig().credentialsAvailable).toBe(false);
			await service.close();
			expect(() => service.createSession({ mode: "once" })).toThrow(WebAgentServiceError);
		} finally {
			await provider.close();
		}
	});

	it("aborts an in-flight generation and marks the streamed assistant message as aborted", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-abort-"));
		temporaryPaths.push(root);
		const secret = "sk-abort-web-agent";
		const provider = await startFakeModelServer({ secret });
		try {
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			const session = service.createSession({ mode: "persistent" });
			await service.sendMessage(session.id, { message: "wait-for-abort" });
			await waitFor(() => service.getSession(session.id).messages.some((message) => message.content === "partial"));
			const stopped = await service.abortSession(session.id);
			expect(stopped.status).toBe("idle");
			expect(stopped.messages.at(-1)).toMatchObject({ role: "assistant", content: "partial", status: "aborted" });
		} finally {
			await provider.close();
		}
	});

	it("keeps ctx.ui.confirm pending and rejection prevents the proposed write", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-confirm-"));
		temporaryPaths.push(root);
		const target = join(root, "must-not-exist.txt");
		const secret = "sk-confirm-web-agent";
		const provider = await startFakeModelServer({ secret, toolPath: target });
		const confirmationExtension = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "test_write",
				label: "Test write",
				description: "Write a test file only after explicit confirmation.",
				parameters: Type.Object({ path: Type.String() }),
				execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
					const confirmed = await ctx.ui.confirm("Write test file", `Create ${params.path}?`);
					if (!confirmed) return { content: [{ type: "text", text: "Write rejected by user" }], details: {} };
					await writeFile(params.path, "written", "utf8");
					return { content: [{ type: "text", text: "Write completed" }], details: {} };
				},
			});
		};
		try {
			const service = await WebAgentService.create({
				projectRoot: root,
				extensionFactory: confirmationExtension,
				systemPrompt: "Use test_write when the user asks for a write.",
				additionalSkillPaths: [],
			});
			services.push(service);
			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			const session = service.createSession({ mode: "persistent" });
			await service.sendMessage(session.id, { message: "please write" });
			await waitFor(() => service.getSession(session.id).uiRequests.length === 1);
			const pending = service.getSession(session.id);
			expect(pending.status).toBe("running");
			expect(pending.tools).toEqual([expect.objectContaining({ name: "test_write", status: "running" })]);
			expect(await pathExists(target)).toBe(false);
			await service.respondToUI(session.id, pending.uiRequests[0].id, false);
			await waitFor(() => service.getSession(session.id).status !== "running");
			const finished = service.getSession(session.id);
			expect(finished.uiRequests).toEqual([]);
			expect(finished.tools).toEqual([expect.objectContaining({ name: "test_write", status: "succeeded" })]);
			expect(await pathExists(target)).toBe(false);
		} finally {
			await provider.close();
		}
	});

	it("uses only the project-configured environment credential scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-env-"));
		temporaryPaths.push(root);
		const secret = "sk-environment-web-agent";
		const provider = await startFakeModelServer({ secret });
		const environmentName = "PAPER_AGENT_WEB_AGENT_TEST_KEY";
		const previous = process.env[environmentName];
		process.env[environmentName] = secret;
		try {
			await savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				model: {
					providerId: "fake-provider",
					modelId: "fake-model",
					baseUrl: provider.baseUrl,
					api: "openai-completions",
					apiKeyEnvironmentVariable: environmentName,
				},
			});
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			expect(service.getConfig()).toMatchObject({
				credentialsAvailable: true,
				credentialSource: "environment",
				apiKeyEnvironmentVariable: environmentName,
			});
			await service.updateConfig({
				providerId: "other-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
			});
			expect(service.getConfig()).toMatchObject({ credentialsAvailable: false, credentialSource: "none" });
			expect(service.getConfig().apiKeyEnvironmentVariable).toBeUndefined();
			const rawConfig = await readFile(join(root, ".paper-agent", "config.json"), "utf8");
			expect(rawConfig).not.toContain(secret);
		} finally {
			if (previous === undefined) delete process.env[environmentName];
			else process.env[environmentName] = previous;
			await provider.close();
		}
	});

	it("lists configured models from config.json and applies one by key", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-models-"));
		temporaryPaths.push(root);
		const environmentName = "PAPER_AGENT_TEST_MODEL_KEY";
		const previous = process.env[environmentName];
		process.env[environmentName] = "sk-configured-test-secret";
		try {
			await savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				model: {
					providerId: "alpha",
					modelId: "alpha-model",
					api: "openai-completions",
					baseUrl: "https://alpha.example.com/v1",
					apiKeyEnvironmentVariable: environmentName,
				},
				models: [
					{
						providerId: "alpha",
						modelId: "alpha-model",
						api: "openai-completions",
						baseUrl: "https://alpha.example.com/v1",
						apiKeyEnvironmentVariable: environmentName,
					},
					{
						providerId: "beta",
						modelId: "beta-model",
						api: "openai-completions",
						baseUrl: "https://beta.example.com/v1",
						apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_MISSING_KEY",
					},
				],
			});
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			const config = service.getConfig();
			expect(config.configuredModels).toHaveLength(2);
			expect(config.configuredModels[0]).toMatchObject({
				key: "alpha/alpha-model",
				providerId: "alpha",
				modelId: "alpha-model",
				credentialsAvailable: true,
			});
			expect(config.configuredModels[1]).toMatchObject({
				key: "beta/beta-model",
				providerId: "beta",
				credentialsAvailable: false,
			});
			// 初始端点来自 config.model(默认选中项)
			expect(config).toMatchObject({ providerId: "alpha", modelId: "alpha-model" });
			// 应用第二个模型: 端点切换, 其 env var 未设置 → 凭据不可用
			await service.applyConfiguredModel("beta/beta-model");
			const applied = service.getConfig();
			expect(applied).toMatchObject({
				providerId: "beta",
				modelId: "beta-model",
				baseUrl: "https://beta.example.com/v1",
				credentialSource: "none",
			});
			// 应用第一个模型: 其 env var 已设置 → 凭据来自环境变量
			await service.applyConfiguredModel("alpha/alpha-model");
			expect(service.getConfig()).toMatchObject({
				providerId: "alpha",
				modelId: "alpha-model",
				credentialSource: "environment",
				credentialsAvailable: true,
			});
			await expect(service.applyConfiguredModel("nope/nope")).rejects.toThrow("未找到已配置的模型");
		} finally {
			if (previous === undefined) delete process.env[environmentName];
			else process.env[environmentName] = previous;
		}
	});
});
