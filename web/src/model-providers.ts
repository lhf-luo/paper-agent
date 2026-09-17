import type { ModelConfigView, PaperAgentConfigView } from "./types.ts";

export type ModelApiKind = ModelConfigView["api"];

export const MODEL_API_KINDS: readonly ModelApiKind[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/** 只有 OpenAI 兼容协议能通过 `/models` 自动发现模型，其余需要手动填写模型 ID。 */
export function supportsModelDiscovery(api: ModelApiKind): boolean {
	return api === "openai-completions" || api === "openai-responses";
}

export interface ProviderGroup {
	providerId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKeyEnvironmentVariable?: string;
	/** 该供应商下是否至少有一个模型带有可用凭据。 */
	credentialsAvailable: boolean;
	models: ModelConfigView[];
}

export interface AddProviderInput {
	providerId: string;
	baseUrl: string;
	api: ModelApiKind;
	/** 留空表示不改变已有凭据，或为新建供应商声明无密钥。 */
	apiKey?: string;
	apiKeyEnvironmentVariable?: string;
	modelIds: string[];
	/** 需要保留元数据的既有模型（重新配置同一供应商时按身份匹配）。 */
	existing?: ModelConfigView[];
}

export function modelKey(model: Pick<ModelConfigView, "providerId" | "modelId">): string {
	return `${model.providerId}/${model.modelId}`;
}

/**
 * 把一份新的配置写回一个可变草稿对象，使设置页的更新函数能拿到完整结果。
 * 单纯 `Object.assign` 不会删除 `model` 这类被有意移除的键，所以这里先清掉
 * 目标上多余的顶层字段。
 */
export function replaceConfig(target: PaperAgentConfigView, source: PaperAgentConfigView): void {
	for (const key of Object.keys(target)) {
		if (!(key in source)) delete (target as unknown as Record<string, unknown>)[key];
	}
	Object.assign(target, source);
}

/** 当前模型 + 已配置模型去重后的完整列表，当前模型排在最前。 */
export function configuredModels(config: PaperAgentConfigView): ModelConfigView[] {
	const seen = new Set<string>();
	const models: ModelConfigView[] = [];
	for (const model of [config.model, ...(config.models ?? [])]) {
		if (!model) continue;
		const key = modelKey(model);
		if (seen.has(key)) continue;
		seen.add(key);
		models.push(model);
	}
	return models;
}

/** 按供应商分组，供设置页展示；组内保持配置顺序。 */
export function providerGroups(config: PaperAgentConfigView): ProviderGroup[] {
	const groups = new Map<string, ProviderGroup>();
	for (const model of configuredModels(config)) {
		const group: ProviderGroup = groups.get(model.providerId) ?? {
			providerId: model.providerId,
			baseUrl: model.baseUrl,
			api: model.api,
			apiKeyEnvironmentVariable: model.apiKeyEnvironmentVariable,
			credentialsAvailable: false,
			models: [],
		};
		group.models.push(model);
		group.credentialsAvailable ||= Boolean(
			model.credentialsAvailable ?? (model.apiKey ? model.apiKey !== "" : false),
		);
		groups.set(model.providerId, group);
	}
	return [...groups.values()];
}

function sanitize(model: ModelConfigView): ModelConfigView {
	const { credentialsAvailable: _credentialsAvailable, ...rest } = model;
	return rest;
}

/**
 * 把一个供应商及其模型写入配置。语义与 `paper-agent models add` 保持一致：同名
 * 供应商的旧条目会被新选择替换；身份与接口都未变的模型保留原有元数据。
 */
export function addProvider(config: PaperAgentConfigView, input: AddProviderInput): PaperAgentConfigView {
	const providerId = input.providerId.trim();
	const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
	const modelIds = [...new Set(input.modelIds.map((id) => id.trim()).filter(Boolean))];
	if (!providerId) throw new Error("供应商 ID 不能为空");
	if (!baseUrl) throw new Error("Base URL 不能为空");
	if (!modelIds.length) throw new Error("至少选择一个模型");

	const previous = new Map<string, ModelConfigView>();
	for (const model of [...(input.existing ?? []), ...configuredModels(config)]) {
		previous.set(modelKey(model), model);
	}

	const inherited = [...configuredModels(config)].find((model) => model.providerId === providerId);
	const credential = input.apiKey
		? { apiKey: input.apiKey }
		: input.apiKeyEnvironmentVariable
			? { apiKeyEnvironmentVariable: input.apiKeyEnvironmentVariable }
			: inherited?.apiKeyEnvironmentVariable
				? { apiKeyEnvironmentVariable: inherited.apiKeyEnvironmentVariable }
				: inherited?.apiKey
					? { apiKey: inherited.apiKey }
					: {};

	const added: ModelConfigView[] = modelIds.map((modelId) => {
		const identity = `${providerId}/${modelId}`;
		const before = previous.get(identity);
		const sameTransport =
			before && before.api === input.api && before.baseUrl.replace(/\/$/, "") === baseUrl;
		if (sameTransport && before) {
			return { ...sanitize(before), providerId, modelId, api: input.api, baseUrl, ...credential };
		}
		return {
			providerId,
			modelId,
			name: modelId,
			api: input.api,
			baseUrl,
			// 与 CLI 默认一致：`/models` 不会报告能力，因此先声明推理与图像输入。
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128_000,
			maxTokens: 16_384,
			...credential,
		};
	});

	const retained = configuredModels(config).filter((model) => model.providerId !== providerId);
	const models = [...retained, ...added].map(sanitize);
	const active = config.model;
	const stillActive = active && models.some((model) => modelKey(model) === modelKey(active));
	const next: PaperAgentConfigView = { ...config, models };
	if (!stillActive) delete next.model;
	return next;
}

export function removeModel(config: PaperAgentConfigView, key: string): PaperAgentConfigView {
	const models = configuredModels(config).filter((model) => modelKey(model) !== key);
	const next: PaperAgentConfigView = { ...config, models: models.map(sanitize) };
	if (config.model && modelKey(config.model) === key) delete next.model;
	return next;
}

export function removeProvider(config: PaperAgentConfigView, providerId: string): PaperAgentConfigView {
	const models = configuredModels(config).filter((model) => model.providerId !== providerId);
	const next: PaperAgentConfigView = { ...config, models: models.map(sanitize) };
	if (config.model?.providerId === providerId) delete next.model;
	return next;
}

/** 选择 Agent 对话使用的模型；传 undefined 表示不指定。 */
export function setActiveModel(config: PaperAgentConfigView, key?: string): PaperAgentConfigView {
	const next: PaperAgentConfigView = { ...config };
	delete next.model;
	if (!key) return next;
	const model = configuredModels(config).find((candidate) => modelKey(candidate) === key);
	if (!model) throw new Error(`未找到模型：${key}`);
	next.model = sanitize(model);
	return next;
}

/** 从 Base URL 猜测供应商 ID，与 CLI 的推断规则一致。 */
export function suggestProviderId(baseUrl: string): string {
	try {
		const hostname = new URL(baseUrl).hostname;
		// IP 字面量没有可用的注册域名标签，直接用整个地址作为 ID。
		const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
		const isIpv6 = hostname.includes(":");
		const parts = hostname.split(".").filter(Boolean);
		const candidate = isIpv4 || isIpv6 ? hostname : parts.length >= 2 ? parts[parts.length - 2] : parts[0];
		return candidate.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64) || "model-provider";
	} catch {
		return "model-provider";
	}
}

export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 与后端一致的前置校验，避免让用户提交一个注定被拒绝的配置。 */
export function validateProviderInput(input: {
	providerId: string;
	baseUrl: string;
}): string | undefined {
	if (!PROVIDER_ID_PATTERN.test(input.providerId.trim())) {
		return "供应商 ID 需为 1-64 位字母、数字、点、下划线或连字符，且以字母或数字开头。";
	}
	const baseUrl = input.baseUrl.trim();
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return "Base URL 必须是完整的绝对地址。";
	}
	const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
	if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
		return "Base URL 必须使用 HTTPS；只有本机回环地址可以使用 HTTP。";
	}
	return undefined;
}
