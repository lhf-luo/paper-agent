import { describe, expect, it } from "vitest";
import { CanvasResearchSearch } from "../src/canvas/application/canvas-research-search.ts";
import { researchFixture } from "./canvas-research-fixture.ts";

describe("canvas supplementation authorization", () => {
	it("blocks unapproved plans even in auto mode, binds namespace and enforces exact query/providers/budget", async () => {
		const f = await researchFixture(),
			s = f.service,
			search = new CanvasResearchSearch(s);
		const run = await s.saveAnalysis({});
		const plan = search.create({
			analysisId: run.id,
			gap: "Missing non-LLM baselines",
			reason: "Compare representations",
			queries: ["state machine checker"],
			providers: ["arxiv"],
			callBudget: 1,
		});
		expect(await search.before("collect_literature", { query: "state machine checker" }, "0")).toContain(
			"等待用户接受",
		);
		search.decide(plan.id, true, plan.revision);
		expect(await search.before("collect_literature", { query: "different" }, "bad")).toContain("查询词");
		expect(await search.before("search_literature", { query: "state machine checker" }, "quick")).toContain(
			"固定使用",
		);
		const input: Record<string, unknown> = {
			query: "state machine checker",
			namespace: "wrong",
			corpus_root: "other",
			max_results_per_provider: 500,
			mode: "persistent",
		};
		expect(await search.before("collect_literature", input, "1")).toBeUndefined();
		expect(input).toMatchObject({
			namespace: "research",
			scope: "personal",
			mode: "once",
			max_results_per_provider: 100,
			reuse_corpus: true,
			auto_expand: false,
		});
		expect(input.corpus_root).toBeUndefined();
		search.after("1", { searchRunId: "search-result" });
		expect(s.records.get("search", plan.id)?.value).toMatchObject({ callsUsed: 1, searchRunIds: ["search-result"] });
		expect(s.records.get("analysis", run.id)?.value).toMatchObject({ searchRunIds: ["search-result"] });
		expect(await search.before("collect_literature", { query: "state machine checker" }, "2")).toContain(
			"预算已用完",
		);
		const local: Record<string, unknown> = { corpus_only: true, namespace: "other" };
		expect(await search.before("collect_literature", local, "local")).toBeUndefined();
		expect(local.namespace).toBe("research");
	});
	it("bounds citation depth and seeds, rejects stale research and oversized plans", async () => {
		const f = await researchFixture(),
			s = f.service,
			search = new CanvasResearchSearch(s);
		const run = await s.saveAnalysis({});
		const plan = search.create({
			analysisId: run.id,
			gap: "Citation lineage",
			reason: "References",
			queries: ["lineage"],
			strategy: "citations",
			providers: ["openalex", "semanticscholar"],
		});
		search.decide(plan.id, true, plan.revision);
		expect(await search.before("expand_citation_network", { seed_ids: ["outside"] }, "bad")).toContain("种子");
		const input = { seed_ids: ["p0"], depth: 2, max_total_neighbors: 1000 };
		expect(await search.before("expand_citation_network", input, "good")).toBeUndefined();
		expect(input).toMatchObject({ depth: 1, max_total_neighbors: 100 });
		s.saveSettings({ question: "Changed" }, -1);
		expect(await search.before("expand_citation_network", input, "stale")).toContain("目标或来源已变化");
		expect(() =>
			search.create({ analysisId: run.id, gap: "Gap", reason: "Reason", queries: ["q"], callBudget: 5 }),
		).toThrow("预算");
	});
});
