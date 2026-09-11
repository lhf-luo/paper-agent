import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Wiki storage initialization", () => {
	it("creates the namespace directory and rebuildable index during application startup", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "paper-agent-wiki-init-"));
		temporaryPaths.push(projectRoot);
		const dataRoot = join(projectRoot, "data");
		const application = new PaperAgentApplication({
			projectRoot,
			dataRoot,
			defaultNamespace: "lab",
		});
		try {
			await application.initialize();
			const directory = join(dataRoot, "wiki", "lab");
			expect((await stat(directory)).isDirectory()).toBe(true);
			expect((await stat(join(dataRoot, "wiki", "wiki.sqlite"))).isFile()).toBe(true);
			expect(await readFile(join(directory, "index.md"), "utf8")).toContain("# Research Wiki Index");
			expect(await readFile(join(directory, "log.md"), "utf8")).toContain("# Research Wiki change log");
			const folders = (await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			expect(folders).toEqual(
				["concepts", "datasets", "methods", "questions", "syntheses", "systems", "topics"].sort(),
			);
			const listed = await application.listWikiPages("lab");
			expect(
				listed.tree
					?.filter((node) => node.kind === "folder")
					.map((node) => node.name)
					.sort(),
			).toEqual(folders);
		} finally {
			await application.close();
		}
	});
});
