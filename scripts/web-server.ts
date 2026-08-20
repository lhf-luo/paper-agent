import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaperAgentConfig } from "../src/app-config.ts";
import { setProviderCredentials } from "../src/literature-providers.ts";
import { setProxyUrl } from "../src/network-security.ts";
import { setTeamConnection } from "../src/tools/team-corpus-client.ts";
import { startLocalWebServer } from "../src/local-web-server.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";
import { createWebAgentService } from "../src/web-agent-service.ts";

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function openBrowser(url: string): void {
	const command =
		process.platform === "win32"
			? { file: "cmd.exe", args: ["/c", "start", "", url] }
			: process.platform === "darwin"
				? { file: "open", args: [url] }
				: { file: "xdg-open", args: [url] };
	const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const config = await loadPaperAgentConfig(projectRoot);
if (config.network?.proxyEnabled && config.network.proxyUrl) {
	process.env.HTTP_PROXY ??= config.network.proxyUrl;
	process.env.HTTPS_PROXY ??= config.network.proxyUrl;
	// 以下域名在中国网络可直连且更稳定, 走 NO_PROXY 豁免代理(保持直连)
	process.env.NO_PROXY ??= [
		"export.arxiv.org",
		"arxiv.org",
		"api.openalex.org",
		"api.deepseek.com",
		"127.0.0.1",
		"localhost",
	].join(",");
	setProxyUrl(config.network.proxyUrl);
	try {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
		setGlobalDispatcher(new EnvHttpProxyAgent());
		console.log(
			`HTTP proxy enabled (Node fetch + python): ${config.network.proxyUrl}; direct: ${process.env.NO_PROXY}`,
		);
	} catch {
		console.log(`HTTP proxy enabled (python only): ${config.network.proxyUrl}`);
	}
} else {
	console.log("HTTP proxy: disabled (config.json network.proxyEnabled)");
}
if (config.credentials) {
	setProviderCredentials(config.credentials);
	console.log("Provider credentials: loaded from config.json credentials");
}
if (config.team?.serverUrl && (config.team.token || process.env[config.team.tokenEnvironmentVariable])) {
	setTeamConnection({
		baseUrl: config.team.serverUrl,
		token: config.team.token ?? process.env[config.team.tokenEnvironmentVariable] ?? "",
	});
	console.log(`Team connection: ${config.team.serverUrl}/${config.team.namespace}`);
}
const sessionToken = randomBytes(32).toString("base64url");
const application = new PaperAgentApplication({
	projectRoot,
	dataRoot: config.storage.dataRoot,
	corpusRoot: config.storage.corpusRoot,
	defaultNamespace: config.storage.defaultNamespace,
});
const agentService = await createWebAgentService({ projectRoot });
const handle = await startLocalWebServer(application, {
	host: "127.0.0.1",
	port: Number(option("--port") ?? config.interface.port),
	staticRoot: join(projectRoot, "dist", "web"),
	sessionToken,
	agentService,
});
const launchParameters = new URLSearchParams({ token: sessionToken });
const launchPdf = option("--pdf");
if (launchPdf) launchParameters.set("pdf", resolve(launchPdf));
const launchUrl = `${handle.url}/#${launchParameters.toString()}`;
console.log(`Paper Agent is ready at ${handle.url}`);
console.log("The local API is protected by an ephemeral session token and listens only on 127.0.0.1.");
const shouldOpenBrowser = !process.argv.includes("--no-open") && config.interface.openBrowser;
if (shouldOpenBrowser) {
	openBrowser(launchUrl);
} else {
	console.log(`Open this session URL in a browser: ${launchUrl}`);
}

const shutdown = async () => {
	await handle.close();
	await application.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await new Promise(() => undefined);
