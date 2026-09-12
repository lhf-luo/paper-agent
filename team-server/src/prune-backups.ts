import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTeamBackupBundle } from "./infrastructure/team-backup.ts";

export interface PruneBackupResult {
	kept: string[];
	removed: string[];
	skipped: Array<{ name: string; reason: string }>;
}

const BACKUP_DIRECTORY = /^team-(.+)-(\d{14})-([A-Za-z0-9]{8})$/;

/** Parse the `team-<namespace>-<yyyymmddHHMMSS>-<id>` directory name into a sortable epoch value. */
export function backupTimestamp(name: string): number | undefined {
	const match = BACKUP_DIRECTORY.exec(name);
	if (!match) return undefined;
	const value = match[2];
	const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
	const time = Date.parse(iso);
	return Number.isFinite(time) ? time : undefined;
}

/**
 * Keep the `keep` newest `team-*` bundles under `backupRoot` and delete older ones. A candidate is only
 * deleted after `validateTeamBackupBundle` confirms it is a genuine bundle; anything that fails validation
 * is reported and left untouched so an operator can inspect it.
 */
export async function pruneTeamBackups(backupRoot: string, keep: number): Promise<PruneBackupResult> {
	if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive integer");
	const root = resolve(backupRoot);
	const candidates: Array<{ name: string; path: string; time: number }> = [];
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || !entry.name.startsWith("team-")) continue;
		const time = backupTimestamp(entry.name);
		if (time === undefined) continue;
		candidates.push({ name: entry.name, path: join(root, entry.name), time });
	}
	candidates.sort((left, right) => right.time - left.time || left.name.localeCompare(right.name));
	const kept: string[] = [];
	const removed: string[] = [];
	const skipped: PruneBackupResult["skipped"] = [];
	for (const [position, candidate] of candidates.entries()) {
		if (position < keep) {
			kept.push(candidate.name);
			continue;
		}
		try {
			await validateTeamBackupBundle(candidate.path);
		} catch (error) {
			skipped.push({
				name: candidate.name,
				reason: `not a valid backup bundle: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		await rm(candidate.path, { recursive: true, force: true });
		removed.push(candidate.name);
	}
	return { kept: kept.sort(), removed: removed.sort(), skipped };
}

function argument(name: string): string | undefined {
	const exact = process.argv.indexOf(`--${name}`);
	if (exact >= 0) return process.argv[exact + 1];
	return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
	const root = argument("root");
	const keep = Number(argument("keep"));
	if (!root) throw new Error("--root <backupRoot> is required");
	if (!Number.isInteger(keep)) throw new Error("--keep <N> must be an integer");
	const result = await pruneTeamBackups(root, keep);
	console.log(JSON.stringify(result, null, 2));
}
