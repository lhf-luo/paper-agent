import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiModelService } from "../src/agent/application/pi-model-service.ts";
import { WebAgentService } from "../src/agent/application/web-agent-service.ts";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";

const paths: string[] = [];
afterEach(async () => {
	await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-native-pi-"));
	paths.push(root);
	const service = new PiModelService(root);
	await service.initialize();
	return { root, service };
}

describe("project Pi model configuration", () => {
	it("reuses the availability view until model configuration actually changes", async () => {
		const { root, service } = await fixture();
		const agent = await WebAgentService.create({ projectRoot: root, piModels: service });
		const views = vi.spyOn(service, "view");
		try {
			await agent.getConfig();
			const before = views.mock.calls.length;
			await agent.getConfig();
			await agent.getConfig();
			expect(views).toHaveBeenCalledTimes(before);
			await writeFile(join(service.directory, "auth.json"), JSON.stringify({
				deepseek: { type: "api_key", key: "synthetic-config-change" },
			}));
			const config = await agent.getConfig();
			expect(views.mock.calls.length).toBeGreaterThan(before);
			expect(config.configuredModels.some((model) => model.providerId === "deepseek")).toBe(true);
		} finally {
			views.mockRestore();
			await agent.close();
		}
	});

	it("lists exactly the native providers without exposing keys and retains native model metadata", async () => {
		const { service } = await fixture();
		expect((await service.credential("deepseek", [])).type).toBe("secret");
		await service.save("deepseek", ["synthetic-native-pi-key"]);
		const view = await service.view();
		expect(view.providers.map((p) => p.id).sort()).toEqual(
			builtinProviders()
				.map((p) => p.id)
				.sort(),
		);
		expect(JSON.stringify(view)).not.toContain("synthetic-native-pi-key");
		const native = builtinProviders()
			.find((p) => p.id === "deepseek")!
			.getModels()[0];
		const model = (await service.runtime()).getModel("deepseek", native.id)!;
		expect(model).toMatchObject({ cost: native.cost, contextWindow: native.contextWindow, compat: native.compat });
		await service.select(`deepseek/${native.id}`);
		expect((await service.view()).activeKey).toBe(`deepseek/${native.id}`);
		expect(JSON.parse(await readFile(join(service.directory, "auth.json"), "utf8"))).toMatchObject({
			deepseek: { type: "api_key", key: "synthetic-native-pi-key" },
		});
		expect(await service.credential("amazon-bedrock", [])).toMatchObject({ type: "select" });
		await expect(service.credential("custom-relay", [])).rejects.toThrow("内置提供商");
	});

	it("loads a file-managed relay and notices external changes without registering ad-hoc models", async () => {
		const { service } = await fixture();
		const models = {
			providers: {
				relay: {
					baseUrl: "http://127.0.0.1:12345/v1",
					api: "openai-completions",
					models: [
						{
							id: "relay-model",
							reasoning: true,
							input: ["text"],
							contextWindow: 54321,
							maxTokens: 1000,
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		};
		await writeFile(join(service.directory, "models.json"), JSON.stringify(models));
		await writeFile(
			join(service.directory, "auth.json"),
			JSON.stringify({ relay: { type: "api_key", key: "synthetic-relay-key" } }),
		);
		const view = await service.view();
		expect(view.models.some((m) => m.key === "relay/relay-model")).toBe(true);
		expect(view.providers.some((p) => p.id === "relay")).toBe(false);
		expect((await service.runtime()).getModel("relay", "relay-model")).toMatchObject({
			contextWindow: 54321,
			cost: { input: 1 },
		});
		models.providers.relay.models[0].contextWindow = 765432;
		await writeFile(join(service.directory, "models.json"), JSON.stringify(models));
		expect((await service.runtime()).getModel("relay", "relay-model")?.contextWindow).toBe(765432);
	});



	it("requires exact confirmation, saves through Pi, and rejects web-created custom providers", async () => {
		const { root } = await fixture();
		const app = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, "data") });
		await app.initialize();
		const server = await startLocalWebServer(app, { staticRoot: join(root, "web") });
		const post = async (path: string, body: unknown) =>
			fetch(server.url + path, {
				method: "POST",
				headers: { "content-type": "application/json", origin: server.url },
				body: JSON.stringify(body),
			});
		try {
			const payload = { providerId: "deepseek", answers: ["synthetic-route-key"] };
			const preparedResponse = await post("/api/pi/auth/prepare", payload);
			const { prepared } = (await preparedResponse.json()) as any;
			expect(prepared).toBeTruthy();
			expect(JSON.stringify(prepared)).not.toContain(payload.answers[0]);
			const confirmation = await post("/api/operations/confirm", {
				operationId: prepared.operationId,
				manifestFingerprint: prepared.manifestFingerprint,
			});
			const grant = await confirmation.json();
			expect((await post("/api/pi/auth/execute", { ...payload, answers: ["other-key"], grant })).status).not.toBe(
				200,
			);
			expect((await post("/api/pi/auth/execute", { ...payload, grant })).status).toBe(200);
			const view = await (await fetch(`${server.url}/api/pi/models`)).json();
			expect(JSON.stringify(view)).not.toContain(payload.answers[0]);
			expect((await post("/api/pi/auth/prepare", { providerId: "relay", answers: ["secret"] })).status).not.toBe(
				200,
			);
		} finally {
			await server.close();
			await app.close();
		}
	});

	it("streams and resumes through the native runtime using relay files and the existing tool boundary", async () => {
		const requests: any[] = [];
		const provider = createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			requests.push({
				body: JSON.parse(Buffer.concat(chunks).toString()),
				authorization: req.headers.authorization,
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				`data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "native reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const { root, service } = await fixture();
		const config = {
			providers: {
				relay: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
					models: [{ id: "relay-model", input: ["text"], contextWindow: 128000, maxTokens: 1024 }],
				},
			},
		};
		await writeFile(join(service.directory, "models.json"), JSON.stringify(config));
		await writeFile(
			join(service.directory, "auth.json"),
			JSON.stringify({ relay: { type: "api_key", key: "synthetic-stream-key" } }),
		);
		await service.select("relay/relay-model");
		let agent = await WebAgentService.create({ projectRoot: root, piModels: service });
		try {
			const session = agent.createSession({ mode: "persistent" });
			for (const text of ["first marker", "second marker"]) {
				await agent.sendMessage(session.id, { message: text });
				await expect.poll(() => agent.getSession(session.id).status).not.toBe("running");
				expect(agent.getSession(session.id).messages.at(-1)?.content).toBe("native reply");
			}
			expect(requests[0].authorization).toBe("Bearer synthetic-stream-key");
			expect(requests[0].body.tools ?? []).toEqual([]);
			await agent.close();
			agent = await WebAgentService.create({ projectRoot: root, piModels: new PiModelService(root) });
			await agent.sendMessage(session.id, { message: "after restart" });
			await expect.poll(() => agent.getSession(session.id).status).not.toBe("running");
			expect(JSON.stringify(requests.at(-1).body.messages)).toContain("first marker");
			expect(JSON.stringify(await agent.getConfig())).not.toContain("synthetic-stream-key");
		} finally {
			await agent.close();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});
});
