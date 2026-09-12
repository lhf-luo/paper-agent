import { cp, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runningServerPid } from "./infrastructure/server-pid-file.ts";
import { validateTeamBackupBundle } from "./infrastructure/team-backup.ts";

export interface RestoreOptions {
	backupPath: string;
	dataRoot: string;
	withIdentities?: boolean;
	force?: boolean;
}

export interface RestoreResult {
	namespace: string;
	targetRoot: string;
	replacedRoot?: string;
	identitiesRestored: boolean;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function replacementStamp(): string {
	return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

/** `.replaced-<timestamp>` collides when two restores land in the same second, so miss the second and hint. */
async function replacementPath(base: string): Promise<string> {
	const stamp = replacementStamp();
	let candidate = `${base}.replaced-${stamp}`;
	for (let index = 1; await pathExists(candidate); index++) candidate = `${base}.replaced-${stamp}-${index}`;
	return candidate;
}

/**
 * Rename that tolerates the transient EPERM/EBUSY Windows returns when another process still holds a handle
 * on a directory that was just written (indexer, virus scanner, editor).
 */
async function renameWithRetry(source: string, target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(source, target);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY")) throw error;
			await delay(50);
		}
	}
}

/**
 * Restore a validated bundle into a live data root.
 *
 * Refuses to run while the team service is alive on this data root (detected through the pid marker the
 * service writes on startup) or while `{root}/{namespace}/.write.lock` exists, so an operator must stop the
 * team service first. Existing targets are only replaced when `force` is set, and are preserved as
 * `<name>.replaced-<timestamp>` rather than deleted.
 */
export async function restoreTeamBackup(options: RestoreOptions): Promise<RestoreResult> {
	const bundleRoot = resolve(options.backupPath);
	const manifest = await validateTeamBackupBundle(bundleRoot);
	const dataRoot = resolve(options.dataRoot);
	const targetRoot = join(dataRoot, manifest.namespace);
	const livePid = await runningServerPid(dataRoot);
	if (livePid !== undefined) {
		throw new Error(
			`Refusing to restore: the team service (pid ${livePid}) is still running on ${dataRoot}. Stop it before restoring.`,
		);
	}
	if (await pathExists(join(targetRoot, ".write.lock"))) {
		throw new Error(
			`Refusing to restore: ${join(targetRoot, ".write.lock")} exists. Stop the team service before restoring.`,
		);
	}
	const identityTarget = join(dataRoot, "_security", "identities.json");
	const hasTarget = await pathExists(targetRoot);
	const hasIdentities = options.withIdentities ? await pathExists(identityTarget) : false;
	if (!options.force) {
		if (hasTarget) throw new Error(`Refusing to overwrite ${targetRoot}; pass --force to replace it`);
		if (hasIdentities) throw new Error(`Refusing to overwrite ${identityTarget}; pass --force to replace it`);
	}

	let replacedRoot: string | undefined;
	if (hasTarget) {
		replacedRoot = await replacementPath(targetRoot);
		await renameWithRetry(targetRoot, replacedRoot);
	}
	await mkdir(dirname(targetRoot), { recursive: true });
	await cp(join(bundleRoot, "namespace"), targetRoot, { recursive: true });

	let identitiesRestored = false;
	if (options.withIdentities) {
		if (hasIdentities) await renameWithRetry(identityTarget, await replacementPath(identityTarget));
		await mkdir(dirname(identityTarget), { recursive: true });
		await cp(join(bundleRoot, "_security", "identities.json"), identityTarget);
		identitiesRestored = true;
	}
	return { namespace: manifest.namespace, targetRoot, replacedRoot, identitiesRestored };
}

function argument(name: string): string | undefined {
	const exact = process.argv.indexOf(`--${name}`);
	if (exact >= 0) return process.argv[exact + 1];
	return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
	const backupPath = argument("backup");
	const dataRoot = argument("root");
	if (!backupPath) throw new Error("--backup <bundlePath> is required");
	if (!dataRoot) throw new Error("--root <dataRoot> is required");
	const result = await restoreTeamBackup({
		backupPath,
		dataRoot,
		withIdentities: process.argv.includes("--with-identities"),
		force: process.argv.includes("--force"),
	});
	console.log(JSON.stringify(result, null, 2));
}
