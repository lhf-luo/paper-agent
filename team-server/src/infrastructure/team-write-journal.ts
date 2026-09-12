import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TeamAuditEvent } from "../protocol/team-corpus-types.ts";
import { renameTeamFile } from "./team-file-operations.ts";

interface JournalChange {
	path: string;
	before: string | null;
	sha256?: string;
}
interface Journal {
	schemaVersion: 1;
	id: string;
	pid: number;
	state: "active" | "committed";
	changes: JournalChange[];
	events: TeamAuditEvent[];
}
interface Context {
	root: string;
	directory: string;
	journal: Journal;
	chain: Promise<void>;
}
const context = new AsyncLocalStorage<Context>();
const activeRoots = new Set<string>();
const directoryName = ".transactions";

function contained(root: string, path: string): string {
	const part = relative(resolve(root), resolve(path));
	if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Transaction path is outside its namespace");
	return part.replaceAll("\\", "/");
}

async function durableReplace(path: string, body: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(body);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await renameTeamFile(temporary, path);
}

function persist(value: Context): Promise<void> {
	return durableReplace(join(value.directory, "journal.json"), `${JSON.stringify(value.journal)}\n`);
}

async function enqueue(value: Context, operation: () => Promise<void>): Promise<void> {
	const pending = value.chain.then(operation);
	value.chain = pending;
	await pending;
}

/** Called before each JSON mutation. Unmodified files and immutable blob bytes need no before-image. */
export async function recordTeamFileChange(path: string): Promise<void> {
	const value = context.getStore();
	if (!value) return;
	const part = contained(value.root, path);
	if (part.startsWith(`${directoryName}/`))
		throw new Error("Cannot mutate transaction metadata through a business write");
	await enqueue(value, async () => {
		if (value.journal.changes.some((change) => change.path === part)) return;
		let body: Buffer | undefined;
		try {
			body = await readFile(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const before = body ? `${value.journal.changes.length}.before` : null;
		if (body && before) await durableReplace(join(value.directory, before), body);
		value.journal.changes.push({
			path: part,
			before,
			sha256: body ? createHash("sha256").update(body).digest("hex") : undefined,
		});
		await persist(value);
	});
}

/** Persist the event with the operation before acknowledging the business write. */
export async function stageTeamAuditEvent(root: string, event: TeamAuditEvent): Promise<boolean> {
	const value = context.getStore();
	if (!value || value.root !== resolve(root)) return false;
	await enqueue(value, async () => {
		value.journal.events.push(event);
		await persist(value);
	});
	return true;
}

async function flushEvents(value: Context, recovering: boolean): Promise<void> {
	if (!value.journal.events.length) return;
	const path = join(value.root, "events", "audit.jsonl");
	const existing = new Set<string>();
	if (recovering) {
		try {
			const input = (await open(path, "r")).createReadStream({ encoding: "utf8" });
			const lines = createInterface({ input, crlfDelay: Infinity });
			for await (const line of lines) {
				try {
					const id = (JSON.parse(line) as { id?: string }).id;
					if (id && value.journal.events.some((event) => event.id === id)) existing.add(id);
				} catch {
					/* An interrupted append may leave a partial line. */
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const pending = value.journal.events.filter((event) => !existing.has(event.id));
	if (!pending.length) return;
	await mkdir(dirname(path), { recursive: true });
	// The leading newline separates a partial pre-crash record from the recovered event.
	await appendFile(path, `\n${pending.map((event) => JSON.stringify(event)).join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function rollback(value: Context): Promise<void> {
	for (const change of [...value.journal.changes].reverse()) {
		const target = resolve(value.root, change.path);
		contained(value.root, target);
		if (change.before === null) {
			await unlink(target).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		} else {
			if (!/^\d+\.before$/.test(change.before)) throw new Error("Invalid transaction backup path");
			const body = await readFile(join(value.directory, change.before));
			if (createHash("sha256").update(body).digest("hex") !== change.sha256)
				throw new Error("Transaction backup checksum mismatch");
			await durableReplace(target, body);
		}
	}
}

async function removeJournal(value: Context): Promise<void> {
	const expected = resolve(value.root, directoryName);
	if (dirname(resolve(value.directory)) !== expected || !/^[a-f0-9-]{36}$/.test(value.journal.id))
		throw new Error("Invalid transaction cleanup target");
	await rm(value.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Called before serving a namespace after restart, including read requests. */
export async function recoverTeamWrites(root: string): Promise<void> {
	root = resolve(root);
	if (activeRoots.has(root)) throw new Error("A namespace transaction is still running");
	let entries: string[];
	try {
		entries = await readdir(join(root, directoryName));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const id of entries) {
		if (!/^[a-f0-9-]{36}$/.test(id)) continue;
		const directory = join(root, directoryName, id);
		let journal: Journal;
		try {
			journal = JSON.parse(await readFile(join(directory, "journal.json"), "utf8")) as Journal;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// No business writes begin before the initial manifest is durable.
			const unfinished = await readdir(directory);
			if (unfinished.some((name) => !name.startsWith("journal.json.") || !name.endsWith(".tmp")))
				throw new Error("Recovery journal is missing its manifest");
			if (dirname(resolve(directory)) !== resolve(root, directoryName))
				throw new Error("Invalid transaction cleanup target");
			await rm(directory, { recursive: true, force: true });
			continue;
		}
		if (
			journal.schemaVersion !== 1 ||
			journal.id !== id ||
			!Number.isInteger(journal.pid) ||
			journal.pid <= 0 ||
			!["active", "committed"].includes(journal.state) ||
			!Array.isArray(journal.changes) ||
			!Array.isArray(journal.events)
		)
			throw new Error("Invalid namespace recovery journal");
		if (journal.pid !== process.pid && alive(journal.pid))
			throw new Error("Another process owns the namespace transaction");
		const value: Context = { root, directory, journal, chain: Promise.resolve() };
		if (journal.state === "committed") await flushEvents(value, true);
		else await rollback(value);
		const lockPath = join(root, ".write.lock");
		try {
			const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
			if (lock.pid === journal.pid && !alive(lock.pid)) await unlink(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await removeJournal(value);
	}
}

export async function runTeamWrite<T>(root: string, operation: () => Promise<T>): Promise<T> {
	root = resolve(root);
	await recoverTeamWrites(root);
	const id = randomUUID();
	const value: Context = {
		root,
		directory: join(root, directoryName, id),
		journal: { schemaVersion: 1, id, pid: process.pid, state: "active", changes: [], events: [] },
		chain: Promise.resolve(),
	};
	try {
		await persist(value);
	} catch (error) {
		await removeJournal(value);
		throw error;
	}
	activeRoots.add(root);
	try {
		const result = await context.run(value, operation);
		value.journal.state = "committed";
		await persist(value);
		await flushEvents(value, false);
		await removeJournal(value);
		return result;
	} catch (error) {
		if (value.journal.state === "active") {
			await rollback(value);
			await removeJournal(value);
		}
		// A committed operation is never undone merely because audit delivery failed: its journal is the durable outbox.
		throw error;
	} finally {
		activeRoots.delete(root);
	}
}
