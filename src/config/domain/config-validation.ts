import { isAbsolute, join, resolve } from "node:path";
import { defaultOperationConfirmationSettings } from "../../shared/domain/operation-confirmation.ts";

import type {
	ModelApiKind,
	PaperAgentConfig,
	PaperAgentModelConfig,
	PiBuiltinToolName,
	RedactedPaperAgentConfig,
	RedactedPaperAgentModelConfig,
} from "./config-types.ts";

export type {
	ModelApiKind,
	ModelProbeResult,
	PaperAgentConfig,
	PaperAgentConfigPaths,
	PaperAgentModelConfig,
	PiBuiltinToolName,
	RedactedPaperAgentConfig,
	RedactedPaperAgentModelConfig,
} from "./config-types.ts";
export { relayHeadersForModelApi, supportsAutomaticToolCallingProbe } from "./config-types.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{1,127}$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_MODEL_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"x-api-key",
]);
const PI_BUILTIN_TOOLS = new Set<PiBuiltinToolName>(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export function defaultPaperAgentConfig(): PaperAgentConfig {
	return {
		version: 1,
		interface: { port: 43127, openBrowser: true },
		readerTranslation: { defaultProvider: "google" },
		storage: { defaultNamespace: "default" },
		externalTools: { commandDirectories: [] },
		agent: { builtinTools: [] },
		confirmations: defaultOperationConfirmationSettings(),
		pdfTranslation: { engine: "siliconflowfree" },
		mineru: {
			baseUrl: "https://mineru.net/api/v4",
			modelVersion: "vlm",
			language: "en",
		},
		wiki: {},
		search: {
			providers: ["arxiv", "openalex", "crossref", "semanticscholar", "dblp", "core", "exa"],
			doiEnrichmentProviders: ["crossref", "openalex", "semanticscholar", "opencitations", "unpaywall"],
			maxResultsPerProvider: 20,
			pagesPerProvider: 1,
			queryExpansions: [],
			reuseCorpus: true,
		},
		updatedAt: new Date().toISOString(),
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
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

function validatedModelHeaders(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const entries = Object.entries(value);
	if (entries.length > 32) throw new Error(`${field} must contain at most 32 headers`);
	const result: Record<string, string> = {};
	const names = new Set<string>();
	for (const [name, rawValue] of entries) {
		const normalizedName = name.toLowerCase();
		if (!HTTP_HEADER_NAME.test(name) || name.length > 128)
			throw new Error(`${field} contains an invalid header name`);
		if (names.has(normalizedName)) throw new Error(`${field} contains duplicate header names`);
		if (FORBIDDEN_MODEL_HEADERS.has(normalizedName)) throw new Error(`${field}.${name} is not allowed`);
		if (typeof rawValue !== "string" || !rawValue || rawValue.length > 4_096 || /[\r\n]/.test(rawValue)) {
			throw new Error(`${field}.${name} must be a non-empty single-line string of at most 4096 characters`);
		}
		names.add(normalizedName);
		result[name] = rawValue;
	}
	return entries.length ? result : undefined;
}

function redactModel(model: PaperAgentModelConfig): RedactedPaperAgentModelConfig {
	const { apiKey, ...rest } = model;
	return apiKey ? { ...rest, apiKey: "[redacted]" } : rest;
}

export function redactPaperAgentConfig(config: PaperAgentConfig): RedactedPaperAgentConfig {
	const credentials = config.credentials
		? Object.fromEntries(
				Object.entries(config.credentials).map(([key, value]) => [
					key,
					value && /key|token|secret/i.test(key) ? "[redacted]" : value,
				]),
			)
		: undefined;
	return {
		...config,
		model: config.model ? redactModel(config.model) : undefined,
		models: config.models?.map(redactModel),
		credentials,
	};
}

function optionalAbsolutePath(value: unknown, field: string, projectRoot: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a path string`);
	return resolve(isAbsolute(value) ? value : join(projectRoot, value));
}

export function validatePaperAgentConfig(value: unknown, projectRoot: string): PaperAgentConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Paper Agent config must be a JSON object");
	const source = value as Record<string, unknown>;
	const interfaceSource = (source.interface ?? {}) as Record<string, unknown>;
	const storageSource = (source.storage ?? {}) as Record<string, unknown>;
	const externalToolsSource = (source.externalTools ?? {}) as Record<string, unknown>;
	const agentSource = (source.agent ?? {}) as Record<string, unknown>;
	if (source.confirmations !== undefined && !isRecord(source.confirmations)) {
		throw new Error("confirmations must be an object");
	}
	const confirmationSource = isRecord(source.confirmations) ? source.confirmations : {};
	const confirmationDefaults = defaultOperationConfirmationSettings();
	const confirmationValue = (field: keyof typeof confirmationDefaults): boolean => {
		const value = confirmationSource[field];
		if (value !== undefined && typeof value !== "boolean") {
			throw new Error(`confirmations.${field} must be a boolean`);
		}
		return value === undefined ? confirmationDefaults[field] : value;
	};
	const searchSource = (source.search ?? {}) as Record<string, unknown>;
	if (source.readerTranslation !== undefined && !isRecord(source.readerTranslation)) {
		throw new Error("readerTranslation must be an object");
	}
	const readerTranslationSource = isRecord(source.readerTranslation) ? source.readerTranslation : {};
	const defaultTranslationProvider = readerTranslationSource.defaultProvider ?? "google";
	if (!["google", "deepl", "youdao", "baidu"].includes(String(defaultTranslationProvider))) {
		throw new Error("readerTranslation.defaultProvider must be google, deepl, youdao, or baidu");
	}
	const pdfTranslationSource = (source.pdfTranslation ?? {}) as Record<string, unknown>;
	const pdfTranslationEngine = pdfTranslationSource.engine ?? "siliconflowfree";
	if (pdfTranslationEngine !== "siliconflowfree" && pdfTranslationEngine !== "active-model") {
		throw new Error("pdfTranslation.engine must be siliconflowfree or active-model");
	}
	const pdfTranslationModelKey =
		typeof pdfTranslationSource.modelKey === "string" && pdfTranslationSource.modelKey.trim()
			? pdfTranslationSource.modelKey.trim()
			: undefined;
	if (pdfTranslationModelKey && (pdfTranslationModelKey.length > 300 || /[\r\n\0]/.test(pdfTranslationModelKey))) {
		throw new Error("pdfTranslation.modelKey must be a valid provider/model identifier");
	}
	const pdfTranslationCommand =
		typeof pdfTranslationSource.command === "string" && pdfTranslationSource.command.trim()
			? pdfTranslationSource.command.trim()
			: undefined;
	if (pdfTranslationCommand && (pdfTranslationCommand.length > 4_096 || /[\r\n\0]/.test(pdfTranslationCommand))) {
		throw new Error("pdfTranslation.command must be a single executable name or path");
	}
	const mineruSource = (source.mineru ?? {}) as Record<string, unknown>;
	if (source.wiki !== undefined && !isRecord(source.wiki)) throw new Error("wiki must be an object");
	const wikiSource = isRecord(source.wiki) ? source.wiki : {};
	const mineruBaseUrl = validatedUrl(mineruSource.baseUrl ?? "https://mineru.net/api/v4", "mineru.baseUrl", true);
	const mineruModelVersion = mineruSource.modelVersion ?? "vlm";
	if (mineruModelVersion !== "pipeline" && mineruModelVersion !== "vlm") {
		throw new Error("mineru.modelVersion must be pipeline or vlm");
	}
	const mineruLanguage = String(mineruSource.language ?? "en").trim();
	if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(mineruLanguage)) {
		throw new Error("mineru.language must be a short language identifier");
	}
	const port = Number(interfaceSource.port ?? 0);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("interface.port must be 0 or a valid TCP port");
	const namespace = String(storageSource.defaultNamespace ?? "default");
	if (!SAFE_SEGMENT.test(namespace))
		throw new Error("storage.defaultNamespace must be a safe 1-64 character identifier");
	const commandDirectoryValues = externalToolsSource.commandDirectories ?? [];
	if (!Array.isArray(commandDirectoryValues) || commandDirectoryValues.length > 32) {
		throw new Error("externalTools.commandDirectories must be an array of at most 32 paths");
	}
	const commandDirectories = commandDirectoryValues.map((value, index) => {
		const path = optionalAbsolutePath(value, `externalTools.commandDirectories[${index}]`, projectRoot);
		if (!path) throw new Error(`externalTools.commandDirectories[${index}] must be a non-empty path`);
		return path;
	});
	const builtinToolValues = agentSource.builtinTools ?? [];
	if (
		!Array.isArray(builtinToolValues) ||
		!builtinToolValues.every(
			(entry): entry is PiBuiltinToolName =>
				typeof entry === "string" && PI_BUILTIN_TOOLS.has(entry as PiBuiltinToolName),
		)
	) {
		throw new Error("agent.builtinTools may contain only read, bash, edit, write, grep, find, and ls");
	}
	const providerValues = searchSource.providers ?? defaultPaperAgentConfig().search.providers;
	if (
		!Array.isArray(providerValues) ||
		!providerValues.every((entry) => typeof entry === "string" && SAFE_SEGMENT.test(entry))
	) {
		throw new Error("search.providers must contain safe provider identifiers");
	}
	const doiEnrichmentProviderValues =
		searchSource.doiEnrichmentProviders ?? defaultPaperAgentConfig().search.doiEnrichmentProviders;
	if (
		!Array.isArray(doiEnrichmentProviderValues) ||
		!doiEnrichmentProviderValues.every((entry) => typeof entry === "string" && SAFE_SEGMENT.test(entry))
	) {
		throw new Error("search.doiEnrichmentProviders must contain safe provider identifiers");
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
		readerTranslation: { defaultProvider: defaultTranslationProvider as "google" | "deepl" | "youdao" | "baidu" },
		storage: {
			dataRoot: optionalAbsolutePath(storageSource.dataRoot, "storage.dataRoot", projectRoot),
			corpusRoot: optionalAbsolutePath(storageSource.corpusRoot, "storage.corpusRoot", projectRoot),
			defaultNamespace: namespace,
		},
		externalTools: { commandDirectories: [...new Set(commandDirectories)] },
		agent: {
			builtinTools: [...new Set(builtinToolValues)],
			shellPath: optionalAbsolutePath(agentSource.shellPath, "agent.shellPath", projectRoot),
		},
		confirmations: {
			requireAgentWriteConfirmation: confirmationValue("requireAgentWriteConfirmation"),
			requirePersonalLibraryWriteConfirmation: confirmationValue("requirePersonalLibraryWriteConfirmation"),
			requirePersonalLibraryDeleteConfirmation: confirmationValue("requirePersonalLibraryDeleteConfirmation"),
			requireResearchConfirmation: confirmationValue("requireResearchConfirmation"),
			requirePdfArtifactConfirmation: confirmationValue("requirePdfArtifactConfirmation"),
			requireWikiWriteConfirmation: confirmationValue("requireWikiWriteConfirmation"),
		},
		pdfTranslation: {
			engine: pdfTranslationEngine,
			...(pdfTranslationModelKey ? { modelKey: pdfTranslationModelKey } : {}),
			...(pdfTranslationCommand ? { command: pdfTranslationCommand } : {}),
		},
		mineru: {
			baseUrl: mineruBaseUrl,
			modelVersion: mineruModelVersion,
			language: mineruLanguage,
		},
		wiki: {
			obsidianPath: optionalAbsolutePath(wikiSource.obsidianPath, "wiki.obsidianPath", projectRoot),
		},
		search: {
			providers: [...new Set(providerValues as string[])],
			doiEnrichmentProviders: [...new Set(doiEnrichmentProviderValues as string[])],
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
		const headers = validatedModelHeaders(model.headers, `${field}.headers`);
		const rawInput = model.input === undefined ? ["text"] : model.input;
		if (
			!Array.isArray(rawInput) ||
			rawInput.length === 0 ||
			rawInput.some((entry) => entry !== "text" && entry !== "image") ||
			!rawInput.includes("text")
		) {
			throw new Error(`${field}.input must contain text and may contain image`);
		}
		const positiveInteger = (value: unknown, fallback: number, name: string): number => {
			if (value === undefined) return fallback;
			if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`);
			return Number(value);
		};
		return {
			providerId,
			modelId,
			name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : undefined,
			api,
			baseUrl: validatedUrl(model.baseUrl, `${field}.baseUrl`, true),
			reasoning: model.reasoning === true,
			input: [...new Set(rawInput)] as PaperAgentModelConfig["input"],
			contextWindow: positiveInteger(model.contextWindow, 128_000, `${field}.contextWindow`),
			maxTokens: positiveInteger(model.maxTokens, 16_384, `${field}.maxTokens`),
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
			...(headers ? { headers } : {}),
			...(model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
				? { compat: model.compat as Record<string, unknown> }
				: {}),
			...(model.thinkingLevelMap &&
			typeof model.thinkingLevelMap === "object" &&
			!Array.isArray(model.thinkingLevelMap)
				? { thinkingLevelMap: model.thinkingLevelMap as Record<string, string | null> }
				: {}),
			toolCallingVerifiedAt:
				typeof model.toolCallingVerifiedAt === "string" ? model.toolCallingVerifiedAt : undefined,
			toolCallingProbe:
				model.toolCallingProbe && typeof model.toolCallingProbe === "object"
					? (model.toolCallingProbe as PaperAgentModelConfig["toolCallingProbe"])
					: undefined,
			imageInputProbe:
				model.imageInputProbe && typeof model.imageInputProbe === "object"
					? (model.imageInputProbe as PaperAgentModelConfig["imageInputProbe"])
					: undefined,
		};
	};
	if (source.network !== undefined) {
		if (!source.network || typeof source.network !== "object" || Array.isArray(source.network)) {
			throw new Error("network must be an object");
		}
		const network = source.network as Record<string, unknown>;
		const proxyUrlValue = network.proxyUrl;
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
			const noProxyHosts = Array.isArray(network.noProxyHosts)
				? network.noProxyHosts.filter((host): host is string => typeof host === "string" && Boolean(host.trim()))
				: [];
			config.network = {
				proxyEnabled,
				proxyUrl: parsed.toString().replace(/\/$/, ""),
				...(noProxyHosts.length ? { noProxyHosts } : {}),
			};
		}
	}
	if (source.credentials !== undefined) {
		if (!source.credentials || typeof source.credentials !== "object" || Array.isArray(source.credentials)) {
			throw new Error("credentials must be an object");
		}
		const credentials = source.credentials as Record<string, unknown>;
		const boundedSecret = (field: string, cap = 16_384): string | undefined => {
			const value = credentials[field];
			if (value === undefined || value === null || value === "") return undefined;
			if (typeof value !== "string") throw new Error(`credentials.${field} must be a string`);
			const trimmed = value.trim();
			if (!trimmed || trimmed.length > cap) {
				throw new Error(`credentials.${field} must be 1-${cap} characters`);
			}
			return trimmed;
		};
		config.credentials = {
			...(boundedSecret("semanticScholarApiKey")
				? { semanticScholarApiKey: boundedSecret("semanticScholarApiKey") }
				: {}),
			...(boundedSecret("coreApiKey") ? { coreApiKey: boundedSecret("coreApiKey") } : {}),
			...(boundedSecret("exaApiKey") ? { exaApiKey: boundedSecret("exaApiKey") } : {}),
			...(boundedSecret("githubToken", 4_096) ? { githubToken: boundedSecret("githubToken", 4_096) } : {}),
			...(boundedSecret("unpaywallEmail") ? { unpaywallEmail: boundedSecret("unpaywallEmail") } : {}),
			...(boundedSecret("openAlexMailto") ? { openAlexMailto: boundedSecret("openAlexMailto") } : {}),
			...(boundedSecret("crossrefPoliteEmail") ? { crossrefPoliteEmail: boundedSecret("crossrefPoliteEmail") } : {}),
			...(boundedSecret("zoteroLocalApiKey", 4_096)
				? { zoteroLocalApiKey: boundedSecret("zoteroLocalApiKey", 4_096) }
				: {}),
			...(boundedSecret("zoteroServerId", 512) ? { zoteroServerId: boundedSecret("zoteroServerId", 512) } : {}),
			...(boundedSecret("mineruApiKey", 4_096) ? { mineruApiKey: boundedSecret("mineruApiKey", 4_096) } : {}),
			...(boundedSecret("googleTranslateApiKey", 4_096)
				? { googleTranslateApiKey: boundedSecret("googleTranslateApiKey", 4_096) }
				: {}),
			...(boundedSecret("deeplApiKey", 4_096) ? { deeplApiKey: boundedSecret("deeplApiKey", 4_096) } : {}),
			...(boundedSecret("youdaoAppId", 512) ? { youdaoAppId: boundedSecret("youdaoAppId", 512) } : {}),
			...(boundedSecret("youdaoAppSecret", 4_096)
				? { youdaoAppSecret: boundedSecret("youdaoAppSecret", 4_096) }
				: {}),
			...(boundedSecret("baiduTranslateAppId", 512)
				? { baiduTranslateAppId: boundedSecret("baiduTranslateAppId", 512) }
				: {}),
			...(boundedSecret("baiduTranslateAppSecret", 4_096)
				? { baiduTranslateAppSecret: boundedSecret("baiduTranslateAppSecret", 4_096) }
				: {}),
		};
	}
	if (source.model !== undefined) {
		config.model = parseModelConfig(source.model, "model");
	}
	if (source.models !== undefined) {
		if (!Array.isArray(source.models) || source.models.length > 512) {
			throw new Error("models must be an array of at most 512 model configurations");
		}
		config.models = source.models.map((entry, index) => parseModelConfig(entry, `models[${index}]`));
		const identities = new Set<string>();
		for (const model of config.models) {
			const identity = `${model.providerId}\0${model.modelId}`;
			if (identities.has(identity)) {
				throw new Error(`models contains duplicate provider/model identity: ${model.providerId}/${model.modelId}`);
			}
			identities.add(identity);
		}
	}
	if (config.pdfTranslation.engine === "active-model") {
		const fallbackKey = config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined;
		const selectedKey = config.pdfTranslation.modelKey ?? fallbackKey;
		const configuredModels = [config.model, ...(config.models ?? [])].filter(
			(model): model is PaperAgentModelConfig => Boolean(model),
		);
		const selectedModel = selectedKey
			? configuredModels.find((model) => `${model.providerId}/${model.modelId}` === selectedKey)
			: undefined;
		if (config.pdfTranslation.modelKey && !selectedModel) {
			throw new Error(
				`pdfTranslation.modelKey was not found in configured models: ${config.pdfTranslation.modelKey}`,
			);
		}
		if (config.pdfTranslation.modelKey && selectedModel?.api !== "openai-completions") {
			throw new Error("pdfTranslation.modelKey must select an openai-completions model");
		}
		if (selectedKey && selectedModel?.api === "openai-completions") config.pdfTranslation.modelKey = selectedKey;
	}
	return config;
}
