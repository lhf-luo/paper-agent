import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerResearchTools } from "../src/research/presentation/research-tools.ts";

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
});
