import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ResearchNoteTemplate } from "../domain/research-notes.ts";

const BUILT_IN_TEMPLATES = new Map([
	["skim", { filename: "skim.md", name: "略读" }],
	["deep-reading", { filename: "deep-reading.md", name: "精读" }],
	["comparison-matrix", { filename: "comparison-matrix.md", name: "比较矩阵" }],
]);
const BUILT_IN_TEMPLATE_DIRECTORY = new URL(
	"../../../.agents/skills/paper-research/assets/research-notes/",
	import.meta.url,
);

export class ResearchTemplateStore {
	readonly directory: string;

	constructor(dataRoot: string) {
		this.directory = join(dataRoot, "templates", "research-notes");
	}

	async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		await Promise.all(
			[...BUILT_IN_TEMPLATES.values()].map(async ({ filename }) => {
				const markdown = await readFile(new URL(filename, BUILT_IN_TEMPLATE_DIRECTORY), "utf8");
				const path = join(this.directory, filename);
				await writeFile(path, markdown, { encoding: "utf8", flag: "wx" }).catch(
					async (error: NodeJS.ErrnoException) => {
						if (error.code !== "EEXIST") throw error;
						// Upgrade the original empty defaults while preserving user-edited templates.
						if ((await readFile(path, "utf8")) === "") await writeFile(path, markdown, "utf8");
					},
				);
			}),
		);
	}

	async list(): Promise<ResearchNoteTemplate[]> {
		await this.initialize();
		const names = (await readdir(this.directory, { withFileTypes: true }))
			.filter(
				(entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md") && !entry.name.startsWith("."),
			)
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
		const templates = await Promise.all(
			names.map(async (filename) => {
				const markdown = await readFile(join(this.directory, filename), "utf8");
				const builtIn = [...BUILT_IN_TEMPLATES.entries()].find(([, value]) => value.filename === filename);
				const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
				return {
					id: builtIn?.[0] ?? basename(filename, ".md"),
					name: builtIn?.[1].name ?? heading ?? basename(filename, ".md"),
					filename,
					markdown,
				};
			}),
		);
		return [{ id: "blank", name: "空白", markdown: "" }, ...templates];
	}

	async get(id: string): Promise<ResearchNoteTemplate | undefined> {
		return (await this.list()).find((template) => template.id === id);
	}
}
