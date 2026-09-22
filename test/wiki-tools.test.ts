import { describe, expect, it } from "vitest";
import { registerWikiTools } from "../src/wiki/presentation/wiki-tools.ts";

describe("research Wiki tools", () => {
	it("registers the ingest, query, and lint surface", () => {
		const tools: string[] = [];
		registerWikiTools({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
		expect(tools).toEqual([
			"search_research_wiki",
			"ingest_research_wiki",
			"lint_research_wiki",
			"delete_research_wiki_source_pages",
		]);
	});
});
