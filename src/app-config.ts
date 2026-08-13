import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ModelApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export function supportsAutomaticToolCallingProbe(api: ModelApiKind): boolean {
	return api === "openai-completions" || api === "openai-responses";
}

export interface PaperAgentModelConfig {
	providerId: string;
	modelId: string;
	api: ModelApiKind;
	baseUrl: string;
	apiKeyEnvironmentVariable?: string;
	apiKey?: string;
	toolCallingVerifiedAt?: string;
	toolCallingProbe?: {
		supported: boolean;
		reason: string;
		latencyMs: number;
		checkedAt: string;
	};
}

export interface PaperAgentTeamConfig {
	serverUrl: string;
	namespace: string;
	tokenEnvironmentVariable: string;
}

export interface PaperAgentConfig {
	version: 1;
	interface: {
		port: number;
		openBrowser: boolean;
	};
	storage: {
		dataRoot?: string;
		corpusRoot?: string;
		defaultNamespace: string;
	};
	search: {
		providers: string[];
		maxResultsPerProvider: number;
		pagesPerProvider: number;
		queryExpansions: string[];
		reuseCorpus: boolean;
	};
	network?: {
		proxyEnabled?: boolean;
		proxyUrl?: string;
	};
	model?: PaperAgentModelConfig;
	models?: PaperAgentModelConfig[];
	team?: PaperAgentTeamConfig;
	updatedAt: string;
}

export interface ModelProbeResult {
	supported: boolean;
	reason: string;
	latencyMs: number;
	checkedAt: string;
	status?: number;
}

interface PiModelsFile {
	providers?: Record<
		string,
		{
			baseUrl?: unknown;
			api?: unknown;
			apiKey?: unknown;
			models?: Array<{ id?: unknown; name?: unknown }>;
		}
	>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{1,127}$/;

export function defaultPaperAgentConfig(): PaperAgentConfig {
	return {
		version: 1,
		interface: { port: 0, openBrowser: true },
		storage: { defaultNamespace: "default" },
		search: {
			providers: ["arxiv", "openalex", "crossref", "semanticscholar"],
			maxResultsPerProvider: 20,
			pagesPerProvider: 1,
			queryExpansions: [],
			reuseCorpus: true,
		},
		updatedAt: new Date().toISOString(),
	};
}

export function resolvePaperAgentConfigPath(projectRoot: string): string {
	const override = process.env.PAPER_AGENT_CONFIG;
	return resolve(override ? override : join(projectRoot, ".paper-agent", "config.json"));
}

function withEnvironmentTeamConfig(config: PaperAgentConfig): PaperAgentConfig {
	const serverUrl = process.env.PAPER_AGENT_TEAM_SERVER_URL;
	const demoOverride = process.env.PAPER_AGENT_TEAM_DEMO === "1";
	if ((config.team && !demoOverride) || !serverUrl) return config;
	const namespace = process.env.PAPER_AGENT_TEAM_NAMESPACE ?? config.storage.defaultNamespace;
	if (!SAFE_SEGMENT.test(namespace)) throw new Error("PAPER_AGENT_TEAM_NAMESPACE is invalid");
	return {
		...config,
		team: {
			serverUrl: validatedUrl(serverUrl, "PAPER_AGENT_TEAM_SERVER_URL", true),
			namespace,
			tokenEnvironmentVariable: "PAPER_AGENT_TEAM_TOKEN",
		},
	};
}

function optionalAbsolutePath(value: unknown, field: string, projectRoot: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a path string`);
	return resolve(isAbsolute(value) ? value : join(projectRoot, value));
}

function validatedUrl(value: unknown, field: string, allowLoopbackHttp: boolean): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${field} must be an absolute URL`);
	}
	const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
	if (parsed.protocol !== "https:" && !(allowLoopbackHttp && loopback && parsed.protocol === "http:")) {
		throw new Error(
			`${field} must use HTTPS${allowLoopbackHttp ? " (loopback HTTP is allowed for local testing)" : ""}`,
		);
	}
	return parsed.toString().replace(/\/$/, "");
}

function environmentVariable(value: unknown, field: string): string {
	if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)) {
		throw new Error(`${field} must name an environment variable, not contain a secret value`);
	}
	return value;
}

export function validatePaperAgentConfig(value: unknown, projectRoot: string): PaperAgentConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Paper Agent config must be a JSON object");
	const source = value as Record<string, unknown>;
	const interfaceSource = (source.interface ?? {}) as Record<string, unknown>;
	const storageSource = (source.storage ?? {}) as Record<string, unknown>;
	const searchSource = (source.search ?? {}) as Record<string, unknown>;
	const port = Number(interfaceSource.port ?? 0);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("interface.port must be 0 or a valid TCP port");
	const namespace = String(storageSource.defaultNamespace ?? "default");
	if (!SAFE_SEGMENT.test(namespace))
		throw new Error("storage.defaultNamespace must be a safe 1-64 character identifier");
	const providerValues = searchSource.providers ?? defaultPaperAgentConfig().search.providers;
	if (
		!Array.isArray(providerValues) ||
		!providerValues.every((entry) => typeof entry === "string" && SAFE_SEGMENT.test(entry))
	) {
		throw new Error("search.providers must contain safe provider identifiers");
	}
	const maxResults = Number(searchSource.maxResultsPerProvider ?? 20);
	if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
		throw new Error("search.maxResultsPerProvider must be between 1 and 500");
	}
	const pagesPerProvider = Number(searchSource.pagesPerProvider ?? 1);
	if (!Number.isInteger(pagesPerProvider) || pagesPerProvider < 1 || pagesPerProvider > 20) {
		throw new Error("search.pagesPerProvider must be between 1 and 20");
	}
	const queryExpansionValues = searchSource.queryExpansions ?? [];
	if (
		!Array.isArray(queryExpansionValues) ||
		queryExpansionValues.length > 20 ||
		!queryExpansionValues.every(
			(entry) => typeof entry === "string" && entry.trim().length > 0 && entry.trim().length <= 500,
		)
	) {
		throw new Error("search.queryExpansions must contain at most 20 non-empty strings of 500 characters or fewer");
	}
	if (searchSource.reuseCorpus !== undefined && typeof searchSource.reuseCorpus !== "boolean") {
		throw new Error("search.reuseCorpus must be a boolean");
	}
	const config: PaperAgentConfig = {
		version: 1,
		interface: {
			port,
			openBrowser: interfaceSource.openBrowser !== false,
		},
		storage: {
			dataRoot: optionalAbsolutePath(storageSource.dataRoot, "storage.dataRoot", projectRoot),
			corpusRoot: optionalAbsolutePath(storageSource.corpusRoot, "storage.corpusRoot", projectRoot),
			defaultNamespace: namespace,
		},
		search: {
			providers: [...new Set(providerValues as string[])],
			maxResultsPerProvider: maxResults,
			pagesPerProvider,
			queryExpansions: [...new Set((queryExpansionValues as string[]).map((entry) => entry.trim()))],
			reuseCorpus: searchSource.reuseCorpus !== false,
		},
		updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
	};
	const parseModelConfig = (raw: unknown, field: string): PaperAgentModelConfig => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${field} must be an object`);
		const model = raw as Record<string, unknown>;
		const api = String(model.api ?? "openai-completions") as ModelApiKind;
		if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(api)) {
			throw new Error(`${field}.api is not supported`);
		}
		const providerId = String(model.providerId ?? "");
		const modelId = String(model.modelId ?? "");
		if (!SAFE_SEGMENT.test(providerId) || !modelId.trim() || modelId.length > 200) {
			throw new Error(`${field} providerId/modelId is invalid`);
		}
		return {
			providerId,
			modelId,
			api,
			baseUrl: validatedUrl(model.baseUrl, `${field}.baseUrl`, true),
			apiKeyEnvironmentVariable:
				typeof model.apiKeyEnvironmentVariable === "string" && model.apiKeyEnvironmentVariable.trim()
					? environmentVariable(model.apiKeyEnvironmentVariable, `${field}.apiKeyEnvironmentVariable`)
					: undefined,
			...(typeof model.apiKey === "string" && model.apiKey.trim()
				? (() => {
						const apiKey = model.apiKey.trim();
						if (apiKey.length > 16_384) {
							throw new Error(`${field}.apiKey must be at most 16384 characters`);
						}
						return { apiKey };
					})()
				: {}),
			toolCallingVerifiedAt:
				typeof model.toolCallingVerifiedAt === "string" ? model.toolCallingVerifiedAt : undefined,
			toolCallingProbe:
				model.toolCallingProbe && typeof model.toolCallingProbe === "object"
					? (model.toolCallingProbe as PaperAgentModelConfig["toolCallingProbe"])
					: undefined,
		};
	};
	if (source.network !== undefined) {
		if (!source.network || typeof source.network !== "object" || Array.isArray(source.network)) {
			throw new Error("network must be an object");
		}
		const network = source.network as Record<string, unknown>;
		// 兼容旧字段 network.proxy → network.proxyUrl
		const proxyUrlValue = network.proxyUrl ?? network.proxy;
		const proxyEnabled = network.proxyEnabled === undefined ? true : network.proxyEnabled;
		if (typeof proxyEnabled !== "boolean") {
			throw new Error("network.proxyEnabled must be a boolean");
		}
		if (proxyUrlValue !== undefined && proxyUrlValue !== "") {
			const raw = String(proxyUrlValue);
			let parsed: URL;
			try {
				parsed = new URL(raw);
			} catch {
				throw new Error("network.proxyUrl must be an absolute URL");
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error("network.proxyUrl must use http:// or https://");
			}
			if (!parsed.hostname || !parsed.port) {
				throw new Error("network.proxyUrl must include a host and port");
			}
			config.network = { proxyEnabled, proxyUrl: parsed.toString().replace(/\/$/, "") };
		}
	}
	if (source.model !== undefined) {
		config.model = parseModelConfig(source.model, "model");
	}
	if (source.models !== undefined) {
		if (!Array.isArray(source.models) || source.models.length > 32) {
			throw new Error("models must be an array of at most 32 model configurations");
		}
		config.models = source.models.map((entry, index) => parseModelConfig(entry, `models[${index}]`));
	}
	if (source.team !== undefined) {
		if (!source.team || typeof source.team !== "object" || Array.isArray(source.team))
			throw new Error("team must be an object");
		const team = source.team as Record<string, unknown>;
		const teamNamespace = String(team.namespace ?? namespace);
		if (!SAFE_SEGMENT.test(teamNamespace)) throw new Error("team.namespace is invalid");
		config.team = {
			serverUrl: validatedUrl(team.serverUrl, "team.serverUrl", true),
			namespace: teamNamespace,
			tokenEnvironmentVariable: environmentVariable(team.tokenEnvironmentVariable, "team.tokenEnvironmentVariable"),
		};
	}
	return config;
}

export async function loadPaperAgentConfig(projectRoot: string): Promise<PaperAgentConfig> {
	const path = resolvePaperAgentConfigPath(projectRoot);
	try {
		return withEnvironmentTeamConfig(
			validatePaperAgentConfig(JSON.parse(await readFile(path, "utf8")) as unknown, projectRoot),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return withEnvironmentTeamConfig(defaultPaperAgentConfig());
		}
		throw error;
	}
}

export async function savePaperAgentConfig(
	projectRoot: string,
	value: unknown,
): Promise<{ config: PaperAgentConfig; path: string }> {
	const config = validatePaperAgentConfig({ ...(value as object), updatedAt: new Date().toISOString() }, projectRoot);
	const path = resolvePaperAgentConfigPath(projectRoot);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
	return { config, path };
}

export async function discoverPiCustomModels(): Promise<PaperAgentModelConfig[]> {
	const path = join(homedir(), ".pi", "agent", "models.json");
	let parsed: PiModelsFile;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as PiModelsFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Pi models file is invalid: ${path}`);
	}
	const models: PaperAgentModelConfig[] = [];
	for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
		if (
			typeof provider.baseUrl !== "string" ||
			typeof provider.api !== "string" ||
			typeof provider.apiKey !== "string"
		)
			continue;
		const apiKeyEnvironmentVariable = provider.apiKey.replace(/^\$/, "");
		if (!ENVIRONMENT_NAME.test(apiKeyEnvironmentVariable)) continue;
		for (const model of provider.models ?? []) {
			if (typeof model.id !== "string") continue;
			try {
				models.push(
					validatePaperAgentConfig(
						{
							...defaultPaperAgentConfig(),
							model: {
								providerId,
								modelId: model.id,
								api: provider.api,
								baseUrl: provider.baseUrl,
								apiKeyEnvironmentVariable,
							},
						},
						process.cwd(),
					).model!,
				);
			} catch {
				// Ignore malformed Pi entries while preserving the valid choices.
			}
		}
	}
	return models;
}

function endpoint(baseUrl: string, suffix: string): string {
	return `${baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

export async function probeModelToolCalling(
	model: PaperAgentModelConfig,
	timeoutMs = 30_000,
): Promise<ModelProbeResult> {
	const checkedAt = new Date().toISOString();
	const started = Date.now();
	const apiKey = model.apiKey ?? (model.apiKeyEnvironmentVariable ? process.env[model.apiKeyEnvironmentVariable] : undefined);
	if (!apiKey) {
		return {
			supported: false,
			reason: `No API key configured for ${model.providerId}/${model.modelId}`,
			latencyMs: Date.now() - started,
			checkedAt,
		};
	}
	if (!supportsAutomaticToolCallingProbe(model.api)) {
		return {
			supported: false,
			reason: `Automatic probing is not implemented for ${model.api}; verify it from the Pi agent session`,
			latencyMs: Date.now() - started,
			checkedAt,
		};
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const tool = {
			type: "function",
			function: {
				name: "paper_agent_probe",
				description: "Return the exact boolean requested by the capability probe.",
				parameters: {
					type: "object",
					properties: { ok: { type: "boolean", const: true } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
		};
		const responsesTool = {
			type: "function",
			name: "paper_agent_probe",
			description: "Return the exact boolean requested by the capability probe.",
			parameters: {
				type: "object",
				properties: { ok: { type: "boolean", const: true } },
				required: ["ok"],
				additionalProperties: false,
			},
			strict: true,
		};
		const responsesApi = model.api === "openai-responses";
		const response = await fetch(endpoint(model.baseUrl, responsesApi ? "responses" : "chat/completions"), {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify(
				responsesApi
					? {
							model: model.modelId,
							input: "Call paper_agent_probe with ok=true. Do not answer in plain text.",
							tools: [responsesTool],
							tool_choice: { type: "function", name: "paper_agent_probe" },
							max_output_tokens: 64,
						}
					: {
							model: model.modelId,
							messages: [
								{ role: "user", content: "Call paper_agent_probe with ok=true. Do not answer in plain text." },
							],
							tools: [tool],
							tool_choice: { type: "function", function: { name: "paper_agent_probe" } },
							max_tokens: 64,
						},
			),
			signal: controller.signal,
		});
		const raw = await response.text();
		if (!response.ok) {
			return {
				supported: false,
				reason: `Provider returned HTTP ${response.status}: ${raw.slice(0, 300)}`,
				latencyMs: Date.now() - started,
				checkedAt,
				status: response.status,
			};
		}
		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			return {
				supported: false,
				reason: "Provider returned non-JSON output",
				latencyMs: Date.now() - started,
				checkedAt,
			};
		}
		const called = responsesApi
			? Array.isArray(body.output) &&
				body.output.some((entry: any) => entry?.type === "function_call" && entry?.name === "paper_agent_probe")
			: Array.isArray(body.choices) &&
				body.choices.some((choice: any) =>
					choice?.message?.tool_calls?.some((entry: any) => entry?.function?.name === "paper_agent_probe"),
				);
		return {
			supported: Boolean(called),
			reason: called
				? "The provider returned a structured function call"
				: "The provider responded but did not return the required function call",
			latencyMs: Date.now() - started,
			checkedAt,
			status: response.status,
		};
	} catch (error) {
		return {
			supported: false,
			reason:
				error instanceof Error && error.name === "AbortError"
					? "Capability probe timed out"
					: error instanceof Error
						? error.message
						: String(error),
			latencyMs: Date.now() - started,
			checkedAt,
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
