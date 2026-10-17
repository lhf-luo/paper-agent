import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import { registerCanvasResearchTools } from "../src/canvas/presentation/canvas-research-tools.ts";
import paperAgentExtension from "../src/index.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { collectRegisteredTools } from "../src/shared/presentation/agent-tool-catalog.ts";

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
	const tools = collectRegisteredTools(paperAgentExtension);
	// Registration only: no database or network is accessed by this documentation context.
	const canvasService = new CanvasResearchService(
		new LiteratureStore(resolveCorpusRoot(process.cwd(), "personal", "default"), "personal", "default"),
		"default",
		"documentation",
		"documentation",
	);
	const canvasTools = collectRegisteredTools((pi) => registerCanvasResearchTools(pi, canvasService));
	const lines = [
		"# Agent 工具清单",
		"",
		"> 此文件由 `npm run docs:tools` 从运行时注册表生成。工具的实际参数和使用要求以 `inspect_agent_tools` 的结果为准。",
		"",
		`共 ${tools.length} 个工具。`,
		"",
		"| 工具 | 用途 | Agent 使用要求 |",
		"| --- | --- | --- |",
		...tools.map(
			(tool) =>
				`| \`${escapeCell(tool.name)}\` | ${escapeCell(tool.description)} | ${escapeCell(
					(tool.promptGuidelines ?? []).join("；") || "使用工具描述中的参数约束。",
				)} |`,
		),
		"",
		"## 画布会话专属工具",
		"",
		"仅在绑定 namespace 和画布的 Agent 会话注册；通用和论文会话不提供这些工具。预览确认不能被自动权限模式跳过。",
		"",
		"| 工具 | 用途 |",
		"| --- | --- |",
		...canvasTools.map((tool) => `| \`${escapeCell(tool.name)}\` | ${escapeCell(tool.description)} |`),
		"",
	];
	const target = resolve(process.cwd(), "docs", "agent-tools.md");
	const content = `${lines.join("\n")}\n`;
	if (process.argv.includes("--check")) {
		const current = await readFile(target, "utf8").catch(() => "");
		if (current !== content) {
			throw new Error("docs/agent-tools.md is stale; run npm run docs:tools");
		}
		return;
	}
	await writeFile(target, content, "utf8");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
