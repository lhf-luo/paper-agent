import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebAgentService } from "../src/agent/application/web-agent-service.ts";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { loadPaperAgentConfig } from "../src/config/application/config-service.ts";
import paperAgentExtension, { paperSystemPrompt } from "../src/index.ts";
import { setProviderCredentials } from "../src/literature/infrastructure/literature-providers.ts";
import { setProxyBypassHosts, setProxyUrl } from "../src/shared/infrastructure/network-proxy-config.ts";
import { setTeamProjectRoot } from "../src/team/application/team-corpus-client.ts";

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
	// 直连白名单优先从拆分配置的 network.noProxyHosts 读取;
	// 未配置时用推荐的默认值(经测速, 这些域名直连更快/持平)。
	const noProxyHosts = config.network.noProxyHosts?.length
		? config.network.noProxyHosts
		: [
				"export.arxiv.org",
				"arxiv.org",
				"api.openalex.org",
				"openalex.org",
				"api.crossref.org",
				"api.core.ac.uk",
				"api.deepseek.com",
				"127.0.0.1",
				"localhost",
			];
	process.env.NO_PROXY ??= noProxyHosts.join(",");
	setProxyUrl(config.network.proxyUrl);
	setProxyBypassHosts(noProxyHosts);
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
	console.log("HTTP proxy: disabled (split config network.proxyEnabled)");
}
if (config.credentials) {
	setProviderCredentials(config.credentials);
	console.log("Provider credentials: loaded from split config credentials");
}
setTeamProjectRoot(projectRoot);
const application = new PaperAgentApplication({
	projectRoot,
	dataRoot: config.storage.dataRoot,
	corpusRoot: config.storage.corpusRoot,
	defaultNamespace: config.storage.defaultNamespace,
});
await application.initialize();
const personalStore = application.personalStore();
await personalStore.initialize();
const agentService = await createWebAgentService({
	projectRoot,
	extensionFactory: paperAgentExtension,
	systemPrompt: paperSystemPrompt,
	paperSessionDatabasePath: personalStore.databasePath,
});
const handle = await startLocalWebServer(application, {
	host: "127.0.0.1",
	port: Number(option("--port") ?? config.interface.port),
	staticRoot: join(projectRoot, "dist", "web"),
	agentService,
});
const launchPdf = option("--pdf");
const launchUrl = launchPdf
	? `${handle.url}/#${new URLSearchParams({ pdf: resolve(launchPdf) }).toString()}`
	: handle.url;
console.log(`Paper Agent is ready at ${handle.url}`);
console.log("The local API listens only on 127.0.0.1.");
const shouldOpenBrowser = !process.argv.includes("--no-open") && config.interface.openBrowser;
if (shouldOpenBrowser) {
	openBrowser(launchUrl);
} else {
	console.log(`Open this local URL in a browser: ${launchUrl}`);
}

const shutdown = async () => {
	await handle.close();
	await application.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await new Promise(() => undefined);
