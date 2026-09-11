import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Marker written by the running team service into its data root. Offline tooling (`restore.ts`) refuses to
 * touch the data root while the process named here is alive, because the service keeps an in-memory record
 * index and would otherwise serve stale data over a freshly restored tree.
 */
export const SERVER_PID_FILE = ".team-server.pid";

export interface ServerPidRecord {
	pid: number;
	startedAt: string;
	host: string;
	port: number;
}

export function serverPidPath(dataRoot: string): string {
	return join(dataRoot, SERVER_PID_FILE);
}

export async function writeServerPidFile(dataRoot: string, record: ServerPidRecord): Promise<void> {
	await mkdir(dataRoot, { recursive: true });
	await writeFile(serverPidPath(dataRoot), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function parsePid(raw: string): number | undefined {
	try {
		const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
		return Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : undefined;
	} catch {
		return undefined;
	}
}

/** Remove the marker only if it still names this process, so a failed second instance never deletes the live one. */
export async function removeServerPidFile(dataRoot: string, pid = process.pid): Promise<void> {
	const path = serverPidPath(dataRoot);
	try {
		if (parsePid(await readFile(path, "utf8")) !== pid) return;
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Synchronous variant for `process.on("exit")`, where no further event-loop turns are available. */
export function removeServerPidFileSync(dataRoot: string, pid = process.pid): void {
	const path = serverPidPath(dataRoot);
	try {
		if (parsePid(readFileSync(path, "utf8")) !== pid) return;
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user; anything else means it is gone.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid of a live team service on this data root, or undefined when the marker is absent or stale. */
export async function runningServerPid(dataRoot: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await readFile(serverPidPath(dataRoot), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const pid = parsePid(raw);
	return pid !== undefined && processAlive(pid) ? pid : undefined;
}
