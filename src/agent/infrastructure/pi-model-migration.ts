import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PaperAgentConfig } from "../../config/domain/config-types.ts";

async function exists(path: string): Promise<boolean> {
	return readFile(path).then(
		() => true,
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return false;
			throw error;
		},
	);
}

function canonicalEndpoint(value: string): string {
	return value.replace(/\/$/, "").replace(/\/v1$/, "");
}

/** Import once; native files and credentials always win over the old application configuration. */
export async function importLegacyPiModels(
	directory: string,
	projectRoot: string,
	config: PaperAgentConfig,
): Promise<void> {
	const marker = join(directory, "legacy-import.json");
	if (await exists(marker)) return;
	await mkdir(directory, { recursive: true });
	const auth: Record<string, { type: "api_key"; key: string }> = {};
	const providers: Record<string, Record<string, unknown>> = {};
	for (const model of config.models ?? (config.model ? [config.model] : [])) {
		if (model.apiKey) auth[model.providerId] ??= { type: "api_key", key: model.apiKey };
		const builtin = getBuiltinModel(model.providerId as never, model.modelId as never);
		const official =
			builtin &&
			builtin.api === model.api &&
			canonicalEndpoint(builtin.baseUrl) === canonicalEndpoint(model.baseUrl);
		if (official && !model.apiKeyEnvironmentVariable) continue;
		providers[model.providerId] ??= {
			baseUrl: model.baseUrl,
			api: model.api,
			...(model.apiKeyEnvironmentVariable ? { apiKey: `$${model.apiKeyEnvironmentVariable}` } : {}),
			models: [],
		};
		(providers[model.providerId].models as unknown[]).push({
			id: model.modelId,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			compat: model.compat,
			thinkingLevelMap: model.thinkingLevelMap,
			headers: model.headers,
		});
	}
	if (!(await exists(join(directory, "auth.json"))))
		await writeFile(join(directory, "auth.json"), JSON.stringify(auth, null, 2), { flag: "wx", mode: 0o600 });
	if (!(await exists(join(directory, "models.json"))))
		await writeFile(join(directory, "models.json"), JSON.stringify({ providers }, null, 2), { flag: "wx" });
	if (config.model && !(await exists(join(directory, "settings.json")))) {
		const settings = SettingsManager.create(projectRoot, directory);
		settings.setDefaultModelAndProvider(config.model.providerId, config.model.modelId);
		await settings.flush();
	}
	await writeFile(marker, JSON.stringify({ version: 1, importedAt: new Date().toISOString() }), { flag: "wx" });
}
