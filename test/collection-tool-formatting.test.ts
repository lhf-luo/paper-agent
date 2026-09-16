import { describe, expect, it } from "vitest";
import type { CollectionResult } from "../src/literature/application/literature-collection.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";
import { formatCollection } from "../src/literature/presentation/collection-tool-formatting.ts";

function paper(index: number): PaperRecord {
	return {
		id: `paper-${index}`,
		title: `Candidate title ${index}`,
		authors: [`Sensitive Author ${index}`],
		year: 2024,
		venue: "Sensitive Venue",
		identifiers: { doi: `10.5555/sensitive.${index}` },
		links: [
			{ kind: "pdf", url: `https://example.test/${index}.pdf` },
			{ kind: "artifact", url: `https://example.test/code/${index}` },
		],
		provenance: [
			{
				provider: "crossref",
				query: "sensitive provider query",
				retrievedAt: "2026-09-15T00:00:00.000Z",
			},
		],
		discoveryPaths: [
			{
				kind: "keyword-search",
				provider: "crossref",
				query: "sensitive discovery path",
				discoveredAt: "2026-09-15T00:00:00.000Z",
			},
		],
		mergedFrom: [],
		curation: {
			tags: [],
			userNotes: [],
			screening: {
				status: "unreviewed",
				updatedBy: "Agent",
				updatedAt: "2026-09-15T00:00:00.000Z",
			},
		},
	};
}

describe("collect_literature output formatting", () => {
	it("returns one bounded Paper ID/title list while preserving operational status", () => {
		const records = Array.from({ length: 81 }, (_, index) => paper(index));
		const run: SearchRun = {
			id: "search-formatting",
			startedAt: "2026-09-15T00:00:00.000Z",
			completedAt: "2026-09-15T00:01:00.000Z",
			queries: ["kernel security"],
			filters: {},
			providers: ["crossref"],
			pagesPerProvider: 1,
			maxResultsPerProvider: 100,
			results: records,
			failures: [
				{
					provider: "crossref",
					query: "kernel security",
					message: "provider failed",
					retryable: true,
				},
			],
			sourceCounts: { crossref: 81 },
			deduplicatedCount: 4,
			corpusHitCount: 3,
			possibleDuplicates: [
				{ leftId: "paper-0", rightId: "paper-1", titleSimilarity: 0.97, reason: "similar-title" },
			],
			coverage: {
				plannedQueryCount: 2,
				executedQueryCount: 1,
				failedExecutionCount: 1,
				skippedExecutionCount: 1,
				status: "partial",
			},
			executions: [
				{
					query: "second query",
					provider: "crossref",
					status: "skipped",
					resultCount: 0,
					message: "provider stopped",
				},
			],
			scope: "personal",
			mode: "once",
			namespace: "default",
		};
		const result: CollectionResult = { run, cached: false, corpusPath: "D:/corpus" };

		const output = formatCollection(result, 80);

		expect(output.match(/paper_id=/g)).toHaveLength(80);
		expect(output).toContain("1. paper_id=paper-0 | title=Candidate title 0");
		expect(output).toContain("80. paper_id=paper-79 | title=Candidate title 79");
		expect(output).not.toContain("paper_id=paper-80");
		expect(output.split("Candidate title 0")).toHaveLength(2);
		expect(output).toContain("[Showing the first 80 of 81 candidate titles from search run search-formatting.]");
		expect(output).toContain("Search coverage: partial");
		expect(output).toContain("Possible duplicates (not merged):");
		expect(output).toContain("provider failed");
		expect(output).toContain("provider stopped");
		for (const hidden of [
			"Sensitive Author",
			"Sensitive Venue",
			"10.5555/sensitive",
			"sensitive provider query",
			"sensitive discovery path",
			"unreviewed",
			"example.test",
		]) {
			expect(output).not.toContain(hidden);
		}
	});
});
