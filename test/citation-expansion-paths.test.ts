import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as providers from "../src/literature/infrastructure/literature-providers.ts";
import { registerCitationExpansionTool } from "../src/literature/presentation/citation-expansion-tool.ts";
import { collectRegisteredTools } from "../src/shared/presentation/agent-tool-catalog.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { researchFixture } from "./canvas-research-fixture.ts";

afterEach(() => vi.restoreAllMocks());
it("retains multiple obtained citation paths and seed-to-seed relationships without additional provider calls", async () => {
	const f = await researchFixture(2);
	const seeds = f.papers.map((p, i) => ({
		...p,
		identifiers: { ...p.identifiers, openAlexId: `W${i + 1}` },
		referencedWorks: ["W3"],
	}));
	await f.library.upsertPapers(seeds);
	const neighbor: PaperRecord = {
		id: "neighbor",
		title: "Shared citation neighbor",
		authors: ["Researcher"],
		identifiers: { openAlexId: "W3" },
		links: [],
		mergedFrom: [],
		provenance: [{ provider: "openalex", query: "references", retrievedAt: new Date().toISOString() }],
	};
	vi.spyOn(providers, "searchSemanticScholarCitations").mockResolvedValue({
		records: [],
		nextCursor: undefined,
	} as never);
	const fetch = vi
		.spyOn(providers, "fetchOpenAlexWorks")
		.mockResolvedValueOnce([neighbor, seeds[1]])
		.mockResolvedValueOnce([neighbor, seeds[0]]);
	const tool = collectRegisteredTools(registerCitationExpansionTool)[0];
	const result = await tool.execute(
		"paths",
		{
			seed_ids: ["p0", "p1"],
			direction: "references",
			max_neighbors_per_seed: 10,
			max_total_neighbors: 20,
			corpus_root: dirname(f.library.root),
		} as never,
		undefined,
		undefined,
		{ cwd: f.root } as never,
	);
	const id = (result.details as { expansionRunId: string }).expansionRunId,
		run = await f.library.getSearchRun(id);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(run?.results).toHaveLength(3);
	expect(result.details).toMatchObject({ seedCount: 2, neighborCount: 1, resultCount: 3 });
	expect(
		run?.results
			.find((p) => p.id === "neighbor")
			?.discoveryPaths?.map((p) => p.seedPaperId)
			.sort(),
	).toEqual(["p0", "p1"]);
	expect(run?.seedSnapshots?.find((p) => p.id === "p0")?.discoveryPaths).toContainEqual(
		expect.objectContaining({ kind: "reference-expansion", seedPaperId: "p1" }),
	);
	expect((await f.library.getPaper("p0"))?.discoveryPaths ?? []).toEqual([]);
});

it.each(["empty", "failed"])(
	"queries Semantic Scholar after an OpenAlex %s response and saves the combined run",
	async (mode) => {
		const f = await researchFixture(1);
		await f.library.upsertPapers([
			{ ...f.papers[0], identifiers: { doi: "10.1234/test", openAlexId: "W1", semanticScholarId: "s1" } },
		]);
		const open = vi.spyOn(providers, "searchOpenAlexCitations");
		if (mode === "failed") open.mockRejectedValue(new Error("rate limited"));
		else open.mockResolvedValue({ records: [], nextCursor: undefined } as never);
		const scholar = vi.spyOn(providers, "searchSemanticScholarCitations").mockResolvedValue({
			records: [
				{
					...f.papers[0],
					id: "found",
					identifiers: { semanticScholarId: "s2" },
					provenance: [{ provider: "semanticscholar", query: "citation", retrievedAt: new Date().toISOString() }],
				},
			],
			nextCursor: undefined,
		} as never);
		const tool = collectRegisteredTools(registerCitationExpansionTool)[0];
		const result = await tool.execute(
			"fallback",
			{ seed_ids: ["p0"], direction: "citations", corpus_root: dirname(f.library.root) },
			undefined,
			undefined,
			{ cwd: f.root } as never,
		);
		const run = await f.library.getSearchRun((result.details as { expansionRunId: string }).expansionRunId);
		expect(scholar).toHaveBeenCalledTimes(1);
		expect(run?.results.map((p) => p.id)).toEqual(["p0", "found"]);
		expect(run?.providers).toEqual(["openalex", "semanticscholar"]);
		expect(run?.failures).toHaveLength(mode === "failed" ? 1 : 0);
		expect(await f.library.listPapers()).toHaveLength(1);
	},
);

it("includes the seed outside the year filter without consuming the 18-neighbor budget", async () => {
	const f = await researchFixture(1);
	await f.library.upsertPapers([{ ...f.papers[0], identifiers: { openAlexId: "W1" }, referencedWorks: ["W2"] }]);
	const neighbors = Array.from({ length: 18 }, (_, i) => ({
		...f.papers[0],
		id: `n${i}`,
		year: 2026,
		identifiers: { openAlexId: `W${i + 2}` },
	}));
	vi.spyOn(providers, "fetchOpenAlexWorks").mockResolvedValue(neighbors);
	const tool = collectRegisteredTools(registerCitationExpansionTool)[0];
	const result = await tool.execute(
		"seed",
		{
			seed_ids: ["p0", "p0", "missing"],
			direction: "references",
			year_from: 2026,
			max_neighbors_per_seed: 18,
			max_total_neighbors: 18,
			corpus_root: dirname(f.library.root),
		},
		undefined,
		undefined,
		{ cwd: f.root } as never,
	);
	expect(result.details).toMatchObject({
		seedCount: 1,
		neighborCount: 18,
		resultCount: 19,
		missingSeedIds: ["missing"],
	});
	const run = await f.library.getSearchRun((result.details as { expansionRunId: string }).expansionRunId);
	expect(run?.results[0]).toMatchObject({ id: "p0", year: 2020 });
	expect(run?.deduplicatedCount).toBe(19);
	expect(run?.sourceCounts.openalex).toBe(0);
	expect((result.details as { expansionTable: { relationship: string }[] }).expansionTable[0].relationship).toBe(
		"seed",
	);
});
it("saves seed-only runs on provider failure without falsely reporting neighbors", async () => {
	const f = await researchFixture(1);
	await f.library.upsertPapers([{ ...f.papers[0], identifiers: { semanticScholarId: "s1" } }]);
	vi.spyOn(providers, "searchSemanticScholarCitations").mockRejectedValue(new Error("provider unavailable"));
	const tool = collectRegisteredTools(registerCitationExpansionTool)[0];
	const result = await tool.execute(
		"seed",
		{ seed_ids: ["p0"], direction: "citations", corpus_root: dirname(f.library.root) },
		undefined,
		undefined,
		{ cwd: f.root } as never,
	);
	expect(result.details).toMatchObject({ seedCount: 1, neighborCount: 0, resultCount: 1 });
	expect((result.details as { failures: string[] }).failures).toHaveLength(1);
});
