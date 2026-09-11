import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
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
} from "../src/config/application/model-service.ts";

interface ParsedArguments {
	command: "add" | "list" | "probe-image";
	providerId?: string;
	baseUrl?: string;
	api?: ModelApiKind;
	apiKey?: string;
	active?: string;
	json: boolean;
	yes: boolean;
}

class CommandComplete extends Error {}

const SUPPORTED_APIS: ModelApiKind[] = ["openai-completions", "openai-responses"];

function parseArguments(argv: string[]): ParsedArguments {
	const args = [...argv];
	const first = args[0]?.toLowerCase();
	const command =
		first === "list" || first === "add" || first === "probe-image"
			? (args.shift()!.toLowerCase() as ParsedArguments["command"])
			: "add";
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
			case "--model":
				parsed.active = value();
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
		"  paper-agent models list",
		"  paper-agent models probe-image --model deepseek/deepseek-flash",
		"",
		"Options:",
		"  --api openai-completions|openai-responses  API adapter, default openai-completions",
		"                                            Relay-compatible client headers are applied",
		"  --active <model-id>                       Set the active model after discovery",
		"  --json                                    Print machine-readable output",
	].join("\n");
}

const rl = createInterface({ input, output });
const runtimeRl = rl as typeof rl & { stdoutMuted?: boolean; _writeToOutput?: (value: string) => void };
const originalWriteToOutput = runtimeRl._writeToOutput?.bind(rl);
if (originalWriteToOutput) {
	runtimeRl._writeToOutput = (value: string) => {
		if (runtimeRl.stdoutMuted) output.write(value.includes("\n") ? value : "*");
		else originalWriteToOutput(value);
	};
}

async function ask(label: string, current = ""): Promise<string> {
	const suffix = current ? ` [${current}]` : "";
	const answer = (await rl.question(`${label}${suffix}: `)).trim();
	return answer || current;
}

async function askSecret(label: string): Promise<string> {
	output.write(`${label}: `);
	runtimeRl.stdoutMuted = true;
	try {
		const answer = (await rl.question("")).trim();
		output.write("\n");
		return answer;
	} finally {
		runtimeRl.stdoutMuted = false;
	}
}

async function chooseActive(discovered: PaperAgentModelConfig[], requested?: string, assumeYes = false) {
	if (requested) {
		const selected = discovered.find(
			(model) => model.modelId === requested || `${model.providerId}/${model.modelId}` === requested,
		);
		if (!selected) throw new Error(`Discovered models do not include: ${requested}`);
		return selected;
	}
	if (assumeYes || discovered.length === 1 || !input.isTTY) return discovered[0];
	const preview = discovered
		.slice(0, 20)
		.map((model, index) => `  ${index + 1}. ${model.providerId}/${model.modelId}`)
		.join("\n");
	output.write(`\nDiscovered models:\n${preview}${discovered.length > 20 ? "\n  ..." : ""}\n`);
	const raw = await ask("Choose active model number", "1");
	const index = Number(raw);
	if (!Number.isInteger(index) || index < 1 || index > discovered.length)
		throw new Error("Invalid active model number");
	return discovered[index - 1];
}

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
			for (const model of report.models) console.log(`- ${model.providerId}/${model.modelId} (${model.api})`);
		}
		throw new CommandComplete();
	}
	if (parsed.command === "probe-image") {
		const requested =
			parsed.active ?? (config.model ? `${config.model.providerId}/${config.model.modelId}` : undefined);
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
	const active = await chooseActive(discovered, parsed.active, parsed.yes);
	const next = {
		...config,
		model: active,
		models: mergeDiscoveredModels(config.models ?? (config.model ? [config.model] : []), discovered),
	};
	const saved = await savePaperAgentConfig(projectRoot, next);
	const report = {
		configPath: resolvePaperAgentConfigPaths(projectRoot).modelsFile,
		discovered: discovered.length,
		active: `${active.providerId}/${active.modelId}`,
		config: redactPaperAgentConfig(saved.config),
	};
	if (parsed.json) console.log(JSON.stringify(report, null, 2));
	else {
		console.log(`Discovered ${discovered.length} model(s).`);
		console.log(`Active model: ${report.active}`);
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
	rl.close();
}
