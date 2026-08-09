import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultPaperAgentConfig,
	loadPaperAgentConfig,
	probeModelToolCalling,
	resolvePaperAgentConfigPath,
	savePaperAgentConfig,
} from "../src/app-config.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";

const originalProbeKey = process.env.PAPER_AGENT_TEST_PROBE_KEY;
const originalTeamServerUrl = process.env.PAPER_AGENT_TEAM_SERVER_URL;
const originalTeamNamespace = process.env.PAPER_AGENT_TEAM_NAMESPACE;
const originalTeamToken = process.env.PAPER_AGENT_TEAM_TOKEN;
const originalTeamDemo = process.env.PAPER_AGENT_TEAM_DEMO;
afterEach(() => {
	if (originalProbeKey === undefined) delete process.env.PAPER_AGENT_TEST_PROBE_KEY;
	else process.env.PAPER_AGENT_TEST_PROBE_KEY = originalProbeKey;
	if (originalTeamServerUrl === undefined) delete process.env.PAPER_AGENT_TEAM_SERVER_URL;
	else process.env.PAPER_AGENT_TEAM_SERVER_URL = originalTeamServerUrl;
	if (originalTeamNamespace === undefined) delete process.env.PAPER_AGENT_TEAM_NAMESPACE;
	else process.env.PAPER_AGENT_TEAM_NAMESPACE = originalTeamNamespace;
	if (originalTeamToken === undefined) delete process.env.PAPER_AGENT_TEAM_TOKEN;
	else process.env.PAPER_AGENT_TEAM_TOKEN = originalTeamToken;
	if (originalTeamDemo === undefined) delete process.env.PAPER_AGENT_TEAM_DEMO;
	else process.env.PAPER_AGENT_TEAM_DEMO = originalTeamDemo;
});

describe("Paper Agent local configuration", () => {
	it("initializes runtime services without creating an empty persistent corpus", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-runtime-only-"));
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			await application.initialize();
			await expect(access(join(root, ".paper-agent", "corpus"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await application.close();
		}
	});

	it("rejects research namespaces that could escape the application data root", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-research-namespace-"));
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		expect(() => application.researchWorkspace("..\\outside")).toThrow("namespace must use");
		await application.close();
	});

	it("stores only environment-variable names and round-trips validated settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-config-"));
		const value = defaultPaperAgentConfig();
		value.storage.defaultNamespace = "researcher-a";
		value.model = {
			providerId: "relay",
			modelId: "research-model",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
			apiKeyEnvironmentVariable: "PAPER_AGENT_RELAY_API_KEY",
		};
		await savePaperAgentConfig(root, value);
		const loaded = await loadPaperAgentConfig(root);
		expect(loaded).toMatchObject({
			storage: { defaultNamespace: "researcher-a" },
			model: { modelId: "research-model" },
		});
		const raw = await readFile(resolvePaperAgentConfigPath(root), "utf8");
		expect(raw).toContain("PAPER_AGENT_RELAY_API_KEY");
		expect(raw).not.toContain("sk-");

		await expect(
			savePaperAgentConfig(root, {
				...value,
				model: { ...value.model, apiKeyEnvironmentVariable: "sk-inline-secret" },
			}),
		).rejects.toThrow("environment variable");
	});

	it("uses an ephemeral team demo connection from the process environment without persisting its token", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-environment-"));
		process.env.PAPER_AGENT_TEAM_SERVER_URL = "http://127.0.0.1:4317";
		process.env.PAPER_AGENT_TEAM_NAMESPACE = "solo-demo";
		process.env.PAPER_AGENT_TEAM_TOKEN = "temporary-demo-secret";
		const loaded = await loadPaperAgentConfig(root);
		expect(loaded.team).toEqual({
			serverUrl: "http://127.0.0.1:4317",
			namespace: "solo-demo",
			tokenEnvironmentVariable: "PAPER_AGENT_TEAM_TOKEN",
		});
		await expect(access(resolvePaperAgentConfigPath(root))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("lets the explicit team-demo marker override a configured production team endpoint for the demo process only", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-demo-override-"));
		const configured = defaultPaperAgentConfig();
		configured.team = {
			serverUrl: "https://team.example.com",
			namespace: "production",
			tokenEnvironmentVariable: "PAPER_AGENT_PRODUCTION_TEAM_TOKEN",
		};
		await savePaperAgentConfig(root, configured);
		process.env.PAPER_AGENT_TEAM_SERVER_URL = "http://127.0.0.1:4317";
		process.env.PAPER_AGENT_TEAM_NAMESPACE = "solo-demo";
		process.env.PAPER_AGENT_TEAM_DEMO = "1";
		expect(await loadPaperAgentConfig(root)).toMatchObject({
			team: {
				serverUrl: "http://127.0.0.1:4317",
				namespace: "solo-demo",
				tokenEnvironmentVariable: "PAPER_AGENT_TEAM_TOKEN",
			},
		});
	});

	it("keeps older configs compatible and applies saved search defaults to queued jobs", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-config-"));
		await savePaperAgentConfig(root, {
			version: 1,
			interface: { port: 0, openBrowser: false },
			storage: { defaultNamespace: "lab-a" },
			search: {
				providers: ["dblp", "openalex"],
				maxResultsPerProvider: 37,
				pagesPerProvider: 3,
				queryExpansions: ["protocol state inference", "stateful fuzzing"],
				reuseCorpus: false,
			},
			updatedAt: new Date().toISOString(),
		});
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			const queued = await application.enqueueLiteratureSearch({ query: "  fuzzing  " });
			expect(queued.input).toMatchObject({
				query: "fuzzing",
				providers: ["dblp", "openalex"],
				maxResultsPerProvider: 37,
				pagesPerProvider: 3,
				queryExpansions: ["protocol state inference", "stateful fuzzing"],
				namespace: "lab-a",
				reuseCorpus: false,
			});
			await application.jobs.cancel(queued.id);
		} finally {
			await application.close();
		}

		await writeFile(
			resolvePaperAgentConfigPath(root),
			JSON.stringify({
				version: 1,
				interface: { port: 0, openBrowser: true },
				storage: { defaultNamespace: "legacy" },
				search: { providers: ["arxiv"], maxResultsPerProvider: 10 },
				updatedAt: new Date().toISOString(),
			}),
		);
		expect(await loadPaperAgentConfig(root)).toMatchObject({
			search: { pagesPerProvider: 1, queryExpansions: [], reuseCorpus: true },
		});
	});

	it("requires an exact one-time grant before changing configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-config-consent-"));
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			const next = defaultPaperAgentConfig();
			next.storage.defaultNamespace = "approved";
			const prepared = await application.prepareConfigurationWrite(next);
			const grant = await application.confirmOperation(prepared.operationId, prepared.manifestFingerprint);
			await expect(
				application.writeConfiguration({ ...next, storage: { defaultNamespace: "changed" } }, grant),
			).rejects.toThrow("does not match");
			await expect(application.writeConfiguration(next, grant)).resolves.toMatchObject({
				config: { storage: { defaultNamespace: "approved" } },
			});
		} finally {
			await application.close();
		}
	});

	it("requires Pi-session verification for API kinds without an automatic probe implementation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-manual-model-probe-"));
		await savePaperAgentConfig(root, {
			...defaultPaperAgentConfig(),
			model: {
				providerId: "anthropic-relay",
				modelId: "research-model",
				api: "anthropic-messages",
				baseUrl: "https://relay.example.com/v1",
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
			},
		});
		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			await expect(application.prepareModelProbe()).rejects.toThrow(
				"Verify anthropic-messages from a Pi agent session",
			);
		} finally {
			await application.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("detects an OpenAI-compatible structured function call without persisting the key", async () => {
		process.env.PAPER_AGENT_TEST_PROBE_KEY = "test-only-secret";
		const server = createServer(async (request, response) => {
			let requestBody = "";
			for await (const chunk of request) requestBody += chunk.toString();
			expect(request.headers.authorization).toBe("Bearer test-only-secret");
			expect(JSON.parse(requestBody)).toMatchObject({ model: "probe-model", tools: [{ type: "function" }] });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					choices: [
						{ message: { tool_calls: [{ function: { name: "paper_agent_probe", arguments: '{"ok":true}' } }] } },
					],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const result = await probeModelToolCalling({
				providerId: "fixture",
				modelId: "probe-model",
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
			});
			expect(result).toMatchObject({ supported: true, status: 200 });
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});

	it("uses the Responses API function schema for a configured responses endpoint", async () => {
		process.env.PAPER_AGENT_TEST_PROBE_KEY = "test-only-secret";
		const server = createServer(async (request, response) => {
			let requestBody = "";
			for await (const chunk of request) requestBody += chunk.toString();
			const body = JSON.parse(requestBody) as Record<string, any>;
			expect(body.tools).toEqual([
				{
					type: "function",
					name: "paper_agent_probe",
					description: expect.any(String),
					parameters: expect.objectContaining({ type: "object" }),
					strict: true,
				},
			]);
			expect(body.tool_choice).toEqual({ type: "function", name: "paper_agent_probe" });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					output: [{ type: "function_call", name: "paper_agent_probe", arguments: '{"ok":true}' }],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const result = await probeModelToolCalling({
				providerId: "fixture",
				modelId: "probe-model",
				api: "openai-responses",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
			});
			expect(result).toMatchObject({ supported: true, status: 200 });
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});
});
