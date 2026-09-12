import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readJson, removeTeamFile, writeJsonAtomic } from "../src/infrastructure/team-knowledge-serialization.ts";
import { recoverTeamWrites, runTeamWrite, stageTeamAuditEvent } from "../src/infrastructure/team-write-journal.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-team-journal-"));
	roots.push(root);
	await writeJsonAtomic(join(root, "records", "a.json"), { value: "original" });
	return root;
}
const event = {
	id: "event-journal-fixture",
	at: "2026-09-12T00:00:00.000Z",
	actor: "fixture",
	actorId: "u-fixture",
	action: "fixture.write",
};

describe("team write recovery", () => {
	it("restores replaced and removed files and discards new files on an operation failure", async () => {
		const root = await fixture();
		await writeJsonAtomic(join(root, "records", "removed.json"), { keep: true });
		await expect(
			runTeamWrite(root, async () => {
				await writeJsonAtomic(join(root, "records", "a.json"), { value: "changed" });
				await removeTeamFile(join(root, "records", "removed.json"));
				await writeJsonAtomic(join(root, "records", "new.json"), { transient: true });
				await stageTeamAuditEvent(root, event);
				throw new Error("simulated failure");
			}),
		).rejects.toThrow("simulated failure");
		expect(await readJson(join(root, "records", "a.json"))).toEqual({ value: "original" });
		expect(await readJson(join(root, "records", "removed.json"))).toEqual({ keep: true });
		expect(await readJson(join(root, "records", "new.json"))).toBeUndefined();
		expect(await readdir(join(root, ".transactions"))).toEqual([]);
		expect(await readFile(join(root, "events", "audit.jsonl"), "utf8").catch(() => "")).toBe("");
	});
	it("recovers an uncommitted write left by a terminated native Node process", async () => {
		const root = await fixture();
		const journalModule = pathToFileURL(
			resolve(import.meta.dirname, "../src/infrastructure/team-write-journal.ts"),
		).href;
		const storageModule = pathToFileURL(
			resolve(import.meta.dirname, "../src/infrastructure/team-knowledge-serialization.ts"),
		).href;
		const script = `import { runTeamWrite, stageTeamAuditEvent } from ${JSON.stringify(journalModule)};
import { writeJsonAtomic } from ${JSON.stringify(storageModule)};
import { join } from 'node:path';
const root = process.argv[1];
await runTeamWrite(root, async () => {
  await writeJsonAtomic(join(root, 'records', 'a.json'), { value: 'uncommitted' });
  await writeJsonAtomic(join(root, 'records', 'new.json'), { transient: true });
  await stageTeamAuditEvent(root, ${JSON.stringify(event)});
  process.exit(23);
});`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(child.stderr).toBe("");
		expect(child.status).toBe(23);
		expect(await readJson(join(root, "records", "a.json"))).toEqual({ value: "uncommitted" });
		await recoverTeamWrites(root);
		expect(await readJson(join(root, "records", "a.json"))).toEqual({ value: "original" });
		expect(await readJson(join(root, "records", "new.json"))).toBeUndefined();
		expect(await readdir(join(root, ".transactions"))).toEqual([]);
	});
	it("retains committed data and delivers a failed audit append exactly once on recovery", async () => {
		const root = await fixture();
		// A file at the audit directory path simulates an unavailable audit destination.
		await writeFile(join(root, "events"), "temporarily unavailable");
		await expect(
			runTeamWrite(root, async () => {
				await writeJsonAtomic(join(root, "records", "a.json"), { value: "committed" });
				await stageTeamAuditEvent(root, event);
			}),
		).rejects.toThrow();
		expect(await readJson(join(root, "records", "a.json"))).toEqual({ value: "committed" });
		expect(await readdir(join(root, ".transactions"))).toHaveLength(1);
		await unlink(join(root, "events"));
		await mkdir(join(root, "events"));
		await recoverTeamWrites(root);
		await recoverTeamWrites(root);
		const lines = (await readFile(join(root, "events", "audit.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual([event]);
		expect(await readJson(join(root, "records", "a.json"))).toEqual({ value: "committed" });
	});
});
