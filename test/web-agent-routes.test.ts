import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalWebServer } from "../src/local-web-server.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";
import type {
	WebAgentConfigView,
	WebAgentEvent,
	WebAgentServiceApi,
	WebAgentSessionSnapshot,
} from "../src/web-agent-service.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local Web Agent routes", () => {
	it("routes authenticated JSON and fetch-SSE requests through the injected service and closes it", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-agent-routes-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent</title>");
		const config: WebAgentConfigView = {
			providerId: "fake",
			modelId: "fake-model",
			baseUrl: "http://127.0.0.1:9000/v1",
			api: "openai-completions",
			configured: true,
			credentialsAvailable: true,
			credentialSource: "memory",
		};
		let snapshot: WebAgentSessionSnapshot = {
			id: "session-one",
			title: "Route test",
			mode: "persistent",
			status: "idle",
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:00.000Z",
			pendingUIRequests: 0,
			messages: [],
			tools: [],
			uiRequests: [],
		};
		let closed = false;
		const listeners = new Set<(event: WebAgentEvent) => void>();
		const agentService: WebAgentServiceApi = {
			getConfig: () => config,
			updateConfig: () => config,
			clearKey: () => ({ ...config, credentialsAvailable: false, credentialSource: "none" }),
			listSessions: () => [{ ...snapshot }],
			createSession: () => snapshot,
			getSession: () => snapshot,
			deleteSession: () => undefined,
			sendMessage: (_id, input) => {
				snapshot = {
					...snapshot,
					status: "running",
					messages: [
						{ id: "message-one", role: "user", content: input.message, status: "complete", createdAt: snapshot.createdAt },
					],
				};
				return snapshot;
			},
			abortSession: () => ({ ...snapshot, status: "idle" }),
			respondToUI: () => snapshot,
			subscribeSession: (_id, listener) => {
				listeners.add(listener);
				return { snapshot, unsubscribe: () => listeners.delete(listener) };
			},
			close: () => {
				closed = true;
			},
		};
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const server = await startLocalWebServer(application, {
			staticRoot,
			sessionToken: "route-token",
			agentService,
		});
		const authenticated = (path: string, init: RequestInit = {}) =>
			fetch(`${server.url}${path}`, {
				...init,
				headers: { authorization: "Bearer route-token", "content-type": "application/json", ...init.headers },
			});
		try {
			expect((await fetch(`${server.url}/api/agent/sessions`)).status).toBe(401);
			const configResponse = await authenticated("/api/agent/config");
			expect(configResponse.status).toBe(200);
			expect(await configResponse.json()).toMatchObject({ providerId: "fake", credentialsAvailable: true });
			const sessionsResponse = await authenticated("/api/agent/sessions");
			expect(await sessionsResponse.json()).toMatchObject({ sessions: [{ id: "session-one" }] });
			const messageResponse = await authenticated("/api/agent/sessions/session-one/messages", {
				method: "POST",
				body: JSON.stringify({ message: "route hello" }),
			});
			expect(messageResponse.status).toBe(202);
			expect(await messageResponse.json()).toMatchObject({
				status: "running",
				messages: [{ content: "route hello" }],
			});

			const controller = new AbortController();
			const eventResponse = await fetch(`${server.url}/api/agent/sessions/session-one/events`, {
				headers: { authorization: "Bearer route-token" },
				signal: controller.signal,
			});
			expect(eventResponse.status).toBe(200);
			const reader = eventResponse.body?.getReader();
			if (!reader) throw new Error("SSE response body missing");
			const firstChunk = await reader.read();
			const text = new TextDecoder().decode(firstChunk.value);
			expect(text).toContain("event: snapshot");
			expect(text).toContain("session-one");
			controller.abort();
		} finally {
			await server.close();
			await application.close();
		}
		expect(closed).toBe(true);
	});
});
