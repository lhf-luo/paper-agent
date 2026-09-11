import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import type { PaperAgentModelConfig } from "../../config/domain/config-types.ts";
import type { WebAgentServiceApi } from "../domain/web-agent-contracts.ts";
import { WebAgentActions } from "./web-agent-actions.ts";
import type { WebAgentEndpointConfig, WebAgentServiceOptions } from "./web-agent-support.ts";

export type * from "../domain/web-agent-contracts.ts";
export { WebAgentServiceError } from "../domain/web-agent-contracts.ts";
export type { WebAgentServiceOptions } from "./web-agent-support.ts";

export class WebAgentService extends WebAgentActions implements WebAgentServiceApi {
	protected constructor(
		options: WebAgentServiceOptions,
		endpoint: WebAgentEndpointConfig,
		configuredModels: PaperAgentModelConfig[],
	) {
		super(options, endpoint, configuredModels);
	}

	static async create(options: WebAgentServiceOptions): Promise<WebAgentService> {
		const config = await loadPaperAgentConfig(options.projectRoot);
		const configuredModels = config.models ?? (config.model ? [config.model] : []);
		const service = new WebAgentService(
			{ ...options, builtinTools: config.agent.builtinTools, shellPath: config.agent.shellPath },
			{
				providerId: config.model?.providerId ?? "",
				modelId: config.model?.modelId ?? "",
				baseUrl: config.model?.baseUrl ?? "",
				api: config.model?.api ?? "openai-completions",
				input: config.model?.input ?? ["text"],
				reasoning: config.model?.reasoning ?? false,
				contextWindow: config.model?.contextWindow ?? 128_000,
				maxTokens: config.model?.maxTokens ?? 16_384,
				compat: config.model?.compat,
				thinkingLevelMap: config.model?.thinkingLevelMap,
				apiKeyEnvironmentVariable: config.model?.apiKeyEnvironmentVariable,
				headers: config.model?.headers,
			},
			configuredModels,
		);
		await service.restoreSessions();
		service.startPaperSessionCleanup();
		return service;
	}
}

export async function createWebAgentService(options: WebAgentServiceOptions): Promise<WebAgentService> {
	return WebAgentService.create(options);
}
