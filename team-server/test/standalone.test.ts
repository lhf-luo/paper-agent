import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamCorpusServer, hashTeamToken } from "../src/presentation/team-corpus-server.ts";
import { encodeTeamInvite } from "../src/protocol/team-access.ts";

const temporaryPaths: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
	for (const child of processes.splice(0)) {
		if (child.exitCode !== null) continue;
		const exited = once(child, "exit");
		child.kill();
		await exited;
	}
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForHealth(origin: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const response = await fetch(`${origin}/health`);
			if (response.ok) return;
		} catch {
			// The copied service may still be starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error("standalone team server did not become healthy");
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("could not allocate a test port");
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	return address.port;
}

async function httpsRequest(
	origin: string,
	path: string,
	ca?: string,
	token?: string,
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: unknown }> {
	return new Promise((resolveRequest, rejectRequest) => {
		const call = request(
			new URL(path, origin),
			{
				ca,
				headers: token ? { authorization: `Bearer ${token}` } : undefined,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolveRequest({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: text ? JSON.parse(text) : undefined,
					});
				});
			},
		);
		call.on("error", rejectRequest);
		call.end();
	});
}

const opensslAvailable = spawnSync("openssl", ["version"], { windowsHide: true }).status === 0;

describe("standalone team server", () => {
	it("encodes the complete one-time access payload", () => {
		const caPem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
		const encoded = encodeTeamInvite({
			serverUrl: "https://203.0.113.10:14713",
			namespace: "lab",
			token: "member-token",
			identity: "alice",
			caPem,
		});
		expect(encoded.startsWith("pateam1.")).toBe(true);
		expect(JSON.parse(Buffer.from(encoded.slice(8), "base64url").toString("utf8"))).toEqual({
			serverUrl: "https://203.0.113.10:14713",
			namespace: "lab",
			token: "member-token",
			identity: "alice",
			caPem,
		});
	});

	it.skipIf(!opensslAvailable)("serves native HTTPS with an IP SAN certificate and pinned CA", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "paper-agent-team-tls-"));
		temporaryPaths.push(temporary);
		const certificatePath = join(temporary, "server.crt");
		const keyPath = join(temporary, "server.key");
		const generated = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				keyPath,
				"-out",
				certificatePath,
			],
			{
				windowsHide: true,
				encoding: "utf8",
				env: { ...process.env, OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null" },
			},
		);
		expect(generated.status, generated.stderr).toBe(0);
		const [cert, key] = await Promise.all([readFile(certificatePath, "utf8"), readFile(keyPath, "utf8")]);
		const server = createTeamCorpusServer({
			root: join(temporary, "data"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
			tls: { cert, key },
		});
		try {
			await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("TLS server did not bind a TCP port");
			const origin = `https://127.0.0.1:${address.port}`;
			const health = await httpsRequest(origin, "/health", cert);
			expect(health).toMatchObject({ status: 200, body: { ok: true, service: "paper-agent-team-corpus" } });
			expect(health.headers["strict-transport-security"]).toBe("max-age=31536000");
			await expect(httpsRequest(origin, "/health")).rejects.toThrow();
			await expect(httpsRequest(origin, "/v1/whoami", cert, "admin-token")).resolves.toMatchObject({
				status: 200,
				body: { identity: { name: "admin", roles: ["admin"] } },
			});
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	});

	it("rejects a public plaintext listener", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "paper-agent-team-plaintext-"));
		temporaryPaths.push(temporary);
		const authPath = join(temporary, "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({
				identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
			}),
		);
		const child = spawn(process.execPath, [resolve(import.meta.dirname, "../src/index.ts")], {
			env: {
				...process.env,
				PAPER_AGENT_TEAM_AUTH_FILE: authPath,
				PAPER_AGENT_TEAM_ROOT: join(temporary, "data"),
				PAPER_AGENT_TEAM_HOST: "0.0.0.0",
				PAPER_AGENT_TEAM_PORT: String(await availablePort()),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		processes.push(child);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const [code] = (await once(child, "exit")) as [number];
		expect(code).not.toBe(0);
		expect(stderr).toContain("Plain HTTP team service may listen only on a loopback address");
	});

	it("does not import source files outside its own directory", async () => {
		const root = resolve(import.meta.dirname, "..");
		const files = async (directory: string): Promise<string[]> => {
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(directory, { withFileTypes: true });
			const nested = await Promise.all(
				entries.map((entry) =>
					entry.isDirectory()
						? files(join(directory, entry.name))
						: Promise.resolve([join(directory, entry.name)]),
				),
			);
			return nested.flat();
		};
		for (const path of await files(join(root, "src"))) {
			const source = await readFile(path, "utf8");
			const imports = [
				...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["'](\.[^"']+)["']/g),
			].map((match) => match[1]);
			for (const specifier of imports) {
				const target = resolve(dirname(path), specifier);
				const pathFromRoot = relative(root, target);
				expect(pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot), `${path} imports ${specifier}`).toBe(
					false,
				);
			}
		}
	});

	it("starts after the directory is copied without the main project", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "paper-agent-team-standalone-"));
		temporaryPaths.push(temporary);
		const source = resolve(import.meta.dirname, "..");
		const project = join(temporary, "team-server");
		await cp(source, project, { recursive: true, filter: (path) => !path.includes("node_modules") });
		const token = randomBytes(20).toString("hex");
		const authPath = join(temporary, "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({ identities: [{ name: "admin", tokenSha256: hashTeamToken(token), roles: ["admin"] }] }),
		);
		const port = await availablePort();
		const child = spawn(process.execPath, [join(project, "src", "index.ts")], {
			cwd: project,
			env: {
				...process.env,
				PAPER_AGENT_TEAM_AUTH_FILE: authPath,
				PAPER_AGENT_TEAM_ROOT: join(temporary, "data"),
				PAPER_AGENT_TEAM_BACKUP_ROOT: join(temporary, "backups"),
				PAPER_AGENT_TEAM_PORT: String(port),
			},
			stdio: "ignore",
		});
		processes.push(child);
		const origin = `http://127.0.0.1:${port}`;
		await waitForHealth(origin);
		const who = await fetch(`${origin}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
		expect(who.status).toBe(200);
		expect(await who.json()).toMatchObject({ identity: { name: "admin", roles: ["admin"] } });
	});
});
