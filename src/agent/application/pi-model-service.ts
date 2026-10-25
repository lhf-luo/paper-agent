import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiKeyCredential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, readStoredCredential, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import type { PiAuthPrompt, PiModelsView, PiModelView } from "../domain/pi-models.ts";

class PromptRequired extends Error {
	readonly prompt: PiAuthPrompt;
	constructor(prompt: PiAuthPrompt) {
		super("Credential input required");
		this.prompt = prompt;
	}
}

export class PiModelService {
	readonly directory: string;
	readonly projectRoot: string;
	private current?: { stamp: string; runtime: ModelRuntime };
	private loading?: Promise<ModelRuntime>;
	private readonly builtins = builtinProviders();
	constructor(projectRoot: string, directory = join(projectRoot, ".paper-agent", "pi")) {
		this.directory = directory;
		this.projectRoot = projectRoot;
	}

	async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		for (const [name, value] of [["auth.json", {}], ["models.json", { providers: {} }]] as const) {
			await writeFile(join(this.directory, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 })
				.catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
		}
	}

	async stamp(): Promise<string> {
		return (
			await Promise.all(
				["auth.json", "models.json", "models-store.json", "settings.json"].map(async (name) => {
					const value = await stat(join(this.directory, name)).catch(() => undefined);
					return `${name}:${value?.mtimeMs}:${value?.size}`;
				}),
			)
		).join(";");
	}

	async runtime(): Promise<ModelRuntime> {
		const stamp = await this.stamp();
		if (this.current?.stamp === stamp) return this.current.runtime;
		if (this.loading) return this.loading;
		this.loading = ModelRuntime.create({
			authPath: join(this.directory, "auth.json"),
			modelsPath: join(this.directory, "models.json"),
			allowModelNetwork: false,
		})
			.then(async (runtime) => {
				this.current = { stamp: await this.stamp(), runtime };
				return runtime;
			})
			.finally(() => {
				this.loading = undefined;
			});
		return this.loading;
	}

	async view(refresh = false): Promise<PiModelsView> {
		const runtime = await this.runtime();
		if (refresh) {
			const result = await runtime.refresh({ allowNetwork: true, force: true, signal: AbortSignal.timeout(20_000) });
			if (result.errors.size) throw new Error("部分模型目录刷新失败；已保留缓存，请稍后重试。");
		}
		const available = await runtime.getAvailable();
		const settings = SettingsManager.create(this.projectRoot, this.directory);
		const provider = settings.getDefaultProvider(),
			model = settings.getDefaultModel();
		return {
			directory: this.directory,
			error: runtime.getError() ? "Pi 模型配置有误，请检查 models.json。" : undefined,
			activeKey: provider && model ? `${provider}/${model}` : undefined,
			providers: this.builtins
				.map((p) => ({
					id: p.id,
					name: p.name,
					configured: runtime.hasConfiguredAuth(p.id),
					modelCount: runtime.getModels(p.id).length,
					apiKeyLogin: Boolean(p.auth.apiKey?.login),
					oauth: Boolean(p.auth.oauth),
					customized: runtime
						.getModels(p.id)
						.some((m) => !p.getModels().some((b) => b.id === m.id && b.baseUrl === m.baseUrl)),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			models: available.map(
				(m): PiModelView => ({
					key: `${m.provider}/${m.id}`,
					providerId: m.provider,
					modelId: m.id,
					name: m.name,
					baseUrl: m.baseUrl,
					api: m.api,
					input: m.input,
					credentialsAvailable: true,
				}),
			),
		};
	}

	async select(key: string): Promise<void> {
		const model = (await this.view()).models.find((m) => m.key === key);
		if (!model) throw new Error("模型不可用，请检查 Pi 凭据和模型文件。");
		const settings = SettingsManager.create(this.projectRoot, this.directory);
		settings.setDefaultModelAndProvider(model.providerId, model.modelId);
		await settings.flush();
	}

	async credential(providerId: string, answers: string[]): Promise<ApiKeyCredential | PiAuthPrompt> {
		const provider = this.builtins.find((p) => p.id === providerId);
		if (!provider) throw new Error("网页仅支持配置 Pi 内置提供商；中转站请编辑 models.json。");
		if (!provider.auth.apiKey?.login) throw new Error("此提供商需要通过 Pi 终端登录或配置环境凭据。");
		let index = 0;
		try {
			return await provider.auth.apiKey.login({
				signal: AbortSignal.timeout(30_000),
				notify: () => undefined,
				prompt: async (prompt) => {
					if (index >= answers.length) throw new PromptRequired(prompt);
					const answer = answers[index++];
					if (prompt.type === "select" && !prompt.options.some((o) => o.id === answer))
						throw new Error("请选择有效的凭据类型。");
					if (prompt.type === "secret" && !answer.trim()) throw new Error("密钥不能为空。");
					return answer;
				},
			});
		} catch (error) {
			if (error instanceof PromptRequired) return error.prompt;
			throw new Error("Pi 凭据配置失败，请检查输入后重试。");
		}
	}

	plan(providerId: string, credential: ApiKeyCredential): OperationPlan {
		return {
			kind: "configuration-write",
			summary: `配置 Pi 提供商 ${providerId}`,
			actor: "local-user",
			targets: [{ label: "Pi 凭据文件", value: join(this.directory, "auth.json"), risk: "medium" }],
			details: { providerId, fingerprint: createHash("sha256").update(JSON.stringify(credential)).digest("hex") },
		};
	}

	async save(providerId: string, answers: string[]): Promise<void> {
		let index = 0;
		await (await this.runtime()).login(providerId, "api_key", {
			prompt: async () => answers[index++],
			notify: () => undefined,
		});
		this.current = undefined;
	}

	async secrets(): Promise<string[]> {
		const auth = JSON.parse(await readFile(join(this.directory, "auth.json"), "utf8").catch(() => "{}"));
		const values: string[] = [];
		for (const id of Object.keys(auth)) {
			const entry = readStoredCredential(id, join(this.directory, "auth.json"));
			if (entry?.type === "api_key" && entry.key) values.push(entry.key);
			if (entry?.type === "oauth") values.push(entry.access, entry.refresh);
		}
		return values;
	}
}
