import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ModelApiKind,
	type ModelProbeResult,
	type PaperAgentModelConfig,
	supportsAutomaticToolCallingProbe,
} from "../domain/config-types.ts";
import { defaultPaperAgentConfig, validatePaperAgentConfig } from "./config-service.ts";

interface PiModelsFile {
	providers?: Record<
		string,
		{
			baseUrl?: unknown;
			api?: unknown;
			apiKey?: unknown;
			models?: Array<{
				id?: unknown;
				name?: unknown;
				reasoning?: unknown;
				input?: unknown;
				contextWindow?: unknown;
				maxTokens?: unknown;
			}>;
		}
	>;
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{1,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
								name: typeof model.name === "string" ? model.name : model.id,
								api: provider.api,
								baseUrl: provider.baseUrl,
								reasoning: model.reasoning === true,
								input: model.input,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
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

export interface ModelDiscoveryInput {
	providerId?: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetcher?: typeof fetch;
}

function configuredModelKey(model: Pick<PaperAgentModelConfig, "providerId" | "modelId">): string {
	return `${model.providerId}/${model.modelId}`;
}

function configuredModelsWithActive(
	models: PaperAgentModelConfig[],
	active?: PaperAgentModelConfig,
): PaperAgentModelConfig[] {
	const configured = [...models];
	if (!active) return configured;
	const index = configured.findIndex((model) => configuredModelKey(model) === configuredModelKey(active));
	if (index >= 0) configured[index] = active;
	else configured.unshift(active);
	return configured;
}

export function resolveConfiguredModel(models: PaperAgentModelConfig[], requested: string): PaperAgentModelConfig {
	const normalized = requested.trim();
	if (!normalized) throw new Error("Model identifier is required");
	const exact = models.filter((model) => configuredModelKey(model) === normalized);
	if (exact.length === 1) return exact[0];
	const byModelId = models.filter((model) => model.modelId === normalized);
	if (byModelId.length === 1) return byModelId[0];
	if (byModelId.length > 1) {
		throw new Error(`Model identifier is ambiguous; use provider/model: ${normalized}`);
	}
	throw new Error(`Configured model was not found: ${normalized}`);
}

export function removeConfiguredModel(
	models: PaperAgentModelConfig[],
	active: PaperAgentModelConfig | undefined,
	requested: string,
	replacement?: string,
): { removed: PaperAgentModelConfig; models: PaperAgentModelConfig[]; active?: PaperAgentModelConfig } {
	const configured = configuredModelsWithActive(models, active);
	const removed = resolveConfiguredModel(configured, requested);
	const removedKey = configuredModelKey(removed);
	const remaining = configured.filter((model) => configuredModelKey(model) !== removedKey);
	const nextActive = replacement
		? resolveConfiguredModel(remaining, replacement)
		: active && configuredModelKey(active) !== removedKey
			? resolveConfiguredModel(remaining, configuredModelKey(active))
			: undefined;
	return { removed, models: remaining, ...(nextActive ? { active: nextActive } : {}) };
}

export function removeConfiguredProvider(
	models: PaperAgentModelConfig[],
	active: PaperAgentModelConfig | undefined,
	providerId: string,
	replacement?: string,
): { removed: PaperAgentModelConfig[]; models: PaperAgentModelConfig[]; active?: PaperAgentModelConfig } {
	const normalized = providerId.trim();
	if (!normalized) throw new Error("Provider identifier is required");
	const configured = configuredModelsWithActive(models, active);
	const removed = configured.filter((model) => model.providerId === normalized);
	if (!removed.length) throw new Error(`Configured provider was not found: ${normalized}`);
	const remaining = configured.filter((model) => model.providerId !== normalized);
	const nextActive = replacement
		? resolveConfiguredModel(remaining, replacement)
		: active && active.providerId !== normalized
			? resolveConfiguredModel(remaining, configuredModelKey(active))
			: undefined;
	return { removed, models: remaining, ...(nextActive ? { active: nextActive } : {}) };
}

export function mergeDiscoveredModels(
	existing: PaperAgentModelConfig[],
	discovered: PaperAgentModelConfig[],
): PaperAgentModelConfig[] {
	const providerId = discovered[0]?.providerId;
	if (!providerId) return [...existing];
	const previousByIdentity = new Map(existing.map((model) => [`${model.providerId}\0${model.modelId}`, model]));
	const retained = existing.filter((model) => model.providerId !== providerId);
	const refreshed = discovered.map((model) => {
		const previous = previousByIdentity.get(`${model.providerId}\0${model.modelId}`);
		const sameTransport =
			previous &&
			previous.api === model.api &&
			previous.baseUrl.replace(/\/$/, "") === model.baseUrl.replace(/\/$/, "");
		return sameTransport
			? {
					...model,
					name: previous.name ?? model.name,
					reasoning: previous.reasoning,
					input: previous.input,
					contextWindow: previous.contextWindow,
					maxTokens: previous.maxTokens,
					...(previous.compat ? { compat: previous.compat } : {}),
					...(previous.thinkingLevelMap ? { thinkingLevelMap: previous.thinkingLevelMap } : {}),
					...(previous.imageInputProbe ? { imageInputProbe: previous.imageInputProbe } : {}),
				}
			: model;
	});
	return [...retained, ...refreshed];
}

function inferProviderId(baseUrl: string): string {
	try {
		const hostname = new URL(baseUrl).hostname;
		const parts = hostname.split(".").filter(Boolean);
		const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
		return candidate.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "model-provider";
	} catch {
		return "model-provider";
	}
}

function modelIdsFromPayload(value: unknown): string[] {
	if (!isRecord(value)) throw new Error("Model endpoint returned a non-object payload");
	const source = Array.isArray(value.data)
		? value.data
		: Array.isArray(value.models)
			? value.models
			: Array.isArray(value.items)
				? value.items
				: undefined;
	if (!source) throw new Error("Model endpoint did not contain a data/models/items array");
	return [
		...new Set(
			source
				.map((entry) => (isRecord(entry) ? entry.id : undefined))
				.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
				.map((id) => id.trim()),
		),
	].sort((left, right) => left.localeCompare(right));
}

export async function discoverModelEndpointModels(input: ModelDiscoveryInput): Promise<PaperAgentModelConfig[]> {
	if (!["openai-completions", "openai-responses"].includes(input.api)) {
		throw new Error("Automatic model discovery currently requires an OpenAI-compatible /models endpoint");
	}
	if (typeof input.apiKey !== "string" || !input.apiKey.trim()) {
		throw new Error("API key 不能为空。请在 API key 提示处粘贴完整密钥后按 Enter。");
	}
	const config = validatePaperAgentConfig(
		{
			...defaultPaperAgentConfig(),
			model: {
				providerId: input.providerId?.trim() || inferProviderId(input.baseUrl),
				modelId: "model-discovery-placeholder",
				api: input.api,
				baseUrl: input.baseUrl,
				apiKey: input.apiKey,
				headers: input.headers,
			},
		},
		process.cwd(),
	);
	const model = config.model!;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
	try {
		const response = await (input.fetcher ?? fetch)(endpoint(model.baseUrl, "models"), {
			method: "GET",
			headers: {
				...model.headers,
				authorization: `Bearer ${model.apiKey}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(`Model endpoint returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			throw new Error("Model endpoint returned non-JSON output");
		}
		const ids = modelIdsFromPayload(payload);
		if (!ids.length) throw new Error("Model endpoint returned no usable model ids");
		return ids.map((modelId) => ({
			providerId: model.providerId,
			modelId,
			name: modelId,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128_000,
			maxTokens: 16_384,
			apiKey: model.apiKey,
			...(model.headers ? { headers: model.headers } : {}),
		}));
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("Model discovery timed out");
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export async function probeModelToolCalling(
	model: PaperAgentModelConfig,
	timeoutMs = 30_000,
): Promise<ModelProbeResult> {
	const checkedAt = new Date().toISOString();
	const started = Date.now();
	const apiKey =
		model.apiKey ?? (model.apiKeyEnvironmentVariable ? process.env[model.apiKeyEnvironmentVariable] : undefined);
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
			headers: {
				...model.headers,
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
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
		const call = responsesApi
			? body.output?.find((entry: any) => entry?.type === "function_call" && entry?.name === "paper_agent_probe")
			: body.choices?.[0]?.message?.tool_calls?.find((entry: any) => entry?.function?.name === "paper_agent_probe");
		if (!call) {
			return {
				supported: false,
				reason: "The provider responded but did not return the required function call",
				latencyMs: Date.now() - started,
				checkedAt,
				status: response.status,
			};
		}
		const continuationBody = responsesApi
			? {
					model: model.modelId,
					previous_response_id: body.id,
					input: [
						{
							type: "function_call_output",
							call_id: call.call_id ?? call.id,
							output: '{"ok":true}',
						},
					],
					tools: [responsesTool],
					max_output_tokens: 64,
				}
			: {
					model: model.modelId,
					messages: [
						{ role: "user", content: "Call paper_agent_probe with ok=true. Do not answer in plain text." },
						body.choices[0].message,
						{ role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
					],
					tools: [tool],
					max_tokens: 64,
				};
		const continuation = await fetch(endpoint(model.baseUrl, responsesApi ? "responses" : "chat/completions"), {
			method: "POST",
			headers: {
				...model.headers,
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(continuationBody),
			signal: controller.signal,
		});
		const continuationRaw = await continuation.text();
		if (!continuation.ok) {
			return {
				supported: false,
				reason: `Tool-result continuation returned HTTP ${continuation.status}: ${continuationRaw.slice(0, 300)}`,
				latencyMs: Date.now() - started,
				checkedAt,
				status: continuation.status,
			};
		}
		return {
			supported: true,
			reason: "The provider returned a structured function call and accepted its tool result",
			latencyMs: Date.now() - started,
			checkedAt,
			status: continuation.status,
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

export { probeModelImageInput } from "./model-image-probe.ts";
