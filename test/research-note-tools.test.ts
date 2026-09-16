import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { ResearchNotebook } from "../src/research/application/research-notebook.ts";
import { registerResearchTools } from "../src/research/presentation/research-tools.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-note-tools-"));
	temporaryPaths.push(root);
	const tools = new Map<string, any>();
	registerResearchTools({
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	const notebook = new ResearchNotebook(
		new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default"),
	);
	const ctx = { cwd: root, hasUI: true, ui: { confirm: vi.fn(async () => true) } };
	return { root, tools, notebook, ctx };
}

describe("research note Agent tools", () => {
	it("registers the Markdown note tools and no structured skim-card tool", () => {
		const names: string[] = [];
		registerResearchTools({
			registerTool(tool: { name: string }) {
				names.push(tool.name);
			},
		} as unknown as ExtensionAPI);

		expect(names).toEqual(["search_research_notes", "manage_research_note"]);
		expect(names).not.toContain("save_skim_card");
	});

	it("reads the current local template without creating a note and rejects unknown templates", async () => {
		const { tools, notebook, ctx } = await fixture();
		await notebook.templates();
		const markdown = "# 自定义略读\n\n## 我的证据字段\n";
		await writeFile(join(notebook.templateStore.directory, "skim.md"), markdown, "utf8");
		const search = tools.get("search_research_notes");
		const result = await search.execute("template", { template_id: "skim" }, undefined, undefined, ctx);
		expect(result.details.template).toMatchObject({ id: "skim", markdown });
		expect(result.content[0].text).toBe(markdown);
		expect(await notebook.list()).toEqual([]);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		await expect(search.execute("missing", { template_id: "missing" }, undefined, undefined, ctx)).rejects.toThrow(
			"Research note template not found",
		);
	});

	it("saves completed Markdown with its template and returns the actual note file", async () => {
		const { root, tools, notebook, ctx } = await fixture();
		const markdown = "# 论文略读笔记\n\n[论文] 问题与机制，物理页 2。\n[未知] 未公开实验预算。\n";
		const result = await tools
			.get("manage_research_note")
			.execute(
				"create",
				{ action: "create", title: "Evidence skim", template_id: "skim", markdown },
				undefined,
				undefined,
				ctx,
			);
		const note = result.details.note;
		expect(note).toMatchObject({ title: "Evidence skim", templateId: "skim", markdown, papers: [] });
		expect((await notebook.get(note.id))!.markdown).toBe(markdown);
		expect(await readFile(resolve(root, ".paper-agent", note.relativePath), "utf8")).toBe(markdown);
	});

	it("does not create a note when the required confirmation is cancelled", async () => {
		const { root, tools, notebook, ctx } = await fixture();
		const config = defaultPaperAgentConfig();
		config.confirmations.requireResearchConfirmation = true;
		await savePaperAgentConfig(root, config);
		ctx.ui.confirm.mockResolvedValue(false);
		await expect(
			tools
				.get("manage_research_note")
				.execute(
					"cancel",
					{ action: "create", title: "Cancelled skim", template_id: "skim", markdown: "Analysis" },
					undefined,
					undefined,
					ctx,
				),
		).rejects.toThrow("cancelled");
		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(await notebook.list()).toEqual([]);
	});
});
