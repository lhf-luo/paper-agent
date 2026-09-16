import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
	loadPaperAgentConfig,
	type ModelApiKind,
	type PaperAgentModelConfig,
	redactPaperAgentConfig,
	relayHeadersForModelApi,
	resolvePaperAgentConfigPaths,
	savePaperAgentConfig,
} from "../src/config/application/config-service.ts";
import {
	discoverModelEndpointModels,
	mergeDiscoveredModels,
	probeModelImageInput,
	removeConfiguredModel,
	removeConfiguredProvider,
	resolveConfiguredModel,
} from "../src/config/application/model-service.ts";
import { ModelPrompts } from "./model-prompts.ts";

interface ParsedArguments {
	command: "add" | "list" | "probe-image" | "remove";
	providerId?: string;
	baseUrl?: string;
	api?: ModelApiKind;
	apiKey?: string;
	active?: string;
	model?: string;
	reasoning?: boolean;
	json: boolean;
	yes: boolean;
}

class CommandComplete extends Error {}

const SUPPORTED_APIS: ModelApiKind[] = ["openai-completions", "openai-responses"];

function parseArguments(argv: string[]): ParsedArguments {
	const args = [...argv];
	const first = args[0]?.toLowerCase();
	const recognized = ["list", "add", "probe-image", "remove", "delete"].includes(first ?? "");
	const command: ParsedArguments["command"] = recognized
		? first === "delete"
			? "remove"
			: (first as ParsedArguments["command"])
		: "add";
	if (recognized) args.shift();
	const parsed: ParsedArguments = { command, json: false, yes: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = () => {
			const next = args[index + 1];
			if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
			index += 1;
			return next;
		};
		switch (arg) {
			case "--provider":
			case "--provider-id":
				parsed.providerId = value();
				break;
			case "--base-url":
				parsed.baseUrl = value();
				break;
			case "--api":
				parsed.api = value() as ModelApiKind;
				break;
			case "--api-key":
				parsed.apiKey = value();
				break;
			case "--active":
				parsed.active = value();
				break;
			case "--model":
				parsed.model = value();
				break;
			case "--reasoning":
				if (parsed.reasoning === false) throw new Error("--reasoning and --no-reasoning cannot be combined");
				parsed.reasoning = true;
				break;
			case "--no-reasoning":
				if (parsed.reasoning === true) throw new Error("--reasoning and --no-reasoning cannot be combined");
				parsed.reasoning = false;
				break;
			case "--json":
				parsed.json = true;
				break;
			case "--yes":
			case "-y":
				parsed.yes = true;
				break;
			case "--help":
			case "-h":
				throw new Error("help");
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	if (parsed.api && !SUPPORTED_APIS.includes(parsed.api)) {
		throw new Error(`--api must be one of: ${SUPPORTED_APIS.join(", ")}`);
	}
	return parsed;
}

function usage(): string {
	return [
		"Usage:",
		"  paper-agent models add --base-url https://provider.example/v1 --api-key sk-...",
		"  paper-agent models add --provider deepseek --base-url https://api.deepseek.com/v1",
		"  paper-agent models remove --model provider/model-id",
		"  paper-agent models remove --provider provider-id",
		"  paper-agent models remove --model provider/model-id --active provider/replacement-id",
		"  paper-agent models list",
		"  paper-agent models probe-image --model deepseek/deepseek-flash",
		"",
		"Options:",
		"  --api openai-completions|openai-responses  API adapter, default openai-completions",
		"                                            Relay-compatible client headers are applied",
		"  --active <model-id>                       Explicitly set an active or replacement model",
		"  --model <provider/model-id>               Select a model for probe or removal",
		"  --reasoning                               Enable reasoning for all discovered models (default)",
		"  --no-reasoning                            Disable reasoning for all discovered models",
		"  --yes                                     Accept defaults without interactive questions",
		"  --json                                    Print machine-readable output",
	].join("\n");
}

const prompts = new ModelPrompts(input, output);
const ask = prompts.ask.bind(prompts);
const askSecret = prompts.askSecret.bind(prompts);

try {
	const parsed = parseArguments(process.argv.slice(2));
	const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const config = await loadPaperAgentConfig(projectRoot);
	if (parsed.command === "list") {
		const report = {
			configPath: resolvePaperAgentConfigPaths(projectRoot).modelsFile,
			active: config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined,
			models: redactPaperAgentConfig(config).models ?? [],
		};
		if (parsed.json) console.log(JSON.stringify(report, null, 2));
		else {
			console.log(`Model config: ${report.configPath}`);
			console.log(`Active: ${report.active ?? "(not configured)"}`);
			for (const model of report.models) {
				console.log(
					`- ${model.providerId}/${model.modelId} (${model.api}, reasoning=${model.reasoning ? "yes" : "no"})`,
				);
			}
		}
		throw new CommandComplete();
	}
	if (parsed.command === "probe-image") {
		const requested =
			parsed.model ??
			parsed.active ??
			(config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined);
		if (!requested) throw new Error("--model is required when no active model is configured");
		const model = (config.models ?? []).find(
			(entry) => entry.modelId === requested || `${entry.providerId}/${entry.modelId}` === requested,
		);
		if (!model) throw new Error(`Configured model was not found: ${requested}`);
		const result = await probeModelImageInput(model);
		const updated = {
			...model,
			input: result.supported ? (["text", "image"] as PaperAgentModelConfig["input"]) : model.input,
			imageInputProbe: result,
		};
		const models = (config.models ?? []).map((entry) =>
			entry.providerId === model.providerId && entry.modelId === model.modelId ? updated : entry,
		);
		const active =
			config.model?.providerId === model.providerId && config.model.modelId === model.modelId
				? updated
				: config.model;
		await savePaperAgentConfig(projectRoot, { ...config, model: active, models });
		const report = { model: `${model.providerId}/${model.modelId}`, ...result, input: updated.input };
		if (parsed.json) console.log(JSON.stringify(report, null, 2));
		else {
			console.log(`Model: ${report.model}`);
			console.log(`Image input: ${result.supported ? "supported" : "not verified"}`);
			console.log(`Reason: ${result.reason}`);
		}
		process.exitCode = 0;
		throw new CommandComplete();
	}
	if (parsed.command === "remove") {
		if (Boolean(parsed.model) === Boolean(parsed.providerId)) {
			throw new Error("models remove requires exactly one of --model or --provider");
		}
		const result = parsed.providerId
			? removeConfiguredProvider(config.models ?? [], config.model, parsed.providerId, parsed.active)
			: removeConfiguredModel(config.models ?? [], config.model, parsed.model!, parsed.active);
		const removedModels = Array.isArray(result.removed) ? result.removed : [result.removed];
		const removedKeys = new Set(removedModels.map((model) => `${model.providerId}/${model.modelId}`));
		const clearsPdfTranslationModel = Boolean(
			config.pdfTranslation.modelKey && removedKeys.has(config.pdfTranslation.modelKey),
		);
		await savePaperAgentConfig(projectRoot, {
			...config,
			model: result.active,
			models: result.models,
			pdfTranslation: clearsPdfTranslationModel
				? { ...config.pdfTranslation, modelKey: undefined }
				: config.pdfTranslation,
		});
		const report = {
			removed: removedModels.map((model) => `${model.providerId}/${model.modelId}`),
			active: result.active ? `${result.active.providerId}/${result.active.modelId}` : undefined,
			remaining: result.models.length,
			providerCredentialsRemoved: [
				...new Set(
					removedModels
						.map((model) => model.providerId)
						.filter((providerId) => !result.models.some((model) => model.providerId === providerId)),
				),
			],
			pdfTranslationModelCleared: clearsPdfTranslationModel,
			configPath: resolvePaperAgentConfigPaths(projectRoot).modelsFile,
		};
		if (parsed.json) console.log(JSON.stringify(report, null, 2));
		else {
			console.log(`Removed model(s): ${report.removed.join(", ")}`);
			console.log(`Active model: ${report.active ?? "(not configured)"}`);
			console.log(`Remaining models: ${report.remaining}`);
			if (report.providerCredentialsRemoved.length) {
				console.log(`Removed unused credential(s): ${report.providerCredentialsRemoved.join(", ")}`);
			}
			if (report.pdfTranslationModelCleared) console.log("Cleared the removed PDF translation model reference.");
			console.log(`Saved: ${report.configPath}`);
		}
		throw new CommandComplete();
	}

	const api = parsed.api ?? "openai-completions";
	const providerId =
		parsed.providerId ?? (await ask("Provider id (blank infers from Base URL)", config.model?.providerId ?? ""));
	const baseUrl = parsed.baseUrl ?? (await ask("Base URL", config.model?.baseUrl ?? ""));
	const apiKey = parsed.apiKey ?? (await askSecret("API key"));
	const discovered = await discoverModelEndpointModels({
		providerId: providerId || undefined,
		baseUrl,
		api,
		apiKey,
		headers: relayHeadersForModelApi(api),
	});
	let models = mergeDiscoveredModels(config.models ?? (config.model ? [config.model] : []), discovered);
	models = models.map((model) =>
		model.providerId === discovered[0].providerId
			? {
					...model,
					...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
					input: ["text", "image"] as PaperAgentModelConfig["input"],
				}
			: model,
	);
	const previousActive = config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined;
	const activeKey =
		parsed.active ??
		(previousActive && models.some((model) => `${model.providerId}/${model.modelId}` === previousActive)
			? previousActive
			: undefined);
	const active = activeKey ? resolveConfiguredModel(models, activeKey) : undefined;
	const next = {
		...config,
		model: active,
		models,
	};
	const saved = await savePaperAgentConfig(projectRoot, next);
	const report = {
		configPath: resolvePaperAgentConfigPaths(projectRoot).modelsFile,
		discovered: discovered.length,
		active: active ? `${active.providerId}/${active.modelId}` : undefined,
		config: redactPaperAgentConfig(saved.config),
	};
	if (parsed.json) console.log(JSON.stringify(report, null, 2));
	else {
		console.log(`Discovered ${discovered.length} model(s).`);
		console.log(`Active model: ${report.active ?? "(select in Agent chat)"}`);
		console.log(`Image-capable models: ${models.filter((model) => model.input.includes("image")).length}`);
		console.log(`Saved: ${report.configPath}`);
	}
} catch (error) {
	if (error instanceof CommandComplete) {
		// The command completed with the exit code already selected above.
	} else if (error instanceof Error && error.message === "help") {
		console.log(usage());
	} else {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(usage());
		process.exitCode = 1;
	}
} finally {
	prompts.close();
}
