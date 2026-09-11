import { delimiter, resolve } from "node:path";

const appliedDirectories = new WeakMap<object, string[]>();

function pathKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	return paths.filter((path) => {
		const key = pathKey(path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function resolveExternalToolDirectories(
	configured: string[] = [],
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	const override = environment.PAPER_AGENT_EXTERNAL_TOOL_PATHS;
	const source = override === undefined ? configured : override.split(delimiter);
	return uniquePaths(
		source
			.map((path) => path.trim())
			.filter(Boolean)
			.map((path) => resolve(path)),
	);
}

export function applyExternalToolDirectories(
	configured: string[] = [],
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	const selected = resolveExternalToolDirectories(configured, environment);
	const previous = new Set((appliedDirectories.get(environment) ?? []).map(pathKey));
	const inherited = (environment.PATH ?? "")
		.split(delimiter)
		.map((path) => path.trim())
		.filter((path) => path && !previous.has(pathKey(path)));
	environment.PATH = uniquePaths([...selected, ...inherited]).join(delimiter);
	appliedDirectories.set(environment, selected);
	return selected;
}
