import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function measureDirectoryUntil(
	root: string,
	maximumBytes: number,
): Promise<{ bytes: number; exceeded: boolean }> {
	let bytes = 0;
	const pending = [root];
	while (pending.length) {
		const current = pending.shift();
		if (!current) break;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				bytes += (await lstat(path)).size;
			} catch {
				continue;
			}
			if (bytes > maximumBytes) return { bytes, exceeded: true };
		}
	}
	return { bytes, exceeded: false };
}
