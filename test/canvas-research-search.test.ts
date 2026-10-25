import { describe, expect, it } from "vitest";
import { CanvasSearchSession } from "../src/canvas/application/canvas-search-session.ts";
import { visibleSessionSkills } from "../src/agent/domain/session-skills.ts";
import { researchFixture } from "./canvas-research-fixture.ts";

describe("direct canvas searches", () => {
	it("runs without analyses/plans, enforces budgets and resets only for a new round", async () => {
		const f = await researchFixture(),
			search = new CanvasSearchSession(f.service);
		const input: Record<string, unknown> = {
			query: "security",
			mode: "persistent",
			corpus_root: "other",
			max_results_per_provider: 500,
		};
		expect(await search.before("collect_literature", input)).toBeUndefined();
		expect(input).toMatchObject({
			mode: "once",
			scope: "personal",
			auto_expand: false,
			reuse_corpus: false,
			max_results_per_provider: 100,
		});
		expect(input).not.toHaveProperty("corpus_root");
		expect(f.service.records.list("analysis")).toHaveLength(0);
		for (let i = 1; i < 4; i++) expect(await search.before("search_literature", {})).toBeUndefined();
		expect(await search.before("search_literature", {})).toContain("预算");
		expect(await search.before("get_paper", {})).toBeUndefined();
		search.beginRound();
		expect(await search.before("search_literature", {})).toBeUndefined();
	});
	it("requires library seeds and limits expansion without an approval record", async () => {
		const f = await researchFixture(),
			search = new CanvasSearchSession(f.service);
		expect(await search.before("expand_citation_network", { seed_ids: ["candidate"] })).toContain("个人库");
		const input = { seed_ids: ["p0"], depth: 2, max_total_neighbors: 1000, max_neighbors_per_seed: 500 };
		expect(await search.before("expand_citation_network", input)).toBeUndefined();
		expect(input).toMatchObject({ depth: 1, max_total_neighbors: 100, max_neighbors_per_seed: 100 });
		expect(await search.before("find_author_papers", { paper_id: "candidate" })).toContain("个人库");
	});
	it("filters the corpus workflow only for canvas sessions", () => {
		const skills = [{ name: "canvas-research" }, { name: "literature-corpus-manager" }, { name: "paper-research" }];
		expect(visibleSessionSkills(skills, true).map((s) => s.name)).toEqual(["canvas-research", "paper-research"]);
		expect(visibleSessionSkills(skills, false)).toEqual(skills);
	});
});
