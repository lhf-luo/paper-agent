import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type WebAgentEvent,
	WebAgentService,
	WebAgentServiceError,
} from "../src/agent/application/web-agent-service.ts";
import {
	defaultPaperAgentConfig,
	resolvePaperAgentConfigPaths,
	savePaperAgentConfig,
} from "../src/config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";

const temporaryPaths: string[] = [];
const services: WebAgentService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FakeModelRequest {
	path: string;
	body: Record<string, unknown>;
	headers: IncomingHttpHeaders;
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
		requests.push({ path: request.url ?? "", body, headers: request.headers });
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
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
	it("discovers every project skill under .agents/skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-project-skills-"));
		temporaryPaths.push(root);
		const skillRoot = join(root, ".agents", "skills", "custom-research-skill");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			"---\nname: custom-research-skill\ndescription: A project-local research skill used to verify automatic discovery.\n---\n\n# Custom research skill\n",
			"utf8",
		);

		const service = await WebAgentService.create({ projectRoot: root, additionalSkillPaths: [] });
		services.push(service);
		expect(service.listSkills()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "custom-research-skill", disableModelInvocation: false }),
			]),
		);
	});

	it("does not restore transient session error banners from persisted views", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-stale-error-"));
		temporaryPaths.push(root);
		const viewDir = join(root, ".paper-agent", "web-agent-memory", "session-views");
		await mkdir(viewDir, { recursive: true });
		await writeFile(
			join(viewDir, "stale-session.json"),
			JSON.stringify({
				id: "stale-session",
				title: "Recovered session",
				mode: "persistent",
				createdAt: "2026-08-29T00:00:00.000Z",
				updatedAt: "2026-08-29T00:01:00.000Z",
				error: "terminated",
				messages: [
					{
						id: "message-error",
						role: "assistant",
						content: "",
						status: "error",
						createdAt: "2026-08-29T00:01:00.000Z",
						error: "terminated",
					},
				],
				tools: [],
			}),
			"utf8",
		);

		const service = await WebAgentService.create({ projectRoot: root });
		services.push(service);
		const restored = service.getSession("stale-session");
		expect(restored).toMatchObject({ status: "idle", error: undefined });
		expect(restored.messages[0]).toMatchObject({ status: "error", error: "terminated" });
	});

	it("persists and restores paper session context", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-paper-context-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alternate"), "personal", "alternate");
		await store.upsertPaper({
			id: "paper-context",
			title: "Context paper",
			authors: ["Test Author"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		});
		const databasePath = store.databasePath;
		const first = await WebAgentService.create({ projectRoot: root, paperSessionDatabasePath: databasePath });
		services.push(first);
		const created = first.createSession({
			mode: "persistent",
			title: "阅读：Context paper",
			context: { kind: "paper", namespace: "alternate", paperId: "paper-context" },
		});
		expect(created.context).toEqual({ kind: "paper", namespace: "alternate", paperId: "paper-context" });
		expect(first.listSessions()).toEqual([]);
		expect(first.listSessions({ scope: "paper", namespace: "alternate", paperId: "paper-context" })).toHaveLength(1);
		expect(await readdir(join(root, ".paper-agent", "web-agent-memory", "session-views"))).toEqual([]);
		await first.close();
		services.splice(services.indexOf(first), 1);

		const restoredService = await WebAgentService.create({
			projectRoot: root,
			paperSessionDatabasePath: databasePath,
		});
		services.push(restoredService);
		expect(restoredService.getSession(created.id).context).toEqual({
			kind: "paper",
			namespace: "alternate",
			paperId: "paper-context",
		});

		const piFile = join(root, ".paper-agent", "web-agent-memory", "pi-sessions", `runtime_${created.id}.jsonl`);
		await writeFile(piFile, "runtime context", "utf8");
		await store.deletePapers(["paper-context"]);
		await waitFor(() => {
			try {
				restoredService.getSession(created.id);
				return false;
			} catch {
				return true;
			}
		}, 4_000);
		await waitFor(async () => !(await pathExists(piFile)), 4_000);
		expect(await pathExists(piFile)).toBe(false);
	});

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
			expect(failingSnapshot.status).toBe("error");
			expect(failingSnapshot.error).toBeTruthy();
			expect(JSON.stringify(failingSnapshot)).not.toContain(secret);
			expect(JSON.stringify(failingSnapshot)).not.toMatch(/Bearer\s+sk-/i);
			const dismissed = await service.dismissError(failing.id);
			expect(dismissed).toMatchObject({ status: "idle", error: undefined });
			expect(service.getSession(failing.id)).toMatchObject({ status: "idle", error: undefined });
			expect(await pathExists(resolvePaperAgentConfigPaths(root).modelsFile)).toBe(false);
			expect(await pathExists(join(root, ".paper-agent", "web-agent-memory", "auth.json"))).toBe(false);
			subscription.unsubscribe();
		} finally {
			await provider.close();
		}
	});

	it.each(["once", "persistent"] as const)("keeps %s model context separate from saved UI history", async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-context-"));
		temporaryPaths.push(root);
		const secret = "synthetic-context-test-key";
		const provider = await startFakeModelServer({ secret });
		const config = {
			providerId: "fake-provider",
			modelId: "fake-model",
			baseUrl: provider.baseUrl,
			api: "openai-completions" as const,
			apiKey: secret,
		};
		try {
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			await service.updateConfig(config);
			const session = service.createSession({ mode });
			for (const message of ["context-first-marker", "context-second-marker"]) {
				await service.sendMessage(session.id, { message });
				await waitFor(() => service.getSession(session.id).status !== "running");
				expect(service.getSession(session.id).error).toBeUndefined();
			}
			expect(provider.requests).toHaveLength(2);
			const secondMessages = JSON.stringify(provider.requests[1].body.messages);
			expect(secondMessages).toContain("context-second-marker");
			expect(secondMessages.includes("context-first-marker")).toBe(mode === "persistent");
			expect(service.getSession(session.id).messages.filter((message) => message.role === "user")).toHaveLength(2);

			await service.close();
			const restored = await WebAgentService.create({ projectRoot: root });
			services.push(restored);
			await restored.updateConfig(config);
			expect(restored.getSession(session.id).messages.filter((message) => message.role === "user")).toHaveLength(2);
			await restored.sendMessage(session.id, { message: "context-after-restart-marker" });
			await waitFor(() => restored.getSession(session.id).status !== "running");
			expect(restored.getSession(session.id).error).toBeUndefined();
			expect(provider.requests).toHaveLength(3);
			const restoredMessages = JSON.stringify(provider.requests[2].body.messages);
			expect(restoredMessages).toContain("context-after-restart-marker");
			expect(restoredMessages.includes("context-first-marker")).toBe(mode === "persistent");
			expect(restoredMessages.includes("context-second-marker")).toBe(mode === "persistent");
		} finally {
			await provider.close();
		}
	});

	it("forwards configured model headers through the Pi SDK", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-headers-"));
		temporaryPaths.push(root);
		const secret = "sk-configured-header-test";
		const provider = await startFakeModelServer({ secret });
		try {
			await savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				model: {
					providerId: "header-provider",
					modelId: "header-model",
					baseUrl: provider.baseUrl,
					api: "openai-completions",
					apiKey: secret,
					headers: { "user-agent": "configured-agent/1.0", "x-client": "paper-agent" },
				},
			});
			const service = await WebAgentService.create({ projectRoot: root });
			services.push(service);
			const session = service.createSession({ mode: "once" });
			await service.sendMessage(session.id, { message: "check headers" });
			await waitFor(() => service.getSession(session.id).status !== "running");
			expect(provider.requests[0]?.headers["user-agent"]).toBe("configured-agent/1.0");
			expect(provider.requests[0]?.headers["x-client"]).toBe("paper-agent");
		} finally {
			await provider.close();
		}
	});

	it("enables configured Pi built-in tools without hiding extension tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-tools-"));
		temporaryPaths.push(root);
		const provider = await startFakeModelServer({ secret: "sk-tool-list-test" });
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "paper_agent_probe",
				label: "Paper Agent probe",
				description: "A test-only Paper Agent extension tool.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		try {
			const config = defaultPaperAgentConfig();
			config.agent.builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
			config.model = {
				providerId: "fake-provider",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
				apiKey: "sk-tool-list-test",
			};
			await savePaperAgentConfig(root, config);
			const service = await WebAgentService.create({ projectRoot: root, extensionFactory });
			services.push(service);
			const session = service.createSession({ mode: "once" });
			await service.sendMessage(session.id, { message: "list tools" });
			await waitFor(() => service.getSession(session.id).status !== "running");
			const tools = (provider.requests[0]?.body.tools ?? []) as Array<{
				function?: { name?: string };
			}>;
			const names = tools.map((tool) => tool.function?.name).filter(Boolean);
			expect(names).toEqual(
				expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls", "paper_agent_probe"]),
			);
		} finally {
			await provider.close();
		}
	});

	it("preserves sessions when credentials or endpoint identity changes", async () => {
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
			await waitFor(
				() =>
					service.getSession(first.id).status !== "running" && service.getSession(second.id).status !== "running",
			);
			expect(JSON.stringify(service.getSession(first.id))).toContain("alpha-only");
			expect(JSON.stringify(service.getSession(first.id))).not.toContain("beta-only");
			expect(JSON.stringify(service.getSession(second.id))).toContain("beta-only");
			expect(JSON.stringify(service.getSession(second.id))).not.toContain("alpha-only");

			await service.updateConfig({
				providerId: "fake-provider",
				modelId: "fake-model-v2",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: secret,
			});
			await service.sendMessage(first.id, { message: "after-model-switch" });
			await waitFor(() => service.getSession(first.id).status !== "running");
			expect(provider.requests.at(-1)?.body.model).toBe("fake-model-v2");
			expect(JSON.stringify(service.getSession(first.id))).toContain("alpha-only");
			expect(JSON.stringify(service.getSession(first.id))).toContain("after-model-switch");
			expect(service.listSessions()).toHaveLength(2);

			await service.clearKey();
			expect(service.listSessions()).toHaveLength(2);
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
			expect(service.listSessions()).toHaveLength(3);
			expect(service.getConfig().credentialsAvailable).toBe(false);
			await service.close();
			const viewFiles = await readdir(join(root, ".paper-agent", "web-agent-memory", "session-views"));
			expect(viewFiles.filter((file) => file.endsWith(".json"))).toHaveLength(3);
			expect(viewFiles.filter((file) => file.endsWith(".tmp"))).toEqual([]);
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
			expect(provider.requests).toHaveLength(2);
			expect(provider.requests[0]?.headers["user-agent"]).toBe("claude-cli/2.1.198 (external, sdk-cli)");
			expect(provider.requests[1]?.body.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ role: "tool" })]),
			);
			expect(finished.uiRequests).toEqual([]);
			const toolMessage = finished.messages.find((message) => message.role === "assistant");
			expect(finished.tools).toEqual([
				expect.objectContaining({
					name: "test_write",
					status: "succeeded",
					assistantMessageId: toolMessage?.id,
				}),
			]);
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
			const rawConfig = await readFile(resolvePaperAgentConfigPaths(root).modelsFile, "utf8");
			expect(rawConfig).not.toContain(secret);
		} finally {
			if (previous === undefined) delete process.env[environmentName];
			else process.env[environmentName] = previous;
			await provider.close();
		}
	});

	it("lists configured models from split config and applies one by key", async () => {
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
					input: ["text", "image"],
					apiKeyEnvironmentVariable: environmentName,
				},
				models: [
					{
						providerId: "alpha",
						modelId: "alpha-model",
						api: "openai-completions",
						baseUrl: "https://alpha.example.com/v1",
						input: ["text", "image"],
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
				input: ["text", "image"],
			});
			expect(config.configuredModels[1]).toMatchObject({
				key: "beta/beta-model",
				providerId: "beta",
				credentialsAvailable: false,
			});
			// 初始端点来自 config.model(默认选中项)
			expect(config).toMatchObject({ providerId: "alpha", modelId: "alpha-model", input: ["text", "image"] });
			// 应用第二个模型: 端点切换, 其 env var 未设置 → 凭据不可用
			await service.applyConfiguredModel("beta/beta-model");
			const applied = service.getConfig();
			expect(applied).toMatchObject({
				providerId: "beta",
				modelId: "beta-model",
				baseUrl: "https://beta.example.com/v1",
				credentialSource: "none",
				input: ["text"],
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

	it("waits for the user to select a model when the model list has no active entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-unselected-"));
		temporaryPaths.push(root);
		await savePaperAgentConfig(root, {
			...defaultPaperAgentConfig(),
			models: [
				{
					providerId: "relay",
					modelId: "vision",
					api: "openai-completions",
					baseUrl: "https://relay.example.com/v1",
					input: ["text", "image"],
					reasoning: true,
					apiKey: "test-key",
				},
			],
		});
		const service = await WebAgentService.create({ projectRoot: root });
		services.push(service);
		expect(service.getConfig()).toMatchObject({ configured: false, configuredModels: [{ key: "relay/vision" }] });
		await service.applyConfiguredModel("relay/vision");
		expect(service.getConfig()).toMatchObject({ configured: true, modelId: "vision", input: ["text", "image"] });
	});
});
