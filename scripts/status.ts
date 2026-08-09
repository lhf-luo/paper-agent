import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaperAgentConfig, resolvePaperAgentConfigPath } from "../src/app-config.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadPaperAgentConfig(projectRoot);
const application = new PaperAgentApplication({
	projectRoot,
	dataRoot: config.storage.dataRoot,
	corpusRoot: config.storage.corpusRoot,
	defaultNamespace: config.storage.defaultNamespace,
});

try {
	const status = await application.status();
	const cliRoot =
		process.env.PAPER_AGENT_CLI_BIN ??
		(process.platform === "win32"
			? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "paper-agent", "bin")
			: join(process.env.HOME ?? homedir(), ".local", "bin"));
	const shim = join(cliRoot, process.platform === "win32" ? "paper-agent.cmd" : "paper-agent");
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	const report = {
		...status,
		configPath: resolvePaperAgentConfigPath(projectRoot),
		commandShim: { path: shim, installed: await exists(shim) },
		piCredentialsFile: { path: authPath, present: await exists(authPath) },
		team: config.team
			? {
					configured: true,
					serverUrl: config.team.serverUrl,
					namespace: config.team.namespace,
					credentialsAvailable: Boolean(process.env[config.team.tokenEnvironmentVariable]),
				}
			: { configured: false },
	};

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log("Paper Agent status\n");
		console.log(`Project: ${report.projectRoot}`);
		console.log(`Config: ${report.configPath}`);
		console.log(`Data: ${report.dataRoot}`);
		console.log(`Corpus: ${report.corpusRoot}`);
		console.log(`Personal namespace: ${report.defaultNamespace}`);
		console.log(`Personal namespaces: ${report.personalNamespaces.length}`);
		console.log(`Personal records: ${report.defaultRecordCount}`);
		console.log(`Jobs: ${report.jobs.queued} queued, ${report.jobs.running} running, ${report.jobs.failed} failed`);
		console.log(
			`Command shim: ${report.commandShim.installed ? "installed" : "not installed"} (${report.commandShim.path})`,
		);
		console.log(`Pi credentials file: ${report.piCredentialsFile.present ? "present" : "missing"}`);
		if (report.team.configured) {
			console.log(
				`Team: ${report.team.serverUrl}/${report.team.namespace}; token ${report.team.credentialsAvailable ? "available" : "missing"}`,
			);
		} else {
			console.log("Team: not configured (personal mode remains fully usable)");
		}
	}
} finally {
	await application.close();
}
