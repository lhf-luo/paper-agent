import { describe, expect, it } from "vitest";
import {
	addProvider,
	configuredModels,
	modelKey,
	providerGroups,
	removeModel,
	removeProvider,
	setActiveModel,
	suggestProviderId,
	supportsModelDiscovery,
	validateProviderInput,
} from "../web/src/model-providers.ts";
import type { ModelConfigView, PaperAgentConfigView } from "../web/src/types.ts";

function config(models: ModelConfigView[], activeKey?: string): PaperAgentConfigView {
	return {
		version: 1,
		path: "/tmp/.paper-agent/config",
		interface: { port: 0, openBrowser: false },
		readerTranslation: { defaultProvider: "google" },
		storage: { defaultNamespace: "default" },
		externalTools: { commandDirectories: [] },
		confirmations: {
			requireAgentWriteConfirmation: false,
			requirePersonalLibraryWriteConfirmation: false,
			requirePersonalLibraryDeleteConfirmation: true,
			requireResearchConfirmation: true,
			requirePdfArtifactConfirmation: true,
			requireWikiWriteConfirmation: true,
		},
		pdfTranslation: { engine: "siliconflowfree" },
		mineru: { baseUrl: "https://mineru.example.com", modelVersion: "pipeline", language: "ch" },
		wiki: {},
		search: {
			providers: [],
			doiEnrichmentProviders: [],
			maxResultsPerProvider: 20,
			pagesPerProvider: 1,
			queryExpansions: [],
			reuseCorpus: true,
		},
		models,
		model: models.find((model) => modelKey(model) === activeKey),
		updatedAt: "2026-09-17T00:00:00.000Z",
	};
}

const relayModel: ModelConfigView = {
	providerId: "research-relay",
	modelId: "big-context",
	name: "Big Context",
	api: "openai-completions",
	baseUrl: "https://relay.example.com/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_000_000,
	maxTokens: 65_536,
	apiKey: "[redacted]",
	credentialsAvailable: true,
};

describe("model provider settings helpers", () => {
	it("groups configured models by provider without duplicating the active model", () => {
		const groups = providerGroups(
			config([relayModel, { ...relayModel, modelId: "small" }], "research-relay/big-context"),
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].models.map((model) => model.modelId)).toEqual(["big-context", "small"]);
		expect(groups[0].credentialsAvailable).toBe(true);
	});

	it("keeps every capability field so saving settings cannot reset them", () => {
		const source = config([relayModel], "research-relay/big-context");
		const next = setActiveModel(source, "research-relay/big-context");
		// 视图原样回传保存时，`credentialsAvailable` 是服务端派生的只读字段，不应回写。
		expect(next.model).toEqual({
			providerId: "research-relay",
			modelId: "big-context",
			name: "Big Context",
			api: "openai-completions",
			baseUrl: "https://relay.example.com/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			apiKey: "[redacted]",
		});
	});

	it("adds a provider, inheriting capability metadata for unchanged models", () => {
		const source = config([relayModel], "research-relay/big-context");
		const next = addProvider(source, {
			providerId: "research-relay",
			baseUrl: "https://relay.example.com/v1",
			api: "openai-completions",
			modelIds: ["big-context", "brand-new"],
		});
		const models = configuredModels(next);
		expect(models.map(modelKey)).toEqual(["research-relay/big-context", "research-relay/brand-new"]);
		// 接口未变的既有模型保留原来的上下文窗口与图像能力。
		expect(models[0].contextWindow).toBe(1_000_000);
		expect(models[0].input).toEqual(["text", "image"]);
		expect(models[0].apiKey).toBe("[redacted]");
		// 新模型使用 CLI 的默认声明，并沿用同一供应商的凭据。
		expect(models[1].contextWindow).toBe(128_000);
		expect(models[1].reasoning).toBe(true);
		expect(models[1].apiKey).toBe("[redacted]");
	});

	it("replaces the previous models when the same provider is reconfigured on another endpoint", () => {
		const source = config([relayModel, { ...relayModel, modelId: "old-model" }], "research-relay/big-context");
		const next = addProvider(source, {
			providerId: "research-relay",
			baseUrl: "https://relay.example.com/v2",
			api: "openai-responses",
			modelIds: ["new-model"],
		});
		expect(configuredModels(next).map(modelKey)).toEqual(["research-relay/new-model"]);
		expect(configuredModels(next)[0].contextWindow).toBe(128_000);
	});

	it("drops the active model when its declaration is removed", () => {
		const source = config([relayModel], "research-relay/big-context");
		expect(removeModel(source, "research-relay/big-context").model).toBeUndefined();
		expect(removeProvider(source, "research-relay").model).toBeUndefined();
		expect(configuredModels(removeProvider(source, "research-relay"))).toEqual([]);
	});

	it("keeps an unrelated active model when another provider is removed", () => {
		const other: ModelConfigView = { ...relayModel, providerId: "local", modelId: "llama" };
		const source = config([relayModel, other], "local/llama");
		const next = removeProvider(source, "research-relay");
		expect(next.model && modelKey(next.model)).toBe("local/llama");
	});

	it("rejects an invalid provider id or a non-HTTPS endpoint before submitting", () => {
		expect(validateProviderInput({ providerId: "bad id", baseUrl: "https://relay.example.com/v1" })).toMatch(
			/供应商 ID/,
		);
		expect(validateProviderInput({ providerId: "relay", baseUrl: "http://relay.example.com/v1" })).toMatch(/HTTPS/);
		expect(validateProviderInput({ providerId: "relay", baseUrl: "http://127.0.0.1:8080/v1" })).toBeUndefined();
		expect(validateProviderInput({ providerId: "relay", baseUrl: "not-a-url" })).toMatch(/绝对地址/);
	});

	it("infers a provider id from the endpoint host and limits discovery to OpenAI-compatible APIs", () => {
		expect(suggestProviderId("https://api.deepseek.com/v1")).toBe("deepseek");
		expect(suggestProviderId("https://relay.example.com/v1")).toBe("example");
		expect(suggestProviderId("nonsense")).toBe("model-provider");
		expect(supportsModelDiscovery("openai-completions")).toBe(true);
		expect(supportsModelDiscovery("openai-responses")).toBe(true);
		expect(supportsModelDiscovery("anthropic-messages")).toBe(false);
	});
});
