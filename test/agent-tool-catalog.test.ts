import { describe, expect, it } from "vitest";
import paperAgentExtension from "../src/index.ts";
import {
	AgentToolCatalog,
	collectRegisteredTools,
	type RegisteredAgentTool,
} from "../src/shared/presentation/agent-tool-catalog.ts";

describe("agent tool catalog", () => {
	it("lists the actual extension tools without executing them", () => {
		const tools = collectRegisteredTools(paperAgentExtension);
		const names = tools.map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(["inspect_agent_tools", "read_pdf", "ingest_research_wiki"]));
		expect(new Set(names).size).toBe(names.length);
	});

	it("searches by capability and returns exact parameter metadata on request", () => {
		const catalog = new AgentToolCatalog();
		const tools = collectRegisteredTools(paperAgentExtension);
		for (const tool of tools) catalog.add(tool as RegisteredAgentTool);
		expect(catalog.find("MinerU").map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["generate_mineru_material", "read_mineru_material"]),
		);
		const exact = catalog.find(undefined, "read_pdf")[0];
		expect(exact?.parameters).toBeDefined();
		expect(exact?.promptGuidelines.length).toBeGreaterThan(0);
	});
});
