import { readFileSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PaperAgentConfig, PaperAgentConfigPaths, PaperAgentModelConfig } from "../domain/config-types.ts";
import { defaultPaperAgentConfig, hasOwn, isRecord, validatePaperAgentConfig } from "../domain/config-validation.ts";

const SPLIT_CONFIG_DIRECTORY = "config";
const REDACTED_SECRET = "[redacted]";

export function resolvePaperAgentConfigDirectory(projectRoot: string): string {
	const override = process.env.PAPER_AGENT_CONFIG_DIR;
	return resolve(override ? override : join(projectRoot, ".paper-agent", SPLIT_CONFIG_DIRECTORY));
}

export function resolvePaperAgentConfigPaths(projectRoot: string): PaperAgentConfigPaths {
	const directory = resolvePaperAgentConfigDirectory(projectRoot);
	return {
		directory,
		appFile: join(directory, "app.json"),
		searchFile: join(directory, "search.json"),
		modelsFile: join(directory, "models.json"),
		modelAuthFile: join(directory, "auth.json"),
		networkFile: join(directory, "network.json"),
		credentialsFile: join(directory, "credentials.json"),
	};
}

function modelCredentials(auth: unknown, providerId: string): Record<string, unknown> {
	if (!isRecord(auth) || !isRecord(auth[providerId])) return {};
	const entry = auth[providerId];
	if (entry.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
		return { apiKey: entry.key.trim() };
	}
	if (entry.type === "environment" && typeof entry.variable === "string" && entry.variable.trim()) {
		return { apiKeyEnvironmentVariable: entry.variable.trim() };
	}
	throw new Error(`auth.json entry for ${providerId} is invalid`);
}

function normalizeModelsPart(models: unknown, auth: unknown): Record<string, unknown> | undefined {
	if (models === undefined) return undefined;
	if (!isRecord(models) || !isRecord(models.providers)) {
		throw new Error("models.json must contain a providers object");
	}
	const flattened: Record<string, unknown>[] = [];
	for (const [providerId, rawProvider] of Object.entries(models.providers)) {
		if (!isRecord(rawProvider) || !Array.isArray(rawProvider.models)) {
			throw new Error(`models.json provider ${providerId} must contain a models array`);
		}
		for (const rawModel of rawProvider.models) {
			if (!isRecord(rawModel)) throw new Error(`models.json provider ${providerId} contains an invalid model`);
			flattened.push({
				...rawModel,
				providerId,
				modelId: rawModel.id,
				...modelCredentials(auth, providerId),
			});
		}
	}
	const active = typeof models.active === "string" ? models.active : undefined;
	const activeModel = active
		? flattened.find((model) => `${model.providerId}/${model.modelId}` === active)
		: flattened[0];
	if (active && !activeModel) throw new Error(`models.json active model was not found: ${active}`);
	return {
		model: activeModel,
		models: flattened,
		updatedAt: models.updatedAt,
	};
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readJsonIfExistsSync(path: string): unknown | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function mergeConfigParts(
	base: PaperAgentConfig,
	parts: {
		app?: unknown;
		search?: unknown;
		models?: unknown;
		modelAuth?: unknown;
		network?: unknown;
		credentials?: unknown;
	},
): unknown {
	const app = isRecord(parts.app) ? parts.app : {};
	const models = normalizeModelsPart(parts.models, parts.modelAuth);
	return {
		...base,
		...(hasOwn(app, "version") ? { version: app.version } : {}),
		...(hasOwn(app, "interface") ? { interface: app.interface } : {}),
		...(hasOwn(app, "storage") ? { storage: app.storage } : {}),
		...(hasOwn(app, "externalTools") ? { externalTools: app.externalTools } : {}),
		...(hasOwn(app, "agent") ? { agent: app.agent } : {}),
		...(hasOwn(app, "confirmations") ? { confirmations: app.confirmations } : {}),
		...(hasOwn(app, "pdfTranslation") ? { pdfTranslation: app.pdfTranslation } : {}),
		...(hasOwn(app, "mineru") ? { mineru: app.mineru } : {}),
		...(hasOwn(app, "wiki") ? { wiki: app.wiki } : {}),
		...(hasOwn(app, "updatedAt") ? { updatedAt: app.updatedAt } : {}),
		...(parts.search !== undefined ? { search: parts.search } : {}),
		...(models
			? {
					...(hasOwn(models, "model") ? { model: models.model } : {}),
					...(hasOwn(models, "models") ? { models: models.models } : {}),
					...(hasOwn(models, "updatedAt") ? { updatedAt: models.updatedAt } : {}),
				}
			: {}),
		...(parts.network !== undefined ? { network: parts.network } : {}),
		...(parts.credentials !== undefined ? { credentials: parts.credentials } : {}),
	};
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function removeIfExists(path: string): Promise<void> {
	await rm(path, { force: true }).catch(() => undefined);
}

export async function loadPaperAgentConfig(projectRoot: string): Promise<PaperAgentConfig> {
	const paths = resolvePaperAgentConfigPaths(projectRoot);
	try {
		const parts = {
			app: await readJsonIfExists(paths.appFile),
			search: await readJsonIfExists(paths.searchFile),
			models: await readJsonIfExists(paths.modelsFile),
			modelAuth: await readJsonIfExists(paths.modelAuthFile),
			network: await readJsonIfExists(paths.networkFile),
			credentials: await readJsonIfExists(paths.credentialsFile),
		};
		return validatePaperAgentConfig(mergeConfigParts(defaultPaperAgentConfig(), parts), projectRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultPaperAgentConfig();
		}
		throw error;
	}
}

export function loadPaperAgentConfigSync(projectRoot: string): PaperAgentConfig {
	const paths = resolvePaperAgentConfigPaths(projectRoot);
	const parts = {
		app: readJsonIfExistsSync(paths.appFile),
		search: readJsonIfExistsSync(paths.searchFile),
		models: readJsonIfExistsSync(paths.modelsFile),
		modelAuth: readJsonIfExistsSync(paths.modelAuthFile),
		network: readJsonIfExistsSync(paths.networkFile),
		credentials: readJsonIfExistsSync(paths.credentialsFile),
	};
	return validatePaperAgentConfig(mergeConfigParts(defaultPaperAgentConfig(), parts), projectRoot);
}

function storedModel(model: PaperAgentModelConfig): Record<string, unknown> {
	return {
		id: model.modelId,
		name: model.name ?? model.modelId,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.headers ? { headers: model.headers } : {}),
		...(model.compat ? { compat: model.compat } : {}),
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		...(model.toolCallingVerifiedAt ? { toolCallingVerifiedAt: model.toolCallingVerifiedAt } : {}),
		...(model.toolCallingProbe ? { toolCallingProbe: model.toolCallingProbe } : {}),
		...(model.imageInputProbe ? { imageInputProbe: model.imageInputProbe } : {}),
	};
}

function configuredModels(config: PaperAgentConfig): PaperAgentModelConfig[] {
	const models = [...(config.models ?? [])];
	if (!config.model) return models;
	const index = models.findIndex(
		(model) => model.providerId === config.model?.providerId && model.modelId === config.model?.modelId,
	);
	if (index >= 0) models[index] = config.model;
	else models.unshift(config.model);
	return models;
}

function existingModelApiKey(
	existing: PaperAgentConfig,
	providerId: string | undefined,
	modelId: string | undefined,
): string | undefined {
	if (!providerId) return undefined;
	const models = [existing.model, ...(existing.models ?? [])].filter((model): model is PaperAgentModelConfig =>
		Boolean(model),
	);
	return (
		models.find((model) => model.providerId === providerId && model.modelId === modelId)?.apiKey ??
		models.find((model) => model.providerId === providerId)?.apiKey
	);
}

function preserveRedactedModelApiKey(value: unknown, existing: PaperAgentConfig): unknown {
	if (!isRecord(value) || value.apiKey !== REDACTED_SECRET) return value;
	const apiKey = existingModelApiKey(
		existing,
		typeof value.providerId === "string" ? value.providerId : undefined,
		typeof value.modelId === "string" ? value.modelId : undefined,
	);
	if (!apiKey || apiKey === REDACTED_SECRET) {
		throw new Error("A redacted model API key cannot be saved because no original credential is available");
	}
	return { ...value, apiKey };
}

function preserveRedactedSecrets(value: unknown, existing: PaperAgentConfig): unknown {
	if (!isRecord(value)) return value;
	const next: Record<string, unknown> = { ...value };
	if (next.model !== undefined) next.model = preserveRedactedModelApiKey(next.model, existing);
	if (Array.isArray(next.models)) {
		next.models = next.models.map((model) => preserveRedactedModelApiKey(model, existing));
	}
	if (isRecord(next.credentials)) {
		const credentials = { ...next.credentials };
		for (const [field, candidate] of Object.entries(credentials)) {
			if (candidate !== REDACTED_SECRET) continue;
			const original = existing.credentials?.[field as keyof NonNullable<PaperAgentConfig["credentials"]>];
			if (!original || original === REDACTED_SECRET) {
				throw new Error(`A redacted credential cannot be saved because no original value is available: ${field}`);
			}
			credentials[field] = original;
		}
		next.credentials = credentials;
	}
	return next;
}

function storedModels(config: PaperAgentConfig): Record<string, unknown> {
	const providers: Record<string, { models: Record<string, unknown>[] }> = {};
	for (const model of configuredModels(config)) {
		providers[model.providerId] ??= { models: [] };
		providers[model.providerId].models.push(storedModel(model));
	}
	return {
		active: config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined,
		providers,
		updatedAt: config.updatedAt,
	};
}

function storedModelAuth(config: PaperAgentConfig): Record<string, unknown> {
	const auth: Record<string, unknown> = {};
	for (const model of configuredModels(config)) {
		const entry = model.apiKey
			? { type: "api_key", key: model.apiKey }
			: model.apiKeyEnvironmentVariable
				? { type: "environment", variable: model.apiKeyEnvironmentVariable }
				: undefined;
		if (!entry) continue;
		const previous = auth[model.providerId];
		if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
			throw new Error(`Models under provider ${model.providerId} must share one credential`);
		}
		auth[model.providerId] = entry;
	}
	return auth;
}

export async function savePaperAgentConfig(
	projectRoot: string,
	value: unknown,
): Promise<{ config: PaperAgentConfig; path: string }> {
	const existing = await loadPaperAgentConfig(projectRoot);
	const preserved = preserveRedactedSecrets(value, existing);
	const config = validatePaperAgentConfig(
		{ ...(preserved as object), updatedAt: new Date().toISOString() },
		projectRoot,
	);
	const paths = resolvePaperAgentConfigPaths(projectRoot);
	await mkdir(paths.directory, { recursive: true });
	await Promise.all([
		writeJsonAtomic(paths.appFile, {
			version: config.version,
			interface: config.interface,
			storage: config.storage,
			externalTools: config.externalTools,
			agent: config.agent,
			confirmations: config.confirmations,
			pdfTranslation: config.pdfTranslation,
			mineru: config.mineru,
			wiki: config.wiki,
			updatedAt: config.updatedAt,
		}),
		writeJsonAtomic(paths.searchFile, config.search),
		writeJsonAtomic(paths.modelsFile, storedModels(config)),
		Object.keys(storedModelAuth(config)).length
			? writeJsonAtomic(paths.modelAuthFile, storedModelAuth(config))
			: removeIfExists(paths.modelAuthFile),
		config.network ? writeJsonAtomic(paths.networkFile, config.network) : removeIfExists(paths.networkFile),
		config.credentials
			? writeJsonAtomic(paths.credentialsFile, config.credentials)
			: removeIfExists(paths.credentialsFile),
		removeIfExists(join(paths.directory, "team.json")),
	]);
	return { config, path: paths.directory };
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
