/** Isolated browser acceptance environment. Never reads or updates the user's actual corpus. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer, type LocalWebServerHandle } from "../src/app/presentation/local-web-server.ts";
import { saveTeamAccess } from "../src/team/infrastructure/team-access-file.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

process.env.PAPER_AGENT_TEAM_ACCESS_LOG = "off";
const root = await mkdtemp(join(tmpdir(), "paper-agent-team-ui-"));
const team = createTeamCorpusServer({
	root: join(root, "team"),
	backupRoot: join(root, "backups"),
	identities: [
		{
			name: "contributor",
			tokenSha256: hashTeamToken("isolated-ui-contributor"),
			roles: ["reader", "contributor"],
			namespaces: ["lab"],
		},
		{
			name: "reviewer",
			tokenSha256: hashTeamToken("isolated-ui-reviewer"),
			roles: ["reader", "reviewer"],
			namespaces: ["lab"],
		},
		{ name: "reader", tokenSha256: hashTeamToken("isolated-ui-reader"), roles: ["reader"], namespaces: ["lab"] },
		{ name: "admin", tokenSha256: hashTeamToken("isolated-ui-admin"), roles: ["admin"] },
	],
});
await new Promise<void>((ready) => team.listen(0, "127.0.0.1", ready));
const address = team.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind");
const serverUrl = `http://127.0.0.1:${address.port}`;
const apps: PaperAgentApplication[] = [];
const handles: LocalWebServerHandle[] = [];
const urls: Record<string, string> = {};
for (const identity of ["contributor", "reviewer", "reader", "admin"]) {
	const projectRoot = join(root, identity);
	await saveTeamAccess(projectRoot, { serverUrl, namespace: "lab", token: `isolated-ui-${identity}`, identity });
	const app = new PaperAgentApplication({ projectRoot, dataRoot: join(projectRoot, ".paper-agent") });
	apps.push(app);
	if (identity === "contributor") {
		const notes = join(projectRoot, ".paper-agent", "notes", "default");
		await mkdir(notes, { recursive: true });
		await writeFile(
			join(notes, "team-acceptance.md"),
			"# 团队验收笔记\n\n这是一份用于浏览器验证的合成笔记。\n\n## 关键结果\n\n审核者应该能看到本段正文。\n\n| 项目 | 结果 |\n| --- | --- |\n| 版本保护 | 待验证 |\n",
			"utf8",
		);
		await app.syncResearchNotes();
		await app.personalStore().upsertPaper({
			id: "paper-ui-fixture",
			title: "团队共享验收论文",
			authors: ["测试作者"],
			identifiers: {},
			links: [{ url: "https://example.org/paper.pdf", kind: "pdf" }],
			provenance: [{ provider: "local-pdf", query: "isolated-ui-fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		});
	}
	const handle = await startLocalWebServer(app, { staticRoot: resolve("dist/web"), port: 0 });
	handles.push(handle);
	urls[identity] = `${handle.url}/?page=team`;
}
console.log(JSON.stringify({ isolated: true, urls }));
console.log("Send stop to close the fixture and remove its temporary data.");
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	for (const handle of handles) await handle.close();
	for (const app of apps) await app.close();
	await new Promise<void>((done) => team.close(() => done()));
	const target = resolve(root);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("paper-agent-team-ui-"))
		throw new Error("Unexpected fixture cleanup target");
	await rm(target, { recursive: true, force: true });
	process.exit(0);
}
const input = createInterface({ input: process.stdin });
input.once("close", () => {
	void close();
});
input.on("line", (line) => {
	if (line.trim() === "stop") void close();
});
process.once("SIGINT", () => {
	void close();
});
process.once("SIGTERM", () => {
	void close();
});
