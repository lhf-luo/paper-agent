import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Scenario {
	id: string;
	given: string;
	mustDo: string;
	mustNotDo: string;
	promptEvidence: string[];
}

const expectedScenarioIds = [
	"all-providers-fail",
	"artifact-content-mismatch",
	"artifact-discovery-only",
	"conflicting-numeric-evidence",
	"dirty-artifact-repository",
	"missing-physical-pages",
	"no-artifact-candidate",
	"no-live-model-credentials",
	"ocr-or-poppler-failure",
	"personal-team-separation",
	"provider-partial-failure",
	"search-only-discovery",
	"semantic-asset-unverified",
	"truncated-asset-index",
	"truncated-pdf-read",
	"unknown-tool-parameters",
];

interface ScenarioSet {
	schemaVersion: number;
	evaluationMode: string;
	note: string;
	scenarios: Scenario[];
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("SYSTEM behavior scenarios", () => {
	it("keeps the complete auditable edge-case catalog tied to explicit prompt clauses", async () => {
		const prompt = await readFile(join(repositoryRoot, "src", "SYSTEM.md"), "utf8");
		const scenarioSet = JSON.parse(
			await readFile(join(repositoryRoot, "eval-data", "system-behavior-scenarios.json"), "utf8"),
		) as ScenarioSet;

		expect(scenarioSet.schemaVersion).toBe(1);
		expect(scenarioSet.evaluationMode).toBe("deterministic-contract");
		expect(scenarioSet.note).toContain("must not be reported");
		expect(scenarioSet.scenarios.map((scenario) => scenario.id).sort()).toEqual(expectedScenarioIds);

		for (const scenario of scenarioSet.scenarios) {
			expect(scenario.given.trim().length, scenario.id).toBeGreaterThan(10);
			expect(scenario.mustDo.trim().length, scenario.id).toBeGreaterThan(10);
			expect(scenario.mustNotDo.trim().length, scenario.id).toBeGreaterThan(10);
			expect(scenario.mustDo, scenario.id).not.toBe(scenario.mustNotDo);
			expect(scenario.promptEvidence.length, scenario.id).toBeGreaterThan(0);
			for (const fragment of scenario.promptEvidence) {
				expect(fragment.trim().length, scenario.id).toBeGreaterThan(1);
				expect(prompt, `${scenario.id}: ${fragment}`).toContain(fragment);
			}
		}
	});
});
