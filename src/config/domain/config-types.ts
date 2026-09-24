import type { OperationConfirmationSettings } from "../../shared/domain/operation-confirmation.ts";

export type ModelApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ModelInputModality = "text" | "image";
export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export type PdfTranslationEngine = "siliconflowfree" | "active-model";
export type MineruModelVersion = "pipeline" | "vlm";

export function supportsAutomaticToolCallingProbe(api: ModelApiKind): boolean {
	return api === "openai-completions" || api === "openai-responses";
}

export function relayHeadersForModelApi(api: ModelApiKind): Record<string, string> | undefined {
	if (api === "openai-completions") {
		return {
			"user-agent": "claude-cli/2.1.198 (external, sdk-cli)",
			"x-app": "cli",
			"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
		};
	}
	if (api === "openai-responses") {
		return {
			"user-agent": "codex_cli_rs/0.144.1 (Mac OS 15.7.7; arm64) ghostty/1.3.1",
		};
	}
	return undefined;
}

export interface PaperAgentModelConfig {
	providerId: string;
	modelId: string;
	name?: string;
	api: ModelApiKind;
	baseUrl: string;
	reasoning: boolean;
	input: ModelInputModality[];
	contextWindow: number;
	maxTokens: number;
	apiKeyEnvironmentVariable?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
	toolCallingVerifiedAt?: string;
	toolCallingProbe?: {
		supported: boolean;
		reason: string;
		latencyMs: number;
		checkedAt: string;
	};
	imageInputProbe?: {
		supported: boolean;
		reason: string;
		latencyMs: number;
		checkedAt: string;
		status?: number;
	};
}

export interface PaperAgentConfig {
	version: 1;
	interface: {
		port: number;
		openBrowser: boolean;
		pdfReader: "pdfjs" | "native";
	};
	storage: {
		dataRoot?: string;
		corpusRoot?: string;
		defaultNamespace: string;
	};
	externalTools: {
		commandDirectories: string[];
	};
	agent: {
		builtinTools: PiBuiltinToolName[];
		shellPath?: string;
	};
	confirmations: OperationConfirmationSettings;
	pdfTranslation: {
		engine: PdfTranslationEngine;
		modelKey?: string;
		command?: string;
	};
	mineru: {
		baseUrl: string;
		modelVersion: MineruModelVersion;
		language: string;
	};
	wiki: {
		obsidianPath?: string;
	};
	search: {
		providers: string[];
		doiEnrichmentProviders: string[];
		maxResultsPerProvider: number;
		pagesPerProvider: number;
		queryExpansions: string[];
		reuseCorpus: boolean;
	};
	network?: {
		proxyEnabled?: boolean;
		proxyUrl?: string;
		/** 代理直连白名单: 这些域名即使启用代理也直接连接。 */
		noProxyHosts?: string[];
	};
	credentials?: {
		semanticScholarApiKey?: string;
		coreApiKey?: string;
		exaApiKey?: string;
		githubToken?: string;
		unpaywallEmail?: string;
		openAlexMailto?: string;
		crossrefPoliteEmail?: string;
		zoteroLocalApiKey?: string;
		zoteroServerId?: string;
		mineruApiKey?: string;
	};
	model?: PaperAgentModelConfig;
	models?: PaperAgentModelConfig[];
	updatedAt: string;
}

export interface PaperAgentConfigPaths {
	directory: string;
	appFile: string;
	searchFile: string;
	modelsFile: string;
	modelAuthFile: string;
	networkFile: string;
	credentialsFile: string;
}

export type RedactedPaperAgentModelConfig = Omit<PaperAgentModelConfig, "apiKey"> & { apiKey?: string };

export type RedactedPaperAgentConfig = Omit<PaperAgentConfig, "model" | "models" | "credentials"> & {
	model?: RedactedPaperAgentModelConfig;
	models?: RedactedPaperAgentModelConfig[];
	credentials?: Record<string, string>;
};

export interface ModelProbeResult {
	supported: boolean;
	reason: string;
	latencyMs: number;
	checkedAt: string;
	status?: number;
}
