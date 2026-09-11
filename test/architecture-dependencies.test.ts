import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const maxRuntimeSourceLines = 600;

async function sourceFiles(directory = sourceRoot): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
		}),
	);
	return nested.flat();
}

function relativeImports(source: string): string[] {
	return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["'](\.[^"']+)["']/g)].map(
		(match) => match[1],
	);
}

function resolveImport(importer: string, specifier: string): string {
	const path = resolve(dirname(importer), specifier);
	return path.endsWith(".ts") ? path : `${path}.ts`;
}

describe("source architecture", () => {
	it("keeps runtime TypeScript compatible with Node strip-only execution", async () => {
		const unsupported: string[] = [];
		for (const file of await sourceFiles()) {
			const source = await readFile(file, "utf8");
			if (/constructor\s*\([^)]*\b(?:private|protected|public|readonly)\b/s.test(source)) {
				unsupported.push(`${relative(sourceRoot, file)}: constructor parameter property`);
			}
			if (/^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m.test(source)) {
				unsupported.push(`${relative(sourceRoot, file)}: enum`);
			}
			if (/^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+[A-Za-z_$]/m.test(source)) {
				unsupported.push(`${relative(sourceRoot, file)}: namespace/module`);
			}
			if (/^\s*import\s+\w+\s*=/m.test(source)) {
				unsupported.push(`${relative(sourceRoot, file)}: import assignment`);
			}
		}
		expect(unsupported).toEqual([]);
	});
	it("keeps presentation dependencies at the outer layer", async () => {
		for (const file of await sourceFiles()) {
			const name = relative(sourceRoot, file).replaceAll("\\", "/");
			if (name === "index.ts" || name.includes("/presentation/")) continue;
			const imports = relativeImports(await readFile(file, "utf8"));
			expect(
				imports.filter((specifier) => specifier.includes("/presentation/")),
				name,
			).toEqual([]);
		}
	});

	it("keeps domain and infrastructure layers inward-facing", async () => {
		for (const file of await sourceFiles()) {
			const name = relative(sourceRoot, file).replaceAll("\\", "/");
			const isDomain = name.includes("/domain/");
			const isInfrastructure = name.includes("/infrastructure/");
			if (!isDomain && !isInfrastructure) continue;
			const imports = relativeImports(await readFile(file, "utf8"));
			const forbidden = isDomain
				? ["/application/", "/infrastructure/", "/presentation/"]
				: ["/application/", "/presentation/"];
			expect(
				imports.filter((specifier) => forbidden.some((fragment) => specifier.includes(fragment))),
				name,
			).toEqual([]);
		}
	});

	it("keeps runtime source files within the module-size budget", async () => {
		for (const file of await sourceFiles()) {
			const name = relative(sourceRoot, file).replaceAll("\\", "/");
			const lines = (await readFile(file, "utf8")).trimEnd().split(/\r?\n/).length;
			expect(lines, name).toBeLessThanOrEqual(maxRuntimeSourceLines);
		}
	});

	it("keeps the extension entrypoint as a one-way composition root", async () => {
		for (const file of await sourceFiles()) {
			const name = relative(sourceRoot, file).replaceAll("\\", "/");
			if (name === "index.ts") continue;
			const imports = relativeImports(await readFile(file, "utf8"));
			expect(
				imports.filter((specifier) => /(?:^|\/)index\.ts$/.test(specifier)),
				name,
			).toEqual([]);
		}
	});

	it("has no relative-import cycles", async () => {
		const files = await sourceFiles();
		const fileSet = new Set(files);
		const graph = new Map<string, string[]>();
		for (const file of files) {
			const imports = relativeImports(await readFile(file, "utf8"))
				.map((specifier) => resolveImport(file, specifier))
				.filter((dependency) => fileSet.has(dependency));
			graph.set(file, imports);
		}

		const visited = new Set<string>();
		const active = new Set<string>();
		const stack: string[] = [];
		const visit = (file: string): string[] | undefined => {
			if (active.has(file)) return [...stack.slice(stack.indexOf(file)), file];
			if (visited.has(file)) return undefined;
			visited.add(file);
			active.add(file);
			stack.push(file);
			for (const dependency of graph.get(file) ?? []) {
				const cycle = visit(dependency);
				if (cycle) return cycle;
			}
			stack.pop();
			active.delete(file);
			return undefined;
		};

		for (const file of files) {
			const cycle = visit(file);
			expect(cycle?.map((entry) => relative(sourceRoot, entry).replaceAll("\\", "/"))).toBeUndefined();
		}
	});
});
