import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { execGitWithTransportRetry } from "./artifact-git-execution.ts";

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isUnsafeWindowsSegment(segment: string): boolean {
	return /[<>:"\\|?*\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment);
}

export function windowsUnsafeGitPaths(paths: string[]): string[] {
	return paths.filter((path) => path.split("/").some(isUnsafeWindowsSegment));
}

export function windowsUnsafeCheckoutExclusions(paths: string[]): {
	directories: string[];
	files: string[];
} {
	const unsafe = new Set(windowsUnsafeGitPaths(paths));
	const candidateDirectories = new Set<string>();
	for (const path of unsafe) {
		const segments = path.split("/");
		for (let length = 1; length < segments.length; length += 1) {
			const directory = segments.slice(0, length).join("/");
			if (!directory.split("/").some(isUnsafeWindowsSegment)) candidateDirectories.add(directory);
		}
	}
	const directories = [...candidateDirectories]
		.filter((directory) => {
			const prefix = `${directory}/`;
			return !paths.some((path) => path.startsWith(prefix) && !unsafe.has(path));
		})
		.sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))
		.filter((directory, index, selected) =>
			selected.slice(0, index).every((parent) => !directory.startsWith(`${parent}/`)),
		);
	const files = [...unsafe].filter((path) => !directories.some((directory) => path.startsWith(`${directory}/`)));
	return { directories, files };
}

export function generatedGitDirectories(paths: string[]): string[] {
	const directories = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/");
		for (let index = 0; index < segments.length - 1; index += 1) {
			if (
				!/(?:^|[-_.])(?:build|dist|target)$|\.out$|^(?:node_modules|__pycache__|\.venv|venv)$/i.test(
					segments[index],
				)
			) {
				continue;
			}
			directories.add(segments.slice(0, index + 1).join("/"));
			break;
		}
	}
	return [...directories].sort();
}

function escapeSparsePattern(path: string): string {
	return path.replace(/([\\*?[\]])/g, "\\$1");
}

export async function prepareWindowsSparseCheckout(
	executor: CommandExecutor,
	repositoryPath: string,
	treeish: string,
	signal?: AbortSignal,
): Promise<string[]> {
	if (process.platform !== "win32") return [];
	const listed = await executor.exec("git", ["-C", repositoryPath, "ls-tree", "-r", "-z", "--name-only", treeish], {
		signal,
		timeout: 60_000,
	});
	if (listed.code !== 0 || listed.killed || signal?.aborted) return [];
	const paths = listed.stdout.split("\0").filter(Boolean);
	const generatedDirectories = generatedGitDirectories(paths);
	const unsafeExclusions = windowsUnsafeCheckoutExclusions(paths);
	const unsafeDirectories = unsafeExclusions.directories.filter(
		(path) => !generatedDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`)),
	);
	const unsafePaths = unsafeExclusions.files.filter(
		(path) => !generatedDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`)),
	);
	const excluded = [...generatedDirectories, ...unsafeDirectories, ...unsafePaths];
	if (excluded.length === 0) return [];
	for (const [key, value] of [
		["core.sparseCheckout", "true"],
		["core.protectNTFS", "false"],
	] as const) {
		const configured = await executor.exec("git", ["-C", repositoryPath, "config", key, value], {
			signal,
			timeout: 15_000,
		});
		if (configured.code !== 0 || configured.killed) {
			throw new Error(configured.stderr.trim() || `Could not configure ${key} for Windows-safe checkout`);
		}
	}
	const infoDirectory = join(repositoryPath, ".git", "info");
	await mkdir(infoDirectory, { recursive: true });
	const patterns = [
		"/**",
		...generatedDirectories.map((path) => `!/${escapeSparsePattern(path)}/**`),
		...unsafeDirectories.map((path) => `!/${escapeSparsePattern(path)}/**`),
		...unsafePaths.map((path) => `!/${escapeSparsePattern(path)}`),
		"",
	].join("\n");
	await writeFile(join(infoDirectory, "sparse-checkout"), patterns, "utf8");
	return excluded;
}

export async function restoreWindowsNtfsProtection(
	executor: CommandExecutor,
	repositoryPath: string,
	excludedPaths: string[],
	signal?: AbortSignal,
): Promise<void> {
	if (process.platform !== "win32" || excludedPaths.length === 0) return;
	const restored = await executor.exec("git", ["-C", repositoryPath, "config", "core.protectNTFS", "true"], {
		signal,
		timeout: 15_000,
	});
	if (restored.code !== 0 || restored.killed) {
		throw new Error(restored.stderr.trim() || "Could not restore Git core.protectNTFS after sparse checkout");
	}
}

export async function checkoutGitTree(
	executor: CommandExecutor,
	repositoryPath: string,
	treeish: string,
	gitOptions: string[],
	fallbackOperation: string[],
	timeout: number,
	signal?: AbortSignal,
): Promise<{
	excludedPaths: string[];
	result: Awaited<ReturnType<CommandExecutor["exec"]>>;
}> {
	const excludedPaths = await prepareWindowsSparseCheckout(executor, repositoryPath, treeish, signal);
	const operation = excludedPaths.length ? ["read-tree", "-mu", treeish] : fallbackOperation;
	const result = await execGitWithTransportRetry(
		executor,
		[...gitOptions, "-C", repositoryPath, ...operation],
		{ signal, timeout },
		3,
	);
	return { excludedPaths, result };
}
