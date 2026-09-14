import { describe, expect, it } from "vitest";
import {
	automatedResearchDepth,
	automatedResearchPlan,
	automatedResearchPrompt,
	automatedResearchThinkingLevel,
} from "../src/research/application/research-automation.ts";
import type { PaperRecord, PaperVersion } from "../src/literature/domain/literature-types.ts";

const paper: PaperRecord = {
	id: "paper-1",
	title: "A Study of Automated Research",
	authors: ["Alice", "Bob"],
	identifiers: { doi: "10.1000/example" },
	links: [],
	provenance: [],
} as unknown as PaperRecord;

const version: PaperVersion = {
	paperId: "paper-1",
	sourceUrl: "https://example.com/a.pdf",
	finalUrl: "https://example.com/a.pdf",
	retrievedAt: "2026-01-01T00:00:00Z",
	sha256: "a".repeat(64),
	bytes: 1024,
	blobPath: "C:/data/download/A Study/A Study.pdf",
	contentType: "application/pdf",
	versionKind: "published",
};

describe("automatedResearchDepth", () => {
	it("接受四种合法深度", () => {
		expect(automatedResearchDepth("quick")).toBe("quick");
		expect(automatedResearchDepth("methods")).toBe("methods");
		expect(automatedResearchDepth("full")).toBe("full");
		expect(automatedResearchDepth("reproduce")).toBe("reproduce");
	});

	it("拒绝未知深度", () => {
		expect(() => automatedResearchDepth("skim")).toThrow("研究深度");
	});
});

describe("automatedResearchPlan", () => {
	it("快速略读不包含方法核验与全文覆盖阶段", () => {
		const plan = automatedResearchPlan("quick", false);
		expect(plan.depthLabel).toBe("快速略读");
		expect(plan.stages.map((stage) => stage.id)).toEqual(["identity", "skim", "report"]);
	});

	it("全文研究包含方法核验与全文覆盖阶段", () => {
		const plan = automatedResearchPlan("full", true);
		expect(plan.stages.map((stage) => stage.id)).toEqual([
			"identity",
			"skim",
			"methods",
			"coverage",
			"artifacts",
			"report",
		]);
		expect(plan.readOnly).toBe(true);
	});

	it("复现准备包含复现计划阶段", () => {
		const plan = automatedResearchPlan("reproduce", false);
		expect(plan.stages.some((stage) => stage.id === "reproduction")).toBe(true);
	});
});

describe("automatedResearchThinkingLevel", () => {
	it("按深度给出默认思考强度", () => {
		expect(automatedResearchThinkingLevel("quick")).toBe("low");
		expect(automatedResearchThinkingLevel("methods")).toBe("medium");
		expect(automatedResearchThinkingLevel("full")).toBe("high");
		expect(automatedResearchThinkingLevel("reproduce")).toBe("high");
	});
});

describe("automatedResearchPrompt", () => {
	it("prompt 携带论文标识、本地 PDF 路径与深度标签", () => {
		const { prompt, plan } = automatedResearchPrompt({
			request: {
				paperId: paper.id,
				namespace: "default",
				depth: "full",
				discoverArtifacts: true,
			},
			paper,
			version,
			localPdfPath: version.blobPath,
		});
		expect(plan.depthLabel).toBe("全文研究");
		expect(prompt).toContain(paper.title);
		expect(prompt).toContain(version.blobPath);
		expect(prompt).toContain(version.sha256);
		expect(prompt).toContain("全文研究 (full)");
		expect(prompt).toContain("paper-research Skill");
	});

	it("关闭 Artifact 发现时明确说明未检查", () => {
		const { prompt } = automatedResearchPrompt({
			request: {
				paperId: paper.id,
				namespace: "default",
				depth: "quick",
				discoverArtifacts: false,
			},
			paper,
			version,
			localPdfPath: version.blobPath,
		});
		expect(prompt).toContain("本次不执行 Artifact 发现");
	});

	it("研究问题超长时报错", () => {
		expect(() =>
			automatedResearchPrompt({
				request: {
					paperId: paper.id,
					namespace: "default",
					depth: "quick",
					researchQuestion: "为什么".repeat(1500),
					discoverArtifacts: false,
				},
				paper,
				version,
				localPdfPath: version.blobPath,
			}),
		).toThrow("研究问题");
	});
});
