import { describe, expect, it } from "vitest";
import { filterGroup, filterTableLines } from "../src/literature/application/literature-filtering.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";

function paper(id: string, title: string, abstract?: string): PaperRecord {
	return {
		id,
		title,
		abstract,
		authors: [],
		identifiers: {},
		links: [],
		provenance: [],
		mergedFrom: [],
	};
}

function run(results: PaperRecord[]): SearchRun {
	return {
		id: "filter-run",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		queries: ["security"],
		filters: {},
		providers: [],
		pagesPerProvider: 1,
		maxResultsPerProvider: 20,
		results,
		failures: [],
		sourceCounts: {},
		deduplicatedCount: 0,
		scope: "personal",
		mode: "once",
		namespace: "default",
	};
}

describe("filterGroup", () => {
	it("uses separate abstract and title-only rules", () => {
		const result = filterGroup(
			run([
				paper("matched", "Linux kernel analysis", "Detects use after free bugs"),
				paper("excluded", "Linux kernel analysis", "Studies scheduling"),
				paper("unresolved", "Linux kernel analysis"),
			]),
			{
				withAbstract: {
					includeTermGroups: [
						["linux", "bsd"],
						["use after free", "uaf"],
					],
				},
				withoutAbstract: { includeTerms: ["linux"] },
			},
		);

		expect(result.matched.map((entry) => entry.record.id)).toEqual(["matched"]);
		expect(result.unresolved.map((entry) => entry.record.id)).toEqual(["unresolved"]);
		expect(result.excluded).toBe(1);
	});

	it("uses include_terms OR and excludes abstractless records without a positive title rule", () => {
		const result = filterGroup(
			run([paper("one", "Linux", "kernel"), paper("two", "Windows"), paper("three", "Linux")]),
			{
				withAbstract: { includeTerms: ["linux", "bsd"] },
				withoutAbstract: {},
			},
		);
		expect(result.matched.map((entry) => entry.record.id)).toEqual(["one"]);
		expect(result.unresolved).toEqual([]);
		expect(result.excluded).toBe(2);
	});

	it("renders every retained Paper ID and title without bibliographic fields", () => {
		const lines = filterTableLines([
			{ paperId: "paper-a", title: "Linux security", status: "matched" },
			{ paperId: "paper-b", title: "BSD security", status: "unresolved" },
		]).join("\n");
		expect(lines).toContain("paper_id=paper-a | title=Linux security");
		expect(lines).toContain("paper_id=paper-b | title=BSD security");
		expect(lines).not.toContain("DOI");
	});
});
