import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaperAgentConfig } from "../src/app-config.ts";
import { setProviderCredentials } from "../src/literature-providers.ts";
import { setProxyUrl } from "../src/network-security.ts";
import { setTeamConnection } from "../src/team-corpus-client.ts";
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

function lanAddress(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const entry of addresses ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return undefined;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const config = await loadPaperAgentConfig(projectRoot);
if (config.network?.proxyEnabled && config.network.proxyUrl) {
	setProxyUrl(config.network.proxyUrl);
	console.log(`HTTP proxy enabled: ${config.network.proxyUrl}`);
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
const host = option("--host") ?? config.interface.host ?? "127.0.0.1";
const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
const handle = await startLocalWebServer(application, {
	host,
	port: Number(option("--port") ?? config.interface.port),
	staticRoot: join(projectRoot, "dist", "web"),
	sessionToken,
	agentService,
	allowNonLoopback: !isLoopback,
});
const launchParameters = new URLSearchParams({ token: sessionToken });
const launchPdf = option("--pdf");
if (launchPdf) launchParameters.set("pdf", resolve(launchPdf));
const launchHost = isLoopback || host === "0.0.0.0" || host === "::" ? lanAddress() ?? host : host;
const launchUrl = `http://${launchHost}:${handle.port}/#${launchParameters.toString()}`;
console.log(`Paper Agent is ready at http://${host}:${handle.port}`);
if (!isLoopback) {
	console.warn("⚠️  服务已绑定到非本机地址。任何拿到会话 URL 的人都能访问你的个人库、配置与写操作。仅限可信局域网使用，并保管好 URL。");
	console.log(`LAN session URL: ${launchUrl}`);
} else {
	console.log("The local API is protected by an ephemeral session token and listens only on 127.0.0.1.");
}
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
