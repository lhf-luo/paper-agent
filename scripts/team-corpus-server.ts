import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTeamCorpusServer, type TeamIdentity } from "../src/team-corpus-server.ts";

const authFile = process.env.PAPER_AGENT_TEAM_AUTH_FILE;
if (!authFile) throw new Error("PAPER_AGENT_TEAM_AUTH_FILE is required");
const parsed = JSON.parse(await readFile(resolve(authFile), "utf8")) as { identities?: TeamIdentity[] };
if (!Array.isArray(parsed.identities) || parsed.identities.length === 0) {
	throw new Error("Auth file must contain identities[]");
}
const host = process.env.PAPER_AGENT_TEAM_HOST ?? "127.0.0.1";
const port = Number(process.env.PAPER_AGENT_TEAM_PORT ?? 4317);
const server = createTeamCorpusServer({
	root: resolve(process.env.PAPER_AGENT_TEAM_ROOT ?? ".paper-agent/team-server"),
	backupRoot: process.env.PAPER_AGENT_TEAM_BACKUP_ROOT ? resolve(process.env.PAPER_AGENT_TEAM_BACKUP_ROOT) : undefined,
	identityStorePath: process.env.PAPER_AGENT_TEAM_IDENTITY_STORE
		? resolve(process.env.PAPER_AGENT_TEAM_IDENTITY_STORE)
		: undefined,
	identities: parsed.identities,
	maxBodyBytes: Number(process.env.PAPER_AGENT_TEAM_MAX_BODY_BYTES ?? 8 * 1024 * 1024),
	maxBlobBytes: Number(process.env.PAPER_AGENT_TEAM_MAX_BLOB_BYTES ?? 200 * 1024 * 1024),
});
server.listen(port, host, () => {
	console.log(`paper-agent team corpus listening on http://${host}:${port}`);
});

server.on("error", (error) => {
	console.error("paper-agent team corpus failed", error);
	process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`paper-agent team corpus received ${signal}; waiting for active requests to finish`);
	server.close((error) => {
		if (error) {
			console.error("paper-agent team corpus shutdown failed", error);
			process.exitCode = 1;
		}
	});
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
