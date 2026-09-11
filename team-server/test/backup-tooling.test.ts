import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_PID_FILE } from "../src/infrastructure/server-pid-file.ts";
import { createTeamBackupBundle } from "../src/infrastructure/team-backup.ts";
import { backupTimestamp, pruneTeamBackups } from "../src/prune-backups.ts";
import { restoreTeamBackup } from "../src/restore.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Build one valid bundle whose payload a restore can be verified against. */
async function buildBundle(input: { root: string; namespace: string }) {
	const namespaceRoot = join(input.root, "corpus", input.namespace);
	await mkdir(join(namespaceRoot, "records"), { recursive: true });
	await writeFile(
		join(namespaceRoot, "records", "paper-one.json"),
		`${JSON.stringify({ id: "paper-one", title: "Backup Fixture" }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(namespaceRoot, "manifest.json"),
		`${JSON.stringify({ schemaVersion: 1, scope: "team", namespace: input.namespace })}\n`,
		"utf8",
	);
	const destinationRoot = join(input.root, "backups");
	const bundle = await createTeamBackupBundle({
		namespaceRoot,
		namespace: input.namespace,
		destinationRoot,
		security: {
			registry: {
				schemaVersion: 2,
				updatedAt: "2026-01-01T00:00:00.000Z",
				identities: [
					{
						id: "u-backupfixture",
						name: "admin",
						tokenSha256: "a".repeat(64),
						roles: ["admin"],
						namespaces: [],
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
			},
			auditJsonl: `${JSON.stringify({ action: "backup.create" })}\n`,
		},
	});
	return { namespaceRoot, destinationRoot, bundle };
}

describe("team backup tooling", () => {
	it("parses bundle timestamps and ignores unrelated directory names", () => {
		expect(backupTimestamp("team-lab-20260102030405-abcd1234")).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
		expect(backupTimestamp("team-lab-not-a-timestamp-abcd1234")).toBeUndefined();
		expect(backupTimestamp("unrelated")).toBeUndefined();
	});

	it("prunes only the surplus bundles and leaves invalid directories untouched with a warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-prune-"));
		temporaryPaths.push(root);
		const { destinationRoot, bundle } = await buildBundle({ root, namespace: "lab" });
		const names = [
			"team-lab-20240401000000-aaaaaaaa",
			"team-lab-20240301000000-bbbbbbbb",
			"team-lab-20230201000000-cccccccc",
		];
		for (const name of names) await cp(bundle.backupPath, join(destinationRoot, name), { recursive: true });
		// Drop the auto-named bundle so only the controlled fixtures remain.
		await rm(bundle.backupPath, { recursive: true, force: true });
		// An oldest directory that looks like a bundle but is not one must only be warned about.
		await mkdir(join(destinationRoot, "team-lab-20230101000000-dddddddd"), { recursive: true });
		await writeFile(join(destinationRoot, "team-lab-20230101000000-dddddddd", "stray.txt"), "not a bundle", "utf8");
		// Unrelated directories are never touched.
		await mkdir(join(destinationRoot, "notes"), { recursive: true });

		const result = await pruneTeamBackups(destinationRoot, 2);
		expect(result.kept).toEqual(["team-lab-20240301000000-bbbbbbbb", "team-lab-20240401000000-aaaaaaaa"]);
		expect(result.removed).toEqual(["team-lab-20230201000000-cccccccc"]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.name).toBe("team-lab-20230101000000-dddddddd");
		expect(await pathExists(join(destinationRoot, "team-lab-20230101000000-dddddddd"))).toBe(true);
		expect(await pathExists(join(destinationRoot, "notes"))).toBe(true);
		await expect(pruneTeamBackups(destinationRoot, 0)).rejects.toThrow(/--keep/);
	});

	it("restores a bundle, refuses to clobber without --force, and refuses while a write lock exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-restore-"));
		temporaryPaths.push(root);
		const { bundle } = await buildBundle({ root, namespace: "lab" });
		const dataRoot = join(root, "data");

		const restored = await restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot });
		expect(restored).toMatchObject({ namespace: "lab", identitiesRestored: false });
		expect(JSON.parse(await readFile(join(restored.targetRoot, "records", "paper-one.json"), "utf8"))).toMatchObject({
			id: "paper-one",
		});

		// A second restore without --force must be rejected.
		await expect(restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot })).rejects.toThrow(/--force/);

		// With --force the previous tree is preserved as .replaced-<timestamp>.
		const forced = await restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot, force: true });
		expect(forced.replacedRoot).toMatch(/lab\.replaced-\d{14}$/);
		expect(await pathExists(forced.replacedRoot!)).toBe(true);
		expect(await pathExists(join(forced.targetRoot, "manifest.json"))).toBe(true);

		// A live write lock means the service is running: refuse before touching anything.
		await writeFile(join(forced.targetRoot, ".write.lock"), "{}", "utf8");
		await expect(restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot })).rejects.toThrow(/write\.lock/);
		await rm(join(forced.targetRoot, ".write.lock"), { force: true });

		// The service's pid marker is the primary liveness signal: a live pid refuses, a stale one is ignored.
		await writeFile(join(dataRoot, SERVER_PID_FILE), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
		await expect(restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot, force: true })).rejects.toThrow(
			/still running/,
		);
		const exited = spawnSync(process.execPath, ["-e", "0"]);
		await writeFile(join(dataRoot, SERVER_PID_FILE), `${JSON.stringify({ pid: exited.pid })}\n`, "utf8");
		await expect(
			restoreTeamBackup({ backupPath: bundle.backupPath, dataRoot, force: true }),
		).resolves.toMatchObject({ namespace: "lab" });
		await rm(join(dataRoot, SERVER_PID_FILE), { force: true });

		// Identity restoration is opt-in and follows the same replace rules.
		const withIdentities = await restoreTeamBackup({
			backupPath: bundle.backupPath,
			dataRoot,
			withIdentities: true,
			force: true,
		});
		expect(withIdentities.identitiesRestored).toBe(true);
		expect(JSON.parse(await readFile(join(dataRoot, "_security", "identities.json"), "utf8"))).toMatchObject({
			schemaVersion: 2,
		});
		const securityEntries = await readdir(join(dataRoot, "_security"));
		expect(securityEntries.some((name) => /identities\.json\.replaced-\d{14}$/.test(name))).toBe(false);
	});
});
