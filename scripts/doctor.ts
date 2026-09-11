import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadPaperAgentConfig,
	pathExists,
	redactPaperAgentConfig,
	resolvePaperAgentConfigPaths,
	supportsAutomaticToolCallingProbe,
} from "../src/config/application/config-service.ts";
import { discoverPiCustomModels, probeModelToolCalling } from "../src/config/application/model-service.ts";
import { resolvePdf2zhCommand } from "../src/extensions/pdf-translation/infrastructure/pdf2zh-next-client.ts";
import { applyExternalToolDirectories } from "../src/shared/infrastructure/external-tool-environment.ts";
import { resolveTeamConnection } from "../src/team/application/team-connection.ts";

interface DiagnosticItem {
	name: string;
	ok: boolean;
	detail: string;
	required: boolean;
}

function commandVersion(
	command: string,
	args: string[],
	options: { name?: string; required?: boolean } = {},
): Promise<DiagnosticItem> {
	return new Promise((resolveItem) => {
		const child = spawn(command, args, { windowsHide: true });
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		const timer = setTimeout(() => child.kill(), 8_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolveItem({
				name: options.name ?? command,
				ok: false,
				detail: `${command}: ${error.message}`,
				required: options.required ?? command !== "tesseract",
			});
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolveItem({
				name: options.name ?? command,
				ok: code === 0 || Boolean(output.trim()),
				detail: `${command}: ${output.trim().split(/\r?\n/)[0]?.slice(0, 240) || `exit ${code}`}`,
				required: options.required ?? command !== "tesseract",
			});
		});
	});
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadPaperAgentConfig(projectRoot);
applyExternalToolDirectories(config.externalTools.commandDirectories);
const customModels = await discoverPiCustomModels();
const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split(".")[0]);
const minor = Number(nodeVersion.split(".")[1]);
const diagnostics: DiagnosticItem[] = [
	{
		name: "Node.js",
		ok: major > 22 || (major === 22 && minor >= 19),
		detail: `${process.version} (${process.execPath})`,
		required: true,
	},
	{
		name: "Dependencies",
		ok: await pathExists(join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")),
		detail: "project-local Pi runtime",
		required: true,
	},
	{
		name: "Web interface",
		ok: await pathExists(join(projectRoot, "dist", "web", "index.html")),
		detail: "dist/web/index.html",
		required: true,
	},
	...(await Promise.all([
		commandVersion("pdftotext", ["-v"]),
		commandVersion("pdftoppm", ["-v"]),
		commandVersion("pdfinfo", ["-v"]),
		commandVersion("pdfimages", ["-v"]),
		commandVersion("tesseract", ["--version"]),
		commandVersion(resolvePdf2zhCommand(config.pdfTranslation.command), ["--version"], {
			name: "PDF2zh Next",
			required: false,
		}),
	])),
];

const authPath = join(homedir(), ".pi", "agent", "auth.json");
let authProviders: string[] = [];
try {
	const auth = JSON.parse(await (await import("node:fs/promises")).readFile(authPath, "utf8")) as Record<
		string,
		unknown
	>;
	authProviders = Object.keys(auth);
} catch {
	// A missing auth file is reported below without exposing its contents.
}
const modelKeyReady = Boolean(
	config.model &&
		(config.model.apiKey ??
			(config.model.apiKeyEnvironmentVariable ? process.env[config.model.apiKeyEnvironmentVariable] : undefined)),
);
const teamConnection = resolveTeamConnection(projectRoot);
const automaticProbeSupported = Boolean(config.model && supportsAutomaticToolCallingProbe(config.model.api));
let probe = config.model?.toolCallingProbe;
if (process.argv.includes("--probe-model") && config.model) {
	probe = await probeModelToolCalling(config.model);
	config.model.toolCallingProbe = probe;
}

const report = {
	ok: diagnostics.every((item) => item.ok || !item.required),
	projectRoot,
	configPath: resolvePaperAgentConfigPaths(projectRoot).directory,
	config: redactPaperAgentConfig(config),
	diagnostics,
	model: {
		configured: Boolean(config.model),
		credentialsAvailable: modelKeyReady,
		piAuthenticatedProviders: authProviders,
		piCustomModels: customModels.map((model) => `${model.providerId}/${model.modelId}`),
		automaticProbeSupported,
		probe,
	},
	team: {
		configured: Boolean(teamConnection),
		serverUrl: teamConnection?.serverUrl,
		namespace: teamConnection?.namespace,
		identity: teamConnection?.identity,
		source: teamConnection?.source,
	},
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log("Paper Agent doctor\n");
	for (const item of diagnostics) {
		console.log(`${item.ok ? "[OK]" : item.required ? "[FAIL]" : "[OPTIONAL]"} ${item.name}: ${item.detail}`);
	}
	console.log(`\nConfig: ${report.configPath}`);
	console.log(`Personal namespace: ${config.storage.defaultNamespace}`);
	console.log(
		config.model
			? `Model: ${config.model.providerId}/${config.model.modelId}; key ${modelKeyReady ? "available" : "missing"}`
			: authProviders.length || customModels.length
				? "Model: Pi provider configuration detected; run paper-agent agent and /model to select it"
				: "Model: not configured; run paper-agent init or paper-agent agent and /login",
	);
	if (probe) {
		console.log(
			`Tool calling probe: ${probe.supported ? "passed" : automaticProbeSupported ? "failed" : "manual verification required"} — ${probe.reason}`,
		);
	}
	console.log(
		teamConnection
			? `Team: ${teamConnection.serverUrl}/${teamConnection.namespace}; access file available`
			: "Team: not configured (paste a pateam1. access string in Settings)",
	);
	if (!report.ok) process.exitCode = 1;
}
