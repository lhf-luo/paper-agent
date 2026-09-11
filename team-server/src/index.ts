import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TeamIdentitySeed } from "./domain/team-identity.ts";
import { createTeamCorpusServer } from "./presentation/team-corpus-server.ts";

const authFile = process.env.PAPER_AGENT_TEAM_AUTH_FILE;
if (!authFile) throw new Error("PAPER_AGENT_TEAM_AUTH_FILE is required");

const parsed = JSON.parse(await readFile(resolve(authFile), "utf8")) as { identities?: TeamIdentitySeed[] };
if (!Array.isArray(parsed.identities) || parsed.identities.length === 0) {
	throw new Error("Auth file must contain identities[]");
}

const certificateFile = process.env.PAPER_AGENT_TEAM_TLS_CERT_FILE;
const privateKeyFile = process.env.PAPER_AGENT_TEAM_TLS_KEY_FILE;
if (Boolean(certificateFile) !== Boolean(privateKeyFile)) {
	throw new Error("PAPER_AGENT_TEAM_TLS_CERT_FILE and PAPER_AGENT_TEAM_TLS_KEY_FILE must be configured together");
}
const tls =
	certificateFile && privateKeyFile
		? {
				cert: await readFile(resolve(certificateFile)),
				key: await readFile(resolve(privateKeyFile)),
			}
		: undefined;
const host = process.env.PAPER_AGENT_TEAM_HOST ?? (tls ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PAPER_AGENT_TEAM_PORT ?? 14713);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PAPER_AGENT_TEAM_PORT is invalid");
if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase())) {
	throw new Error("Plain HTTP team service may listen only on a loopback address; configure TLS for remote access");
}

const server = createTeamCorpusServer({
	root: resolve(process.env.PAPER_AGENT_TEAM_ROOT ?? ".paper-agent/team-server"),
	backupRoot: process.env.PAPER_AGENT_TEAM_BACKUP_ROOT ? resolve(process.env.PAPER_AGENT_TEAM_BACKUP_ROOT) : undefined,
	identityStorePath: process.env.PAPER_AGENT_TEAM_IDENTITY_STORE
		? resolve(process.env.PAPER_AGENT_TEAM_IDENTITY_STORE)
		: undefined,
	identities: parsed.identities,
	maxBodyBytes: Number(process.env.PAPER_AGENT_TEAM_MAX_BODY_BYTES ?? 8 * 1024 * 1024),
	maxBlobBytes: Number(process.env.PAPER_AGENT_TEAM_MAX_BLOB_BYTES ?? 200 * 1024 * 1024),
	tls,
});

server.listen(port, host, () => {
	console.log(`paper-agent team server listening on ${tls ? "https" : "http"}://${host}:${port}`);
});

server.on("error", (error) => {
	console.error("paper-agent team server failed", error);
	process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`paper-agent team server received ${signal}; waiting for active requests to finish`);
	server.close((error) => {
		if (error) {
			console.error("paper-agent team server shutdown failed", error);
			process.exitCode = 1;
		}
	});
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
