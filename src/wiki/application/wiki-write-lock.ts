import { mkdir, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAtomic } from "./wiki-page-codec.ts";

export async function withWikiWriteLock<T>(root: string, run: () => Promise<T>): Promise<T> {
	await mkdir(root, { recursive: true });
	const lockPath = resolve(root, ".wiki.lock");
	const started = Date.now();
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started > 10_000) throw new Error("Timed out waiting for the Wiki write lock");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
	}
	try {
		return await run();
	} finally {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

export async function restoreWikiFiles(backups: Map<string, string | undefined>): Promise<void> {
	for (const [path, content] of backups) {
		if (content === undefined) await rm(path, { force: true }).catch(() => undefined);
		else await writeAtomic(path, content).catch(() => undefined);
	}
}
