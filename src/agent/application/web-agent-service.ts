import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import type { PaperAgentModelConfig } from "../../config/domain/config-types.ts";
import type { WebAgentServiceApi } from "../domain/web-agent-contracts.ts";
import { WebAgentActions } from "./web-agent-actions.ts";
import {
	emptyEndpointConfig,
	endpointFromConfiguredModel,
	type WebAgentEndpointConfig,
	type WebAgentServiceOptions,
} from "./web-agent-support.ts";

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
		// 服务启动只是取一份初始状态；之后 `reloadConfiguredModels` 会在读取配置视图
		// 和切换模型时重新对齐磁盘，设置页的改动无需重启。
		const service = new WebAgentService(
			{ ...options, builtinTools: config.agent.builtinTools, shellPath: config.agent.shellPath },
			config.model ? endpointFromConfiguredModel(config.model) : emptyEndpointConfig(),
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
