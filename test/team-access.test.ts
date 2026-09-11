import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationConsentManager } from "../src/shared/application/operation-consent.ts";
import { TeamAccessService } from "../src/team/application/team-access-service.ts";
import { decodeTeamInvite, encodeTeamInvite } from "../src/team/domain/team-access.ts";
import { readTeamAccess, saveTeamAccess, teamAccessFile } from "../src/team/infrastructure/team-access-file.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const temporaryPaths: string[] = [];
const servers: Server[] = [];
const opensslAvailable = spawnSync("openssl", ["version"], { windowsHide: true }).status === 0;

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function confirmedExecution(
	service: TeamAccessService,
	consent: OperationConsentManager,
	input: Parameters<TeamAccessService["prepareAccess"]>[0],
) {
	const prepared = await service.prepareAccess(input);
	const grant = await consent.confirm(prepared.operationId, prepared.manifestFingerprint, "test-user");
	return service.execute(grant);
}

async function testServer(root: string): Promise<string> {
	const server = createTeamCorpusServer({
		root: join(root, "team"),
		identities: [{ name: "actual-admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

describe("team access strings", () => {
	it("round-trips the coworker-compatible pateam1 payload", () => {
		const caPem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
		const invite = encodeTeamInvite({
			serverUrl: "https://203.0.113.10:14713",
			namespace: "lab",
			token: "member-token",
			identity: "alice",
			caPem,
		});
		expect(decodeTeamInvite(`\n${invite}\n`)).toEqual({
			serverUrl: "https://203.0.113.10:14713",
			namespace: "lab",
			token: "member-token",
			identity: "alice",
			caPem,
		});
	});

	it("requires a CA certificate in a remote HTTPS access string", () => {
		expect(() =>
			encodeTeamInvite({
				serverUrl: "https://203.0.113.10:14713",
				namespace: "lab",
				token: "member-token",
				identity: "alice",
			}),
		).toThrow("must include its CA certificate");
	});

	it.skipIf(!opensslAvailable)("connects through the CA pinned in an IP HTTPS access string", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-access-tls-"));
		temporaryPaths.push(root);
		const certificatePath = join(root, "server.crt");
		const keyPath = join(root, "server.key");
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
		const [caPem, key] = await Promise.all([readFile(certificatePath, "utf8"), readFile(keyPath, "utf8")]);
		const server = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [{ name: "tls-admin", tokenSha256: hashTeamToken("tls-token"), roles: ["admin"] }],
			tls: { cert: caPem, key },
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("TLS server did not bind a TCP port");
		const consent = new OperationConsentManager();
		const service = new TeamAccessService(root, consent);
		const invite = encodeTeamInvite({
			serverUrl: `https://127.0.0.1:${address.port}`,
			namespace: "lab",
			token: "tls-token",
			identity: "tls-admin",
			caPem,
		});
		await confirmedExecution(service, consent, { action: "connect", invite });
		await expect(service.status()).resolves.toMatchObject({
			connected: true,
			namespace: "lab",
			identity: { name: "tls-admin", roles: ["admin"] },
		});
	});

	it("validates a connection before replacing the existing access file", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-access-preserve-"));
		temporaryPaths.push(root);
		await saveTeamAccess(root, {
			serverUrl: "http://127.0.0.1:1",
			namespace: "old-space",
			token: "old-token",
			identity: "old-user",
		});
		const service = new TeamAccessService(root, new OperationConsentManager());
		const invite = encodeTeamInvite({
			serverUrl: "http://127.0.0.1:2",
			namespace: "new-space",
			token: "new-token",
			identity: "new-user",
		});
		await expect(service.prepareAccess({ action: "connect", invite })).rejects.toThrow();
		expect(readTeamAccess(root)).toMatchObject({ namespace: "old-space", token: "old-token" });
	});

	it("stores the server identity instead of trusting the invite hint", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-access-connect-"));
		temporaryPaths.push(root);
		const serverUrl = await testServer(root);
		const consent = new OperationConsentManager();
		const service = new TeamAccessService(root, consent);
		const invite = encodeTeamInvite({
			serverUrl,
			namespace: "lab",
			token: "admin-token",
			identity: "untrusted-hint",
		});
		await confirmedExecution(service, consent, { action: "connect", invite });
		expect(readTeamAccess(root)).toMatchObject({
			serverUrl,
			namespace: "lab",
			identity: "actual-admin",
		});
	});

	it("can clear a malformed local access file through the confirmed flow", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-access-clear-"));
		temporaryPaths.push(root);
		const path = teamAccessFile(root);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "not-json");
		const consent = new OperationConsentManager();
		const service = new TeamAccessService(root, consent);
		await expect(service.status()).resolves.toMatchObject({
			configured: true,
			connected: false,
			hasLocalAccess: true,
		});
		await confirmedExecution(service, consent, { action: "clear" });
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
