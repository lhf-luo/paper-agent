import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { CorpusScope, SearchRun } from "../src/literature/domain/literature-types.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function run(index: number, scope: CorpusScope): SearchRun {
	const time = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
	return {
		id: `search-${index}`,
		startedAt: time,
		completedAt: time,
		queries: [`query-${index}`],
		filters: {},
		providers: ["arxiv"],
		pagesPerProvider: 1,
		maxResultsPerProvider: 20,
		results:
			index === 0
				? [
						{
							id: "old-candidate",
							title: "First search candidate",
							authors: ["Researcher"],
							identifiers: {},
							links: [],
							mergedFrom: [],
							provenance: [{ provider: "arxiv", query: "query-0", retrievedAt: time }],
						},
					]
				: [],
		failures: [],
		sourceCounts: { arxiv: index === 0 ? 1 : 0 },
		deduplicatedCount: 0,
		scope,
		mode: "once",
	};
}

describe("unlimited Search Run history", () => {
	it.each(["personal", "team"] as const)(
		"retains old candidates after more than 30 saves in %s storage",
		async (scope) => {
			const root = await mkdtemp(join(tmpdir(), "paper-agent-search-history-"));
			roots.push(root);
			const corpusRoot = resolveCorpusRoot(root, scope);
			const store = new LiteratureStore(corpusRoot, scope);
			for (let index = 0; index < 31; index++) await store.saveSearchRun(run(index, scope));
			await store.persistSearchRun({ ...run(31, scope), mode: "persistent" });
			const updated = { ...run(0, scope), queries: ["updated query"] };
			await store.saveSearchRun(updated);
			const reopened = new LiteratureStore(corpusRoot, scope);
			expect(await reopened.listSearchRuns()).toHaveLength(32);
			expect(await reopened.getSearchRun("search-0")).toEqual(updated);
			expect((await reopened.getSearchRun("search-31"))?.mode).toBe("persistent");
		},
	);
});
