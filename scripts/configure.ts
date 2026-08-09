import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	defaultPaperAgentConfig,
	discoverPiCustomModels,
	loadPaperAgentConfig,
	probeModelToolCalling,
	savePaperAgentConfig,
	supportsAutomaticToolCallingProbe,
} from "../src/app-config.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultsOnly = process.argv.includes("--defaults") || process.argv.includes("--non-interactive");
const jsonOutput = process.argv.includes("--json");
const existing = await loadPaperAgentConfig(projectRoot);

if (defaultsOnly) {
	const result = await savePaperAgentConfig(projectRoot, existing.version ? existing : defaultPaperAgentConfig());
	if (jsonOutput) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(`Paper Agent configuration is ready: ${result.path}`);
		console.log("Run paper-agent to open the local interface.");
	}
	process.exit(0);
}

const rl = createInterface({ input, output });
const ask = async (label: string, current = "") => {
	const suffix = current ? ` [${current}]` : "";
	const value = (await rl.question(`${label}${suffix}: `)).trim();
	return value || current;
};
const yes = async (label: string, current = true) => {
	const answer = (await rl.question(`${label} [${current ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
	return answer ? ["y", "yes", "是"].includes(answer) : current;
};

try {
	console.log("\nPaper Agent first-run setup");
	console.log("Secrets are never written to this config. Enter environment-variable names only.\n");
	const next = structuredClone(existing);
	next.storage.defaultNamespace = await ask("Default personal namespace", existing.storage.defaultNamespace);
	next.storage.dataRoot =
		(await ask("Local data directory (blank uses .paper-agent)", existing.storage.dataRoot ?? "")) || undefined;
	next.interface.port = Number(await ask("Local Web port (0 chooses a free port)", String(existing.interface.port)));
	next.interface.openBrowser = await yes("Open the browser automatically", existing.interface.openBrowser);
	next.search.providers = (
		await ask("Default literature sources (comma separated)", existing.search.providers.join(","))
	)
		.split(",")
		.map((provider) => provider.trim())
		.filter(Boolean);
	next.search.maxResultsPerProvider = Number(
		await ask("Default result limit per literature source", String(existing.search.maxResultsPerProvider)),
	);
	next.search.pagesPerProvider = Number(
		await ask("Default pages per literature source", String(existing.search.pagesPerProvider)),
	);
	next.search.queryExpansions = (
		await ask("Default query expansions (comma separated; blank disables)", existing.search.queryExpansions.join(","))
	)
		.split(",")
		.map((query) => query.trim())
		.filter(Boolean);
	next.search.reuseCorpus = await yes("Reuse matching records from the personal corpus", existing.search.reuseCorpus);

	const discovered = await discoverPiCustomModels();
	if (!next.model && discovered.length) {
		console.log(`\nDetected ${discovered.length} custom Pi model(s).`);
		const useDetected = await yes(`Use ${discovered[0].providerId}/${discovered[0].modelId} for diagnostics`, true);
		if (useDetected) next.model = discovered[0];
	}
	if (await yes("Configure or update a model endpoint", Boolean(next.model))) {
		const current = next.model;
		next.model = {
			providerId: await ask("Provider id", current?.providerId ?? "research-relay"),
			modelId: await ask("Model id", current?.modelId ?? ""),
			api: (await ask(
				"API type (openai-completions/openai-responses/anthropic-messages/google-generative-ai)",
				current?.api ?? "openai-completions",
			)) as any,
			baseUrl: await ask("Base URL", current?.baseUrl ?? ""),
			apiKeyEnvironmentVariable: await ask(
				"API key environment variable name",
				current?.apiKeyEnvironmentVariable ?? "PAPER_AGENT_RELAY_API_KEY",
			),
		};
	} else {
		delete next.model;
	}

	if (await yes("Configure a remote team knowledge service", Boolean(next.team))) {
		next.team = {
			serverUrl: await ask("Team service URL", next.team?.serverUrl ?? ""),
			namespace: await ask("Team namespace", next.team?.namespace ?? next.storage.defaultNamespace),
			tokenEnvironmentVariable: await ask(
				"Team token environment variable name",
				next.team?.tokenEnvironmentVariable ?? "PAPER_AGENT_TEAM_TOKEN",
			),
		};
	} else {
		delete next.team;
	}

	let result = await savePaperAgentConfig(projectRoot, next);
	if (result.config.model && process.env[result.config.model.apiKeyEnvironmentVariable]) {
		if (!supportsAutomaticToolCallingProbe(result.config.model.api)) {
			console.log(
				`Model probe: manual verification required for ${result.config.model.api}; start paper-agent agent and run a real tool-using task.`,
			);
		} else if (await yes("Send one small request to verify structured tool calling", true)) {
			const probe = await probeModelToolCalling(result.config.model);
			result.config.model.toolCallingProbe = probe;
			if (probe.supported) result.config.model.toolCallingVerifiedAt = probe.checkedAt;
			result = await savePaperAgentConfig(projectRoot, result.config);
			console.log(`Model probe: ${probe.supported ? "passed" : "failed"} — ${probe.reason}`);
		}
	}
	console.log(`\nConfiguration saved: ${result.path}`);
	console.log("Next: paper-agent --doctor, then paper-agent");
} finally {
	rl.close();
}
