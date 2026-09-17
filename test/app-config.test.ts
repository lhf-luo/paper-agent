import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { ensureObsidianVault } from "../src/app/application/paper-agent-wiki.ts";
import {
	defaultPaperAgentConfig,
	loadPaperAgentConfig,
	loadPaperAgentConfigSync,
	redactPaperAgentConfig,
	relayHeadersForModelApi,
	resolvePaperAgentConfigPaths,
	savePaperAgentConfig,
} from "../src/config/application/config-service.ts";
import {
	discoverModelEndpointModels,
	mergeDiscoveredModels,
	probeModelImageInput,
	probeModelToolCalling,
	removeConfiguredModel,
	removeConfiguredProvider,
	resolveConfiguredModel,
} from "../src/config/application/model-service.ts";
import type { PaperAgentModelConfig } from "../src/config/domain/config-types.ts";

function modelCapabilities(): Pick<PaperAgentModelConfig, "reasoning" | "input" | "contextWindow" | "maxTokens"> {
	return { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384 };
}

const originalProbeKey = process.env.PAPER_AGENT_TEST_PROBE_KEY;
afterEach(() => {
	if (originalProbeKey === undefined) delete process.env.PAPER_AGENT_TEST_PROBE_KEY;
	else process.env.PAPER_AGENT_TEST_PROBE_KEY = originalProbeKey;
});

describe("Paper Agent local configuration", () => {
	it("registers an Obsidian Wiki vault once and reuses its stable vault id", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-obsidian-"));
		try {
			const vaultPath = join(root, "wiki", "default");
			const configPath = join(root, "obsidian", "obsidian.json");
			await mkdir(vaultPath, { recursive: true });
			const first = await ensureObsidianVault(vaultPath, configPath);
			const second = await ensureObsidianVault(vaultPath, configPath);
			expect(second).toBe(first);
			const config = JSON.parse(await readFile(configPath, "utf8")) as {
				vaults: Record<string, { path: string; open?: boolean }>;
			};
			expect(config.vaults[first].path).toBe(vaultPath);
			expect(config.vaults[first].open).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

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
		expect(() => application.researchNotebook("..\\outside")).toThrow("namespace must use");
		await application.close();
	});

	it("stores only environment-variable names and round-trips validated settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-config-"));
		const value = defaultPaperAgentConfig();
		value.storage.defaultNamespace = "researcher-a";
		value.externalTools.commandDirectories = [join(root, "tools", "poppler"), join(root, "tools", "tesseract")];
		value.agent.builtinTools = ["read", "grep", "find", "ls"];
		value.agent.shellPath = join(root, "tools", "bash.exe");
		value.wiki.obsidianPath = join(root, "tools", "obsidian");
		value.model = {
			...modelCapabilities(),
			providerId: "relay",
			modelId: "research-model",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
			apiKeyEnvironmentVariable: "PAPER_AGENT_RELAY_API_KEY",
			headers: { "user-agent": "paper-agent-test/1.0", "x-client": "research" },
		};
		await savePaperAgentConfig(root, value);
		const loaded = await loadPaperAgentConfig(root);
		expect(loaded).toMatchObject({
			storage: { defaultNamespace: "researcher-a" },
			externalTools: {
				commandDirectories: [join(root, "tools", "poppler"), join(root, "tools", "tesseract")],
			},
			agent: { builtinTools: ["read", "grep", "find", "ls"], shellPath: join(root, "tools", "bash.exe") },
			pdfTranslation: { engine: "siliconflowfree" },
			wiki: { obsidianPath: join(root, "tools", "obsidian") },
			model: { modelId: "research-model" },
		});
		const paths = resolvePaperAgentConfigPaths(root);
		const appRaw = await readFile(paths.appFile, "utf8");
		const raw = await readFile(paths.modelsFile, "utf8");
		const authRaw = await readFile(paths.modelAuthFile, "utf8");
		expect(raw).not.toContain("PAPER_AGENT_RELAY_API_KEY");
		expect(raw).not.toContain("sk-");
		expect(JSON.parse(appRaw)).toMatchObject({
			externalTools: {
				commandDirectories: [join(root, "tools", "poppler"), join(root, "tools", "tesseract")],
			},
			agent: { builtinTools: ["read", "grep", "find", "ls"], shellPath: join(root, "tools", "bash.exe") },
			confirmations: {
				requireAgentWriteConfirmation: false,
				requirePersonalLibraryWriteConfirmation: false,
				requirePersonalLibraryDeleteConfirmation: true,
				requireResearchConfirmation: true,
				requirePdfArtifactConfirmation: true,
			},
			pdfTranslation: { engine: "siliconflowfree" },
			wiki: { obsidianPath: join(root, "tools", "obsidian") },
		});
		expect(authRaw).toContain("PAPER_AGENT_RELAY_API_KEY");
		expect(JSON.parse(raw)).toMatchObject({
			active: "relay/research-model",
			providers: {
				relay: {
					models: [{ id: "research-model", input: ["text"] }],
				},
			},
		});

		expect(loaded.model?.headers).toEqual({ "user-agent": "paper-agent-test/1.0", "x-client": "research" });
		expect(raw).toContain("paper-agent-test/1.0");

		await expect(
			savePaperAgentConfig(root, {
				...value,
				model: { ...value.model, apiKeyEnvironmentVariable: "sk-inline-secret" },
			}),
		).rejects.toThrow("environment variable");
		await expect(
			savePaperAgentConfig(root, {
				...value,
				externalTools: { commandDirectories: [""] },
			}),
		).rejects.toThrow("externalTools.commandDirectories[0] must be a non-empty path");
		await expect(
			savePaperAgentConfig(root, {
				...value,
				model: { ...value.model, headers: { authorization: "Bearer forbidden" } },
			}),
		).rejects.toThrow("not allowed");
	});

	it("defaults missing confirmation settings and rejects non-boolean switches", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-confirmation-config-"));
		expect((await loadPaperAgentConfig(root)).confirmations).toEqual({
			requireAgentWriteConfirmation: false,
			requirePersonalLibraryWriteConfirmation: false,
			requirePersonalLibraryDeleteConfirmation: true,
			requireResearchConfirmation: true,
			requirePdfArtifactConfirmation: true,
			requireWikiWriteConfirmation: true,
		});
		await expect(
			savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				confirmations: {
					...defaultPaperAgentConfig().confirmations,
					requireResearchConfirmation: "sometimes",
				},
			}),
		).rejects.toThrow("confirmations.requireResearchConfirmation must be a boolean");
	});

	it("defaults and validates the PDF translation engine", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-translation-config-"));
		expect((await loadPaperAgentConfig(root)).pdfTranslation).toEqual({ engine: "siliconflowfree" });
		await expect(
			savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				pdfTranslation: { engine: "unknown" },
			}),
		).rejects.toThrow("pdfTranslation.engine must be siliconflowfree or active-model");

		const selected = {
			...modelCapabilities(),
			providerId: "translation-provider",
			modelId: "translation-model",
			api: "openai-completions" as const,
			baseUrl: "https://translation.example.com/v1",
			apiKeyEnvironmentVariable: "PAPER_AGENT_TRANSLATION_KEY",
		};
		await savePaperAgentConfig(root, {
			...defaultPaperAgentConfig(),
			model: selected,
			models: [selected],
			pdfTranslation: {
				engine: "active-model",
				modelKey: "translation-provider/translation-model",
				command: "D:\\Tools With Space\\pdf2zh_next.exe",
			},
		});
		expect((await loadPaperAgentConfig(root)).pdfTranslation).toEqual({
			engine: "active-model",
			modelKey: "translation-provider/translation-model",
			command: "D:\\Tools With Space\\pdf2zh_next.exe",
		});
		await expect(
			savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				pdfTranslation: { engine: "siliconflowfree", command: "pdf2zh_next\n--unsafe" },
			}),
		).rejects.toThrow("pdfTranslation.command must be a single executable name or path");
		await expect(
			savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				model: selected,
				models: [selected],
				pdfTranslation: { engine: "active-model", modelKey: "translation-provider/missing" },
			}),
		).rejects.toThrow("pdfTranslation.modelKey was not found in configured models");
	});

	it("rejects unknown Pi built-in tool names", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-config-tools-"));
		await expect(
			savePaperAgentConfig(root, {
				...defaultPaperAgentConfig(),
				agent: { builtinTools: ["read", "unknown-tool"] },
			}),
		).rejects.toThrow("agent.builtinTools");
	});

	it("removes the retired team.json connection configuration when saving", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-plaintext-token-"));
		const paths = resolvePaperAgentConfigPaths(root);
		await savePaperAgentConfig(root, defaultPaperAgentConfig());
		await expect(access(join(paths.directory, "team.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes split configuration files and reads them from the sync loader", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-split-config-"));
		const value = defaultPaperAgentConfig();
		value.search.providers = ["arxiv", "dblp"];
		value.search.doiEnrichmentProviders = ["crossref", "opencitations"];
		value.credentials = {
			coreApiKey: "core-test-key",
			githubToken: "github-test-token",
			zoteroLocalApiKey: "zotero-test-key",
			zoteroServerId: "server-one",
		};
		value.network = { proxyEnabled: true, proxyUrl: "http://127.0.0.1:7890", noProxyHosts: ["localhost"] };
		await savePaperAgentConfig(root, value);
		const paths = resolvePaperAgentConfigPaths(root);
		await expect(access(paths.appFile)).resolves.toBeUndefined();
		await expect(access(paths.searchFile)).resolves.toBeUndefined();
		await expect(access(paths.credentialsFile)).resolves.toBeUndefined();
		expect(loadPaperAgentConfigSync(root)).toMatchObject({
			search: {
				providers: ["arxiv", "dblp"],
				doiEnrichmentProviders: ["crossref", "opencitations"],
			},
			credentials: {
				coreApiKey: "core-test-key",
				githubToken: "github-test-token",
				zoteroLocalApiKey: "zotero-test-key",
				zoteroServerId: "server-one",
			},
			network: { proxyUrl: "http://127.0.0.1:7890" },
		});
	});

	it("redacts optional GitHub and Zotero keys from configuration output", () => {
		const value = defaultPaperAgentConfig();
		value.credentials = {
			githubToken: "github-test-token",
			zoteroLocalApiKey: "zotero-test-key",
			zoteroServerId: "server-one",
		};
		expect(redactPaperAgentConfig(value).credentials).toMatchObject({
			githubToken: "[redacted]",
			zoteroLocalApiKey: "[redacted]",
			zoteroServerId: "server-one",
		});
	});

	it("preserves stored secrets when the Web UI saves a redacted configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-redacted-save-"));
		const configured = defaultPaperAgentConfig();
		configured.model = {
			...modelCapabilities(),
			providerId: "deepseek",
			modelId: "deepseek-test",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "original-model-secret",
		};
		configured.models = [configured.model];
		configured.credentials = { coreApiKey: "original-core-secret", githubToken: "original-github-secret" };
		await savePaperAgentConfig(root, configured);

		const fromWeb = redactPaperAgentConfig(await loadPaperAgentConfig(root));
		fromWeb.confirmations.requireResearchConfirmation = false;
		await savePaperAgentConfig(root, fromWeb);

		const reloaded = await loadPaperAgentConfig(root);
		expect(reloaded.model?.apiKey).toBe("original-model-secret");
		expect(reloaded.credentials).toMatchObject({
			coreApiKey: "original-core-secret",
			githubToken: "original-github-secret",
		});
		expect(reloaded.confirmations.requireResearchConfirmation).toBe(false);
		const paths = resolvePaperAgentConfigPaths(root);
		expect(await readFile(paths.modelAuthFile, "utf8")).not.toContain("[redacted]");
		expect(await readFile(paths.credentialsFile, "utf8")).not.toContain("[redacted]");
	});

	it("rejects a redacted secret when no original credential exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-orphan-redaction-"));
		const configured = defaultPaperAgentConfig();
		configured.model = {
			...modelCapabilities(),
			providerId: "deepseek",
			modelId: "deepseek-test",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "[redacted]",
		};
		await expect(savePaperAgentConfig(root, configured)).rejects.toThrow("no original credential is available");
	});

	it("applies saved split search defaults to queued jobs", async () => {
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
	});

	it.each(["", "   ", "\n\t"])("rejects a blank model discovery key before making a request (%j)", async (apiKey) => {
		const fetcher = vi.fn();
		await expect(
			discoverModelEndpointModels({
				providerId: "fixture",
				api: "openai-completions",
				baseUrl: "https://provider.example/v1",
				apiKey,
				fetcher,
			}),
		).rejects.toThrow("API key 不能为空");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("discovers OpenAI-compatible models from a provider endpoint", async () => {
		const server = createServer(async (request, response) => {
			expect(request.url).toBe("/v1/models");
			expect(request.headers.authorization).toBe("Bearer test-discovery-key");
			expect(request.headers["user-agent"]).toBe("claude-cli/2.1.198 (external, sdk-cli)");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }, { ignored: true }] }));
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const models = await discoverModelEndpointModels({
				providerId: "fixture",
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKey: "test-discovery-key",
				headers: relayHeadersForModelApi("openai-completions"),
			});
			expect(models.map((model) => model.modelId)).toEqual(["alpha", "zeta"]);
			expect(models[0]).toMatchObject({
				providerId: "fixture",
				api: "openai-completions",
				apiKey: "test-discovery-key",
				headers: expect.objectContaining({ "x-app": "cli" }),
			});
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});

	it("defaults discovered and refreshed models to text and image without selecting an active model", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-model-add-"));
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					data: [{ id: "alpha", input_modalities: ["text", "image"] }, { id: "beta" }, { id: "gamma" }],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const port = (server.address() as AddressInfo).port;
			const argumentsForAdd = [
				"scripts/configure-model.ts",
				"add",
				"--provider",
				"fixture",
				"--base-url",
				`http://127.0.0.1:${port}/v1`,
				"--api-key",
				"test-key",
				"--yes",
			];
			const executionOptions = {
				cwd: process.cwd(),
				env: { ...process.env, PAPER_AGENT_CONFIG_DIR: join(root, ".paper-agent", "config") },
			};
			await promisify(execFile)(process.execPath, argumentsForAdd, executionOptions);
			const stored = JSON.parse(await readFile(join(root, ".paper-agent", "config", "models.json"), "utf8"));
			expect(stored.active).toBeUndefined();
			expect(
				stored.providers.fixture.models.map((model: { id: string; reasoning: boolean; input: string[] }) => ({
					id: model.id,
					reasoning: model.reasoning,
					input: model.input,
				})),
			).toEqual([
				{ id: "alpha", reasoning: true, input: ["text", "image"] },
				{ id: "beta", reasoning: true, input: ["text", "image"] },
				{ id: "gamma", reasoning: true, input: ["text", "image"] },
			]);
			const loaded = await loadPaperAgentConfig(root);
			expect(loaded.model).toBeUndefined();
			expect(loaded.models).toHaveLength(3);
			await savePaperAgentConfig(root, {
				...loaded,
				models: loaded.models?.map((model) => ({ ...model, input: ["text"] })),
			});
			await promisify(execFile)(process.execPath, argumentsForAdd, executionOptions);
			const refreshed = await loadPaperAgentConfig(root);
			expect(refreshed.models?.every((model) => model.input.includes("image"))).toBe(true);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("verifies image input with an actual PNG challenge", async () => {
		const requests: unknown[] = [];
		const result = await probeModelImageInput(
			{
				...modelCapabilities(),
				providerId: "fixture",
				modelId: "vision-model",
				api: "openai-completions",
				baseUrl: "https://models.example.com/v1",
				apiKey: "test-key",
				reasoning: true,
			},
			30_000,
			(async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				requests.push(body);
				expect(body.max_tokens).toBe(8192);
				expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
				return new Response(JSON.stringify({ choices: [{ message: { content: "BLUE GREEN BLUE GREEN" } }] }), {
					status: 200,
				});
			}) as typeof fetch,
		);
		expect(requests).toHaveLength(1);
		expect(result).toMatchObject({ supported: true, status: 200 });
	});

	it("does not mark a model as visual when the endpoint rejects image content", async () => {
		const result = await probeModelImageInput(
			{
				...modelCapabilities(),
				providerId: "fixture",
				modelId: "text-model",
				api: "openai-completions",
				baseUrl: "https://models.example.com/v1",
				apiKey: "test-key",
			},
			30_000,
			(async () => new Response("image input is unsupported", { status: 400 })) as typeof fetch,
		);
		expect(result).toMatchObject({ supported: false, status: 400 });
	});

	it("replaces a provider's old protocol entries without retaining stale probe results", () => {
		const merged = mergeDiscoveredModels(
			[
				{
					...modelCapabilities(),
					providerId: "relay",
					modelId: "reasoning-model",
					api: "openai-responses",
					baseUrl: "https://relay.example.com/v1",
					apiKey: "old-key",
					toolCallingProbe: {
						supported: true,
						reason: "old protocol",
						latencyMs: 1,
						checkedAt: "2026-01-01T00:00:00.000Z",
					},
				},
				{
					...modelCapabilities(),
					providerId: "other",
					modelId: "other-model",
					api: "openai-completions",
					baseUrl: "https://other.example.com/v1",
				},
			],
			[
				{
					...modelCapabilities(),
					providerId: "relay",
					modelId: "reasoning-model",
					api: "openai-completions",
					baseUrl: "https://relay.example.com/v1",
					apiKey: "new-key",
				},
			],
		);

		expect(merged).toHaveLength(2);
		expect(merged.find((model) => model.providerId === "relay")).toMatchObject({
			api: "openai-completions",
			apiKey: "new-key",
		});
		expect(merged.find((model) => model.providerId === "relay")?.toolCallingProbe).toBeUndefined();
	});

	it("removes a configured model and selects an explicit active replacement", () => {
		const first: PaperAgentModelConfig = {
			...modelCapabilities(),
			providerId: "relay",
			modelId: "first",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
		};
		const second: PaperAgentModelConfig = { ...first, modelId: "second", reasoning: true };
		const result = removeConfiguredModel([first, second], first, "relay/first", "relay/second");

		expect(result.removed).toBe(first);
		expect(result.models).toEqual([second]);
		expect(result.active).toBe(second);
	});

	it("clears the active model when it is removed without a replacement", () => {
		const active: PaperAgentModelConfig = {
			...modelCapabilities(),
			providerId: "relay",
			modelId: "active",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
		};
		const remaining: PaperAgentModelConfig = { ...active, modelId: "remaining" };
		const result = removeConfiguredModel([active, remaining], active, "active");

		expect(result.models).toEqual([remaining]);
		expect(result.active).toBeUndefined();
	});

	it("removes a provider with all of its models and preserves an unrelated active model", () => {
		const kept: PaperAgentModelConfig = {
			...modelCapabilities(),
			providerId: "kept",
			modelId: "active",
			api: "openai-completions",
			baseUrl: "https://kept.example.com/v1",
		};
		const removed = [
			{ ...kept, providerId: "relay", modelId: "one" },
			{ ...kept, providerId: "relay", modelId: "two" },
		];
		const result = removeConfiguredProvider([kept, ...removed], kept, "relay");

		expect(result.removed).toEqual(removed);
		expect(result.models).toEqual([kept]);
		expect(result.active).toBe(kept);
	});

	it("requires provider/model when a bare model id is ambiguous", () => {
		const shared = {
			...modelCapabilities(),
			modelId: "shared",
			api: "openai-completions" as const,
			baseUrl: "https://relay.example.com/v1",
		};
		expect(() =>
			resolveConfiguredModel(
				[
					{ ...shared, providerId: "one" },
					{ ...shared, providerId: "two" },
				],
				"shared",
			),
		).toThrow("ambiguous");
	});

	it("rejects duplicate provider/model identities across protocols", async () => {
		const config = defaultPaperAgentConfig();
		await expect(
			savePaperAgentConfig(".", {
				...config,
				models: [
					{
						providerId: "relay",
						modelId: "duplicate",
						api: "openai-completions",
						baseUrl: "https://relay.example.com/v1",
					},
					{
						providerId: "relay",
						modelId: "duplicate",
						api: "openai-responses",
						baseUrl: "https://relay.example.com/v1",
					},
				],
			}),
		).rejects.toThrow("duplicate provider/model identity");
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
		let requests = 0;
		const server = createServer(async (request, response) => {
			requests += 1;
			let requestBody = "";
			for await (const chunk of request) requestBody += chunk.toString();
			expect(request.headers.authorization).toBe("Bearer test-only-secret");
			expect(request.headers["user-agent"]).toBe("paper-agent-probe-test/1.0");
			const body = JSON.parse(requestBody) as Record<string, any>;
			expect(body).toMatchObject({ model: "probe-model", tools: [{ type: "function" }] });
			if (requests === 2) {
				expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool" })]));
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								tool_calls: [
									{ id: "call_probe", function: { name: "paper_agent_probe", arguments: '{"ok":true}' } },
								],
							},
						},
					],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const result = await probeModelToolCalling({
				...modelCapabilities(),
				providerId: "fixture",
				modelId: "probe-model",
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
				headers: { "user-agent": "paper-agent-probe-test/1.0" },
			});
			expect(result).toMatchObject({ supported: true, status: 200 });
			expect(requests).toBe(2);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});

	it("uses the Responses API function schema for a configured responses endpoint", async () => {
		process.env.PAPER_AGENT_TEST_PROBE_KEY = "test-only-secret";
		let requests = 0;
		const server = createServer(async (request, response) => {
			requests += 1;
			let requestBody = "";
			for await (const chunk of request) requestBody += chunk.toString();
			const body = JSON.parse(requestBody) as Record<string, any>;
			if (requests === 2) {
				expect(body).toMatchObject({
					previous_response_id: "resp_probe",
					input: [{ type: "function_call_output", call_id: "call_probe", output: '{"ok":true}' }],
				});
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ id: "resp_continuation", output: [] }));
				return;
			}
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
					id: "resp_probe",
					output: [
						{ type: "function_call", name: "paper_agent_probe", call_id: "call_probe", arguments: '{"ok":true}' },
					],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const result = await probeModelToolCalling({
				...modelCapabilities(),
				providerId: "fixture",
				modelId: "probe-model",
				api: "openai-responses",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
			});
			expect(result).toMatchObject({ supported: true, status: 200 });
			expect(requests).toBe(2);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});

	it("reports a provider failure on the tool-result continuation", async () => {
		process.env.PAPER_AGENT_TEST_PROBE_KEY = "test-only-secret";
		let requests = 0;
		const server = createServer(async (_request, response) => {
			requests += 1;
			if (requests === 2) {
				response.writeHead(502);
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id: "resp_probe",
					output: [
						{ type: "function_call", name: "paper_agent_probe", call_id: "call_probe", arguments: '{"ok":true}' },
					],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const result = await probeModelToolCalling({
				...modelCapabilities(),
				providerId: "fixture",
				modelId: "probe-model",
				api: "openai-responses",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnvironmentVariable: "PAPER_AGENT_TEST_PROBE_KEY",
			});
			expect(result).toMatchObject({
				supported: false,
				status: 502,
				reason: expect.stringContaining("Tool-result continuation returned HTTP 502"),
			});
		} finally {
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	});

	it("discovers provider models without persisting the key or touching stored config", async () => {
		const server = createServer(async (request, response) => {
			expect(request.url).toBe("/v1/models");
			expect(request.headers.authorization).toBe("Bearer discovery-secret");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }, { noId: true }],
				}),
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const root = await mkdtemp(join(tmpdir(), "paper-agent-model-discovery-"));
		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			const address = server.address() as AddressInfo;
			const result = await application.discoverModels({
				providerId: "fixture-relay",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "discovery-secret",
			});
			expect(result.providerId).toBe("fixture-relay");
			expect(result.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
			// 发现过程只读远端：密钥不落盘，配置保持原样。
			await expect(access(join(root, ".paper-agent", "config", "auth.json"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			const stored = await loadPaperAgentConfig(root);
			expect(stored.models ?? []).toEqual([]);
			expect(stored.model).toBeUndefined();
		} finally {
			await application.close();
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires a restart only for storage changes, not for model list changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-model-restart-"));
		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			// 让存储路径与运行中的应用一致，以便把 restartRequired 隔离到"模型列表"这一项。
			const initial = defaultPaperAgentConfig();
			initial.storage.dataRoot = join(root, ".paper-agent");
			initial.storage.corpusRoot = join(root, ".paper-agent", "corpus");
			const prepared = await application.prepareConfigurationWrite(initial);
			const grant = await application.confirmOperation(prepared.operationId, prepared.manifestFingerprint);
			await expect(application.writeConfiguration(initial, grant)).resolves.toMatchObject({
				restartRequired: false,
			});

			const withModel = {
				...initial,
				models: [
					{
						providerId: "research-relay",
						modelId: "new-model",
						api: "openai-completions" as const,
						baseUrl: "https://relay.example.com/v1",
					},
				],
			};
			// 模型列表变化不再要求重启：Web Agent 会在读取配置视图与切换模型时重新
			// 对齐磁盘上的 models.json，设置页的增删立即反映到对话页。
			const next = await application.prepareConfigurationWrite(withModel);
			const nextGrant = await application.confirmOperation(next.operationId, next.manifestFingerprint);
			await expect(application.writeConfiguration(withModel, nextGrant)).resolves.toMatchObject({
				restartRequired: false,
			});

			// 存储路径变化仍然要求重启，避免把两种情形混为一谈。
			const movedStorage = { ...withModel, storage: { ...withModel.storage, defaultNamespace: "renamed" } };
			const moved = await application.prepareConfigurationWrite(movedStorage);
			const movedGrant = await application.confirmOperation(moved.operationId, moved.manifestFingerprint);
			await expect(application.writeConfiguration(movedStorage, movedGrant)).resolves.toMatchObject({
				restartRequired: true,
			});
		} finally {
			await application.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
