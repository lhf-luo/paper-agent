import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalWebServer } from "../src/local-web-server.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function launcherOutput(projectRoot: string, argument: "--help" | "--version" | "--status"): string {
	const command = process.platform === "win32" ? "powershell.exe" : "bash";
	const args =
		process.platform === "win32"
			? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(projectRoot, "paper-agent.ps1"), argument]
			: [join(projectRoot, "run.sh"), argument];
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, PAPER_AGENT_NODE_BIN: process.execPath },
		timeout: 30_000,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`launcher ${argument} failed: ${result.stderr || result.stdout}`);
	return `${result.stdout}\n${result.stderr}`;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		timeout: 60_000,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return `${result.stdout}\n${result.stderr}`;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(launcherOutput(projectRoot, "--help").includes("Paper Agent"), "launcher help did not identify Paper Agent");
assert(
	launcherOutput(projectRoot, "--version").includes("0.1.0"),
	"launcher version did not report the package version",
);
assert(launcherOutput(projectRoot, "--status").includes("Paper Agent status"), "launcher status did not run");

const installRoot = await mkdtemp(join(tmpdir(), "paper-agent-cli-install-"));
try {
	const binRoot = join(installRoot, "bin");
	const env = {
		...process.env,
		PAPER_AGENT_NODE_BIN: process.execPath,
		PAPER_AGENT_CLI_BIN: binRoot,
		PAPER_AGENT_SKIP_PATH_UPDATE: "1",
		PAPER_AGENT_HOME: projectRoot,
	};
	if (process.platform === "win32") {
		const launcher = join(projectRoot, "paper-agent.ps1");
		run(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "install"],
			projectRoot,
			env,
		);
		const installed = join(binRoot, "paper-agent.cmd");
		assert(
			run("cmd.exe", ["/d", "/c", installed, "--version"], projectRoot, env).includes("0.1.0"),
			"installed Windows command did not run",
		);
		run(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "uninstall"],
			projectRoot,
			env,
		);
		await access(installed).then(
			() => {
				throw new Error("Windows uninstall left the command shim behind");
			},
			() => undefined,
		);
	} else {
		const launcher = join(projectRoot, "run.sh");
		run("bash", [launcher, "install"], projectRoot, env);
		const installed = join(binRoot, "paper-agent");
		assert(run(installed, ["--version"], projectRoot, env).includes("0.1.0"), "installed Unix command did not run");
		run("bash", [launcher, "uninstall"], projectRoot, env);
		await access(installed).then(
			() => {
				throw new Error("Unix uninstall left the command shim behind");
			},
			() => undefined,
		);
	}
} finally {
	await rm(installRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const root = await mkdtemp(join(tmpdir(), "paper-agent-cli-smoke-"));
const staticRoot = join(root, "web");
await mkdir(staticRoot, { recursive: true });
await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent smoke</title>", "utf8");
const application = new PaperAgentApplication({ projectRoot, dataRoot: join(root, "data") });
const token = "cli-smoke-session-token";
const server = await startLocalWebServer(application, { staticRoot, sessionToken: token });
try {
	const page = await fetch(server.url);
	assert(page.status === 200 && (await page.text()).includes("Paper Agent smoke"), "local Web root smoke failed");
	const health = await fetch(`${server.url}/health`);
	assert(
		health.status === 200 && ((await health.json()) as { ok?: boolean }).ok === true,
		"local health smoke failed",
	);
	assert(
		(await fetch(`${server.url}/api/status`)).status === 401,
		"local API accepted a request without its session token",
	);
	const status = await fetch(`${server.url}/api/status`, { headers: { authorization: `Bearer ${token}` } });
	assert(status.status === 200, `authenticated local status returned HTTP ${status.status}`);
	console.log(
		JSON.stringify({
			ok: true,
			platform: process.platform,
			launcher: true,
			installLifecycle: true,
			localWeb: true,
			sessionBoundary: true,
		}),
	);
} finally {
	await server.close();
	await application.close();
	await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
