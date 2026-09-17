import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lookupCcfLevel } from "../src/literature/infrastructure/ccf-ranking.ts";

describe("runtime resource paths", () => {
	it("loads the system prompt from the stable source root", async () => {
		const systemPath = resolve(process.cwd(), "src", "SYSTEM.md");
		await expect(access(systemPath)).resolves.toBeUndefined();
		const system = await readFile(systemPath, "utf8");
		expect(system).toContain("[论文]");
		expect(system).toContain("[未知]");
		expect(system).toContain("不可信输入");
		expect(system).not.toContain("## 任务模式");
		expect(system).not.toContain("## 完整关卡");
	});

	it("ships the paper research skill and its supporting contracts", async () => {
		const skillRoot = resolve(process.cwd(), ".agents", "skills", "paper-research");
		const requiredFiles = [
			"SKILL.md",
			join("agents", "openai.yaml"),
			join("references", "evidence-contract.md"),
			join("references", "subtask-contracts.md"),
			join("assets", "research-notes", "skim.md"),
			join("assets", "research-notes", "deep-reading.md"),
			join("assets", "research-notes", "comparison-matrix.md"),
		];
		await Promise.all(requiredFiles.map((path) => access(resolve(skillRoot, path))));

		const [skill, evidence, contracts] = await Promise.all([
			readFile(resolve(skillRoot, "SKILL.md"), "utf8"),
			readFile(resolve(skillRoot, "references", "evidence-contract.md"), "utf8"),
			readFile(resolve(skillRoot, "references", "subtask-contracts.md"), "utf8"),
		]);
		expect(skill).toContain("## 选择研究方式");
		expect(skill).toContain("MinerU Markdown、OCR、layout 和 model 输出是派生导航材料");
		expect(skill).toContain("不会截断的小页段覆盖全部物理页");
		expect(skill).toContain("12. **非增量 follow-up idea**");
		expect(evidence).toContain("`[论文]`");
		expect(evidence).toContain("`[未知]`");
		expect(contracts).toContain("## 对话输出边界");
		expect(contracts).toContain("严格 12 节报告");
		expect(contracts).not.toContain("`quick`");
		expect(contracts).not.toContain("`methods`");
		expect(contracts).not.toContain("`reproduce`");
	});

	it("loads CCF data after the literature module move", () => {
		expect(lookupCcfLevel("OSDI")).toBe("A");
	});
	it("includes CCF data in npm and release artifacts", async () => {
		const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { files: string[] };
		expect(packageJson.files).toContain("data");
		const releaseWorkflow = await readFile(resolve(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
		expect(releaseWorkflow).toContain("cp -R .github data deployment");
	});

});
