import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requestInteractiveOperationAuthorization } from "../src/app/presentation/interactive-operation-consent.ts";
import { savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { OperationPlan } from "../src/shared/application/operation-consent.ts";
import {
	defaultOperationConfirmationSettings,
	requiresOperationConfirmation,
} from "../src/shared/domain/operation-confirmation.ts";

const personalWrite: OperationPlan = {
	kind: "personal-corpus-write",
	summary: "Save one paper",
	targets: [{ label: "paper", value: "paper-1", risk: "medium" }],
	details: { paperIds: ["paper-1"] },
};

describe("operation confirmation policy", () => {
	it("uses low-interruption defaults while retaining destructive and material confirmations", () => {
		const settings = defaultOperationConfirmationSettings();
		expect(requiresOperationConfirmation("personal-corpus-write", "agent", settings)).toBe(false);
		expect(requiresOperationConfirmation("personal-corpus-write", "web", settings)).toBe(false);
		expect(requiresOperationConfirmation("personal-paper-remove", "agent", settings)).toBe(true);
		expect(requiresOperationConfirmation("personal-collection-remove", "web", settings)).toBe(true);
		expect(requiresOperationConfirmation("research-memory-write", "web", settings)).toBe(true);
		expect(requiresOperationConfirmation("artifact-acquisition", "agent", settings)).toBe(true);
		expect(requiresOperationConfirmation("wiki-write", "agent", settings)).toBe(true);
		expect(requiresOperationConfirmation("configuration-write", "web", settings)).toBe(true);
	});

	it("auto-authorizes an Agent ordinary write without requiring a UI", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-confirmation-auto-"));
		const confirm = vi.fn(async () => true);
		const authorization = await requestInteractiveOperationAuthorization(
			{ cwd: root, hasUI: false, ui: { confirm } },
			personalWrite,
			{ title: "Save?", unavailableMessage: "UI required" },
		);
		await authorization.manager.consume(authorization.grant, personalWrite);
		expect(confirm).not.toHaveBeenCalled();
		expect(await readFile(join(root, ".paper-agent", "audit", "operations.jsonl"), "utf8")).toContain(
			'"confirmedBy":"local-confirmation-policy"',
		);
	});

	it("honors an enabled Agent write switch and always requires UI for system operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-confirmation-prompt-"));
		const config = {
			version: 1 as const,
			interface: { port: 0, openBrowser: false },
			storage: { defaultNamespace: "default" },
			agent: { builtinTools: [] },
			confirmations: {
				...defaultOperationConfirmationSettings(),
				requireAgentWriteConfirmation: true,
			},
			search: {
				providers: ["arxiv"],
				doiEnrichmentProviders: ["crossref"],
				maxResultsPerProvider: 20,
				pagesPerProvider: 1,
				queryExpansions: [],
				reuseCorpus: true,
			},
			updatedAt: new Date().toISOString(),
		};
		await savePaperAgentConfig(root, config);
		await expect(
			requestInteractiveOperationAuthorization(
				{ cwd: root, hasUI: false, ui: { confirm: async () => true } },
				personalWrite,
				{ title: "Save?", unavailableMessage: "UI required" },
			),
		).rejects.toThrow("UI required");
		await expect(
			requestInteractiveOperationAuthorization(
				{ cwd: root, hasUI: false, ui: { confirm: async () => true } },
				{ ...personalWrite, kind: "configuration-write" },
				{ title: "Configure?", unavailableMessage: "System UI required" },
			),
		).rejects.toThrow("System UI required");
	});
});
