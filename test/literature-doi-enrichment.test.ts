import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { savePaperAgentConfig } from "../src/config/application/config-service.ts";
import { defaultPaperAgentConfig } from "../src/config/domain/config-validation.ts";
import { enrichRecordsByDoi } from "../src/literature/application/literature-doi-enrichment.ts";
import type { LiteratureProvider, PaperRecord } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
	return {
		id: "selected-paper",
		title: "Original title",
		authors: ["Original Author"],
		identifiers: { doi: "10.1000/EXAMPLE" },
		links: [],
		provenance: [],
		mergedFrom: [],
		...overrides,
	};
}

async function configuredRoot(providers: LiteratureProvider[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-doi-enrichment-"));
	temporaryPaths.push(root);
	const config = defaultPaperAgentConfig();
	config.search.doiEnrichmentProviders = providers;
	await savePaperAgentConfig(root, config);
	return root;
}

describe("DOI enrichment", () => {
	it("fills missing fields without replacing the selected identity, title, or authors", async () => {
		const root = await configuredRoot(["crossref", "openalex", "semanticscholar", "opencitations", "unpaywall"]);
		const lookup = vi.fn(async (provider: LiteratureProvider, doi: string) =>
			paper({
				id: `${provider}-record`,
				title: "Provider title",
				authors: ["Provider Author"],
				abstract: provider === "crossref" ? "Provider abstract" : undefined,
				year: provider === "crossref" ? 2026 : undefined,
				venue: provider === "crossref" ? "TestConf" : undefined,
				publicationType: provider === "crossref" ? "conference-paper" : undefined,
				citationCount: provider === "openalex" ? 12 : undefined,
				identifiers: { doi, openAlexId: provider === "openalex" ? "W1" : undefined },
				links:
					provider === "openalex"
						? [{ kind: "pdf", url: "https://example.org/paper.pdf", openAccess: true }]
						: [{ kind: "doi", url: `https://doi.org/${doi}` }],
				provenance: [{ provider, query: doi, retrievedAt: "2026-09-02T00:00:00.000Z", providerRecordId: provider }],
			}),
		);

		const result = await enrichRecordsByDoi([paper()], root, { lookup });

		expect(lookup).toHaveBeenCalledTimes(2);
		expect(result.records[0]).toMatchObject({
			id: "selected-paper",
			title: "Original title",
			authors: ["Original Author"],
			abstract: "Provider abstract",
			year: 2026,
			venue: "TestConf",
			citationCount: 12,
			identifiers: { doi: "10.1000/EXAMPLE", openAlexId: "W1" },
		});
		expect(result.attempts.every((attempt) => attempt.status === "matched")).toBe(true);
	});

	it("does not query providers when all useful enrichment fields already exist", async () => {
		const root = await configuredRoot(["crossref", "openalex", "opencitations", "unpaywall"]);
		const lookup = vi.fn();
		const result = await enrichRecordsByDoi(
			[
				paper({
					abstract: "Complete abstract",
					year: 2026,
					venue: "TestConf",
					publicationType: "conference-paper",
					citationCount: 5,
					links: [{ kind: "pdf", url: "https://example.org/paper.pdf", openAccess: true }],
				}),
			],
			root,
			{ lookup },
		);

		expect(lookup).not.toHaveBeenCalled();
		expect(result.skippedComplete).toBe(1);
		expect(result.records[0].links).toContainEqual({ kind: "doi", url: "https://doi.org/10.1000/example" });
	});

	it("does not treat an open-access landing page as a downloadable PDF location", async () => {
		const root = await configuredRoot(["openalex", "unpaywall"]);
		const lookup = vi.fn(async (provider: LiteratureProvider, doi: string) =>
			paper({
				identifiers: { doi },
				links:
					provider === "unpaywall"
						? [{ kind: "pdf", url: "https://example.org/open.pdf", openAccess: true }]
						: [{ kind: "landing", url: "https://example.org/article", openAccess: true }],
			}),
		);
		const complete = paper({
			abstract: "Complete abstract",
			year: 2026,
			venue: "TestConf",
			publicationType: "conference-paper",
			citationCount: 5,
			links: [{ kind: "landing", url: "https://example.org/article", openAccess: true }],
		});

		const result = await enrichRecordsByDoi([complete], root, { lookup });

		expect(lookup).toHaveBeenCalledTimes(2);
		expect(result.records[0].links).toContainEqual({
			kind: "pdf",
			url: "https://example.org/open.pdf",
			openAccess: true,
		});
	});

	it("treats provider failures and DOI mismatches as non-blocking warnings", async () => {
		const root = await configuredRoot(["crossref", "openalex"]);
		const original = paper();
		const result = await enrichRecordsByDoi([original, paper({ id: "without-doi", identifiers: {} })], root, {
			lookup: async (provider) => {
				if (provider === "crossref") throw new Error("rate limited");
				return paper({ identifiers: { doi: "10.1000/different" }, year: 2025 });
			},
		});

		expect(result.records[0]).toMatchObject({
			...original,
			links: [{ kind: "doi", url: "https://doi.org/10.1000/example" }],
		});
		expect(result.warnings).toHaveLength(2);
		expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
		expect(result.skippedWithoutDoi).toBe(1);
	});
});
