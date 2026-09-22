import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";

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
			expect(await application.getWikiManagementFile("index.md", "lab")).toMatchObject({
				name: "index.md",
				path: "index.md",
			});
			expect((await application.getWikiManagementFile("log.md", "lab"))?.markdown).toContain(
				"# Research Wiki change log",
			);
			expect(await application.getWikiManagementFile("../index.md", "lab")).toBeUndefined();
			expect(
				listed.tree
					?.filter((node) => node.kind === "management")
					.map((node) => node.name)
					.sort(),
			).toEqual(["index.md", "log.md"]);
			expect(
				listed.tree
					?.filter((node) => node.kind === "folder")
					.map((node) => node.name)
					.sort(),
			).toEqual(folders);

			const staticRoot = join(projectRoot, "dist", "web");
			await mkdir(staticRoot, { recursive: true });
			await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
			const server = await startLocalWebServer(application, { staticRoot });
			try {
				const response = await fetch(
					`${server.url}/api/wiki/management-file?namespace=lab&path=${encodeURIComponent("index.md")}`,
				);
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					namespace: "lab",
					file: { name: "index.md", path: "index.md", markdown: expect.stringContaining("Research Wiki Index") },
				});
				const rejected = await fetch(
					`${server.url}/api/wiki/management-file?namespace=lab&path=${encodeURIComponent("topics/page.md")}`,
				);
				expect(rejected.status).toBe(404);
			} finally {
				await server.close();
			}
		} finally {
			await application.close();
		}
	});
});
