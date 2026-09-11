import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CommandExecutor } from "../../../shared/infrastructure/command-executor.ts";

export type ArchiveExtractor = "unzip" | "tar";

export async function findArchiveExtractor(executor: CommandExecutor): Promise<ArchiveExtractor | undefined> {
	for (const candidate of ["unzip", "tar"] as const) {
		try {
			const result = await executor.exec(candidate, [candidate === "unzip" ? "-v" : "--version"], {
				timeout: 5_000,
			});
			if (result.code === 0) return candidate;
		} catch {
			// Try the next system extractor.
		}
	}
	return undefined;
}

function safeArchiveEntry(value: string): boolean {
	const normalized = value.replaceAll("\\", "/");
	return (
		Boolean(normalized) &&
		!isAbsolute(normalized) &&
		!/^[A-Za-z]:/.test(normalized) &&
		!normalized.split("/").includes("..")
	);
}

async function listEntries(executor: CommandExecutor, extractor: ArchiveExtractor, archive: string): Promise<string[]> {
	const result = await executor.exec(extractor, extractor === "unzip" ? ["-Z1", archive] : ["-tf", archive], {
		timeout: 60_000,
	});
	if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "Could not inspect MinerU ZIP");
	const entries = result.stdout.split(/\r?\n/).filter(Boolean);
	if (!entries.length || entries.length > 10_000) throw new Error("MinerU ZIP has an invalid number of entries");
	if (entries.some((entry) => !safeArchiveEntry(entry))) throw new Error("MinerU ZIP contains an unsafe path");
	return entries;
}

export async function extractMineruArchive(
	executor: CommandExecutor,
	extractor: ArchiveExtractor,
	archive: string,
	destination: string,
): Promise<void> {
	await listEntries(executor, extractor, archive);
	await mkdir(destination, { recursive: true });
	const args = extractor === "unzip" ? ["-qq", "-o", archive, "-d", destination] : ["-xf", archive, "-C", destination];
	const result = await executor.exec(extractor, args, { timeout: 10 * 60_000 });
	if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "Could not extract MinerU ZIP");
}

export async function inspectExtractedTree(root: string): Promise<Array<{ path: string; bytes: number }>> {
	const files: Array<{ path: string; bytes: number }> = [];
	const pending = [resolve(root)];
	let total = 0;
	while (pending.length) {
		const directory = pending.pop();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll("\\", "/");
			if (!safeArchiveEntry(relativePath)) throw new Error("Extracted MinerU path escaped its destination");
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink()) throw new Error("MinerU ZIP contains a symbolic link");
			if (metadata.isDirectory()) pending.push(path);
			else if (metadata.isFile()) {
				total += metadata.size;
				if (total > 1024 * 1024 * 1024) throw new Error("Extracted MinerU package exceeds 1 GB");
				files.push({ path: relativePath, bytes: metadata.size });
				if (files.length > 10_000) throw new Error("Extracted MinerU package has too many files");
			}
		}
	}
	await stat(root);
	return files;
}
