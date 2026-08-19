import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("prompt and skill contracts", () => {
	it("keeps the evidence gates and mergeable report sections in a shorter system prompt", async () => {
		const prompt = await readFile(join(repositoryRoot, "src", "SYSTEM.md"), "utf8");

		expect(prompt.length).toBeLessThan(8_000);
		for (const required of [
			"搜索结果、摘要和元数据只用于发现来源，不能独立证明技术 claim",
			"全部物理页面",
			"对象级核验",
			"精确 commit",
			"证据边界",
			"仍然未知的问题",
		]) {
			expect(prompt).toContain(required);
		}
		const outputContract = prompt.slice(prompt.indexOf("## 最终输出"));
		expect(outputContract.match(/^\d+\. /gm)).toHaveLength(12);
	});

	it("keeps the literature skill concise and delegates deterministic work to tools", async () => {
		const skillRoot = join(repositoryRoot, "skills", "literature-corpus-manager");
		const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
		const yaml = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
		const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";

		expect(skill.split(/\r?\n/).length).toBeLessThan(500);
		expect(frontmatter.match(/^[a-z_]+:/gm)?.sort()).toEqual(["description:", "name:"]);
		expect(skill).toContain("Use paper-agent tools as the single implementation");
		expect(skill).toContain("does not replace human deep reading");
		expect(skill).toContain("search_literature_corpus");
		expect(skill).toContain("manage_literature_memory");
		expect(skill).toContain("team-proposed");
		expect(yaml).toContain("Literature Corpus Manager");
	});
});
