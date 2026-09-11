import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface LatexArtifactSource {
	path: string;
	text: string;
}

const MAX_TEX_FILES = 300;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export async function readLatexArtifactSources(directory: string): Promise<LatexArtifactSource[]> {
	const root = resolve(directory);
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`LaTeX source path is not a regular directory: ${root}`);
	}
	const sources: LatexArtifactSource[] = [];
	const pending = [root];
	let totalBytes = 0;
	while (pending.length && sources.length < MAX_TEX_FILES && totalBytes < MAX_TOTAL_BYTES) {
		const current = pending.shift();
		if (!current) break;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".tex")) continue;
			const remaining = MAX_TOTAL_BYTES - totalBytes;
			const body = await readFile(path);
			if (body.length > remaining) return sources;
			totalBytes += body.length;
			sources.push({ path: relative(root, path).replaceAll("\\", "/"), text: body.toString("utf8") });
			if (sources.length >= MAX_TEX_FILES) break;
		}
	}
	return sources;
}
