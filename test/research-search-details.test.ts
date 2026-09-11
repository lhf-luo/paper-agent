import { describe, expect, it } from "vitest";
import { buildSearchDetails } from "../src/literature/presentation/literature-discovery-tools.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";

describe("search_literature details", () => {
	it("returns persisted source handles and separates discovery from DOI enrichment providers", () => {
		const candidate: PaperRecord = {
			id: "paper-ndss",
			title: "Statically Discover Complex Cross-Entry Use-After-Free Vulnerabilities in the Linux Kernel",
			authors: ["First Author"],
			identifiers: { doi: "10.14722/ndss.2025.240559" },
			links: [{ url: "https://doi.org/10.14722/ndss.2025.240559", kind: "doi" }],
			provenance: [
				{ provider: "openalex", query: "title author", retrievedAt: "2026-09-05T00:00:00.000Z" },
				{ provider: "unpaywall", query: "10.14722/ndss.2025.240559", retrievedAt: "2026-09-05T00:00:01.000Z" },
			],
			mergedFrom: [],
		};
		const run: SearchRun = {
			id: "search-doi",
			startedAt: "2026-09-05T00:00:00.000Z",
			completedAt: "2026-09-05T00:00:02.000Z",
			queries: ["title author"],
			filters: {},
			providers: ["arxiv", "openalex", "crossref"],
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			results: [candidate],
			failures: [{ provider: "crossref", query: "title author", message: "timeout", retryable: true }],
			sourceCounts: { openalex: 1 },
			deduplicatedCount: 1,
			scope: "personal",
			mode: "once",
			namespace: "default",
		};

		const details = buildSearchDetails("title author", run);

		expect(details).toMatchObject({
			searchRunId: "search-doi",
			discoveryProviders: ["arxiv", "openalex", "crossref"],
			enrichmentProviders: ["unpaywall"],
			candidates: [
				expect.objectContaining({
					paperId: "paper-ndss",
					doi: "10.14722/ndss.2025.240559",
					providers: ["openalex", "unpaywall"],
				}),
			],
		});
		expect(details.errors).toEqual(["crossref: timeout"]);
	});
});
