import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("prompt and skill contracts", () => {
	it("keeps global discipline in the system prompt and research workflow in the skill", async () => {
		const prompt = await readFile(join(repositoryRoot, "src", "SYSTEM.md"), "utf8");
		const skillRoot = join(repositoryRoot, ".agents", "skills", "paper-research");
		const [skill, subtaskContracts] = await Promise.all([
			readFile(join(skillRoot, "SKILL.md"), "utf8"),
			readFile(join(skillRoot, "references", "subtask-contracts.md"), "utf8"),
		]);

		expect(prompt.length).toBeLessThan(4_000);
		for (const required of [
			"搜索结果、摘要和元数据只用于发现来源，不能独立证明技术 claim",
			"精确 commit",
			"不可信输入",
			"凭据保护",
			"人工边界",
			"[未知]",
		]) {
			expect(prompt).toContain(required);
		}
		expect(prompt).not.toContain("## 任务模式");
		expect(prompt).not.toContain("## 最终输出");
		expect(prompt).not.toContain("严格输出 12 节");
		for (const researchContract of ["快速略读", "方法精读", "全文研究", "复现准备"]) {
			expect(skill).toContain(`**${researchContract}**`);
		}
		expect(skill).toContain("用户说“精读”“精读论文”“深度阅读”“完整分析”“全文研究”");
		expect(skill).toContain("通过 MinerU pages 或 Markdown cursor 完成完整正文覆盖");
		expect(skill).toContain("全文研究不要求用 `read_pdf` 重读每一页");
		expect(skill).toContain("模型具备图像输入能力，应直接检查图片");
		expect(skill).toContain("paper_progress");
		expect(skill).toContain("challenge -> design -> evaluation");
		expect(skill).toContain("不得合并、缺省或用其他章节替代");
		expect(skill).toContain("12. **非增量 follow-up idea**");
		expect(skill).not.toContain("Do not force a fixed number of report sections");
		expect(subtaskContracts).toContain("普通“精读”");
		expect(subtaskContracts).toContain("12 节均存在且职责不被合并");
		expect(subtaskContracts).not.toContain("Do not force a fixed number of report sections");
	});

	it("keeps the literature skill concise and delegates deterministic work to tools", async () => {
		const skillRoot = join(repositoryRoot, ".agents", "skills", "literature-corpus-manager");
		const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
		const yaml = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
		const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";

		expect(skill.split(/\r?\n/).length).toBeLessThan(500);
		expect(frontmatter.match(/^[a-z_]+:/gm)?.sort()).toEqual(["description:", "name:"]);
		expect(skill).toContain("Use paper-agent tools as the single implementation");
		expect(skill).toContain("Paper reading and research-note authoring belong to the paper-research skill");
		expect(skill).toContain("search_literature_corpus");
		expect(skill).toContain("get_personal_library_paper");
		expect(skill).toContain("manage_literature_memory");
		expect(skill).toContain("Filtering preserves the search run and saves only a session-scoped selection snapshot");
		expect(skill).toContain("do not select a subset by title");
		expect(skill).toContain("team-proposed");
		expect(yaml).toContain("Literature Corpus Manager");
		expect(yaml).toContain("proactively screen and denoise collected results");
	});

	it("keeps Wiki ingestion source-located, tool-discovered, batched, and linted", async () => {
		const skillRoot = join(repositoryRoot, ".agents", "skills", "research-wiki");
		const [skill, schema, ingest, query, lint] = await Promise.all([
			readFile(join(skillRoot, "SKILL.md"), "utf8"),
			readFile(join(skillRoot, "references", "schema.md"), "utf8"),
			readFile(join(skillRoot, "references", "ingest-contract.md"), "utf8"),
			readFile(join(skillRoot, "references", "query-contract.md"), "utf8"),
			readFile(join(skillRoot, "references", "lint-contract.md"), "utf8"),
		]);
		expect(skill).toContain("inspect_agent_tools");
		expect(skill).toContain("MinerU");
		expect(skill).toContain("preview_fingerprint");
		expect(skill).toContain("不要绕过工具直接编辑 Markdown");
		expect(skill).toContain("尚未沉淀");
		expect(skill).toContain("delete_research_wiki_source_pages");
		expect(skill).toContain("include_mixed_page_ids");
		expect(schema).toContain("evidence:");
		expect(schema).toContain("pdf_page");
		expect(ingest).toContain("declaration-level evidence");
		expect(query).toContain("Do not silently use");
		expect(lint).toContain("Lint is read-only");
		expect(lint).toContain("delete_research_wiki_source_pages");
	});
});
