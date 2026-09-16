import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { rerankByQueryRelevance, searchRelevanceScore } from "../src/literature/domain/literature-relevance.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import {
	buildCandidatePaperTable,
	buildCitationExpansionTable,
	type CollectLiteratureOptions,
	collectionPersistencePlan,
	collectLiterature,
	expandLiteratureQueries,
	planLiteratureSearch,
	tagCitationExpansionRecords,
} from "../src/literature/presentation/collection-tools.ts";
import { OperationConsentManager } from "../src/shared/application/operation-consent.ts";

const temporaryPaths: string[] = [];

async function authorizedCollection(options: CollectLiteratureOptions): Promise<CollectLiteratureOptions> {
	const manager = new OperationConsentManager();
	const prepared = await manager.prepare(collectionPersistencePlan(options));
	const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "test-user");
	return { ...options, authorization: { manager, grant } };
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function crossrefItem(index: number) {
	return {
		title: [`Paper ${index}`],
		DOI: `10.5555/test.${index}`,
		URL: `https://doi.org/10.5555/test.${index}`,
		author: [{ given: "Author", family: String(index) }],
		issued: { "date-parts": [[2024 + index]] },
		type: "proceedings-article",
		"container-title": ["TestConf"],
	};
}

describe("collection workflow", () => {
	it("adds deterministic acronym and hyphenation query variants", () => {
		expect(expandLiteratureQueries("LLM-based program analysis", ["code intelligence"])).toEqual([
			"LLM-based program analysis",
			"code intelligence",
			"LLM based program analysis",
			"large language model-based program analysis",
		]);
	});

	it("plans a structured topic survey before provider search", () => {
		const plan = planLiteratureSearch({
			researchObject: "malware detection",
			researchProblem: "evasion robustness",
			scenario: "Android apps",
			timeRange: "2020-2026",
			domainTerms: ["binary analysis"],
			problemTerms: ["generalization"],
			methodTerms: ["graph neural network", "GNN"],
			primaryQuery: "GNN-based malware detection",
		});

		expect(plan.researchQuestion).toBe("malware detection | evasion robustness | Android apps | 2020-2026");
		expect(plan.keywordGroups).toMatchObject({
			domain: ["malware detection", "binary analysis"],
			problem: ["evasion robustness", "generalization"],
			method: ["graph neural network", "GNN"],
		});
		expect(plan.queryVariants).toContain("GNN-based malware detection");
		expect(plan.queryVariants).toContain("GNN based malware detection");
		expect(plan.unsupportedProviders?.[0]).toMatchObject({ provider: "google-scholar" });
	});

	it("records seed relationships for citation-network expansion tables", () => {
		const seed: PaperRecord = {
			id: "seed-paper",
			title: "Seed Paper",
			authors: ["Ada Researcher"],
			year: 2024,
			identifiers: { openAlexId: "W1" },
			links: [],
			provenance: [{ provider: "openalex", query: "seed", retrievedAt: "2026-01-01T00:00:00.000Z" }],
			mergedFrom: [],
		};
		const neighbor: PaperRecord = {
			id: "neighbor-paper",
			title: "Neighbor Paper",
			authors: ["Grace Researcher"],
			year: 2023,
			venue: "TestConf",
			identifiers: { doi: "10.5555/neighbor" },
			links: [{ url: "https://example.org/neighbor.pdf", kind: "pdf" }],
			provenance: [
				{ provider: "openalex", query: "references:seed-paper", retrievedAt: "2026-01-02T00:00:00.000Z" },
			],
			mergedFrom: [],
		};

		const [tagged] = tagCitationExpansionRecords(
			[neighbor],
			seed,
			"reference",
			"openalex",
			1,
			"2026-01-03T00:00:00.000Z",
		);

		expect(tagged.discoveryPaths).toContainEqual(
			expect.objectContaining({
				kind: "reference-expansion",
				provider: "openalex",
				query: "references:seed-paper",
				seedPaperId: "seed-paper",
				note: "depth=1",
			}),
		);
		expect(buildCitationExpansionTable([tagged])).toEqual([
			expect.objectContaining({
				title: "Neighbor Paper",
				relationship: "reference",
				seedPaperId: "seed-paper",
				depth: "1",
				discoveryPath: expect.stringContaining("reference-expansion"),
				pdf: "https://example.org/neighbor.pdf",
			}),
		]);
	});

	it("paginates Crossref, persists provenance, and avoids repeating an identical search", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-collect-"));
		temporaryPaths.push(root);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const offset = Number(url.searchParams.get("offset") ?? "0");
			const items = offset === 0 ? [crossrefItem(0), crossrefItem(1)] : [crossrefItem(2)];
			return Response.json({ message: { "total-results": 3, items } });
		});
		vi.stubGlobal("fetch", fetcher);
		const options = {
			queries: ["stateful fuzzing"],
			providers: ["crossref" as const],
			filters: { yearFrom: 2020 },
			pagesPerProvider: 2,
			maxResultsPerProvider: 3,
			scope: "personal" as const,
			mode: "persistent" as const,
			namespace: "test",
			cwd: root,
		};

		const first = await collectLiterature(await authorizedCollection(options));
		expect(first.cached).toBe(false);
		expect(first.run.results).toHaveLength(3);
		expect(first.run.results[0].discoveryPaths).toContainEqual(
			expect.objectContaining({ kind: "keyword-search", provider: "crossref", query: "stateful fuzzing" }),
		);
		expect(first.run.candidateTable).toHaveLength(3);
		expect(first.run.candidateTable?.[0]).toMatchObject({
			title: "Paper 0",
			sources: "crossref",
			discoveryPath: expect.stringContaining("keyword-search"),
			screeningResult: "unreviewed",
		});
		expect(first.run.sourceCounts.crossref).toBe(3);
		expect(fetcher).toHaveBeenCalledTimes(2);

		const second = await collectLiterature(await authorizedCollection(options));
		expect(second.cached).toBe(true);
		expect(second.run.results).toHaveLength(3);
		expect(second.run.candidateTable).toHaveLength(3);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(second.corpusPath).toContain(join("personal", "test"));

		const refreshedOptions = { ...options, refreshCache: true };
		const refreshed = await collectLiterature(await authorizedCollection(refreshedOptions));
		expect(refreshed.cached).toBe(false);
		expect(refreshed.run.results).toHaveLength(3);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it("returns successful providers when another source fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-partial-"));
		temporaryPaths.push(root);
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.hostname.includes("arxiv")) throw new Error("temporary arXiv outage");
			return Response.json({ message: { "total-results": 1, items: [crossrefItem(9)] } });
		});

		const result = await collectLiterature({
			queries: ["protocol fuzzing"],
			providers: ["arxiv", "crossref"],
			filters: {},
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			scope: "personal",
			mode: "once",
			namespace: "default",
			cwd: root,
		});

		expect(result.run.results).toHaveLength(1);
		expect(result.run.failures).toMatchObject([
			{ provider: "arxiv", query: "protocol fuzzing", message: "temporary arXiv outage" },
		]);
		expect(result.run.coverage).toMatchObject({
			status: "partial",
			plannedQueryCount: 1,
			executedQueryCount: 1,
			failedExecutionCount: 1,
			skippedExecutionCount: 0,
		});
		expect(result.run.executions).toMatchObject([
			{ provider: "arxiv", query: "protocol fuzzing", status: "failed", resultCount: 0 },
			{ provider: "crossref", query: "protocol fuzzing", status: "succeeded", resultCount: 1 },
		]);
	});

	it("deduplicates exact normalized title and first-author matches while retaining identifier conflicts", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-metadata-deduplication-"));
		temporaryPaths.push(root);
		const record = (id: string, title: string, firstAuthor: string, year: number, doi?: string): PaperRecord => ({
			id,
			title,
			authors: [firstAuthor],
			year,
			identifiers: doi ? { doi } : {},
			links: doi ? [{ url: `https://doi.org/${doi}`, kind: "doi" }] : [],
			provenance: [
				{
					provider: "crossref",
					query: "metadata identity",
					retrievedAt: "2026-09-15T00:00:00Z",
					providerRecordId: id,
				},
			],
			mergedFrom: [],
		});
		const result = await collectLiterature({
			queries: ["metadata identity"],
			providers: ["crossref"],
			filters: {},
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			scope: "personal",
			mode: "once",
			namespace: "default",
			cwd: root,
			reuseCorpus: false,
			providerPageSearch: async () => ({
				provider: "crossref",
				query: "metadata identity",
				requestUrl: "https://example.test/provider-search",
				records: [
					record("metadata-only", "Agentic Kernel Repair", "Chenyuan Yang", 2024),
					record("formal", "agentic-kernel repair", "Yang, Chenyuan", 2025, "10.1000/formal"),
					record("conflict", "Agentic Kernel Repair", "Chenyuan Yang", 2026, "10.1000/conflict"),
				],
			}),
		});

		expect(result.run.results).toHaveLength(2);
		expect(result.run.deduplicatedCount).toBe(1);
		expect(result.run.possibleDuplicates).toMatchObject([{ reason: "identity-conflict", titleSimilarity: 1 }]);
	});

	it("persists page-level failures without discarding successful provider records", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-provider-partial-"));
		temporaryPaths.push(root);
		const record: PaperRecord = {
			id: "usenix-paper",
			title: "USENIX Paper",
			authors: ["Ada Researcher"],
			year: 2025,
			identifiers: {},
			links: [{ url: "https://www.usenix.org/example.pdf", kind: "pdf", openAccess: true }],
			provenance: [{ provider: "usenix", query: "systems", retrievedAt: "2026-01-01T00:00:00.000Z" }],
			mergedFrom: [],
		};
		const result = await collectLiterature({
			queries: ["systems"],
			providers: ["usenix"],
			filters: {},
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			scope: "personal",
			mode: "once",
			namespace: "default",
			cwd: root,
			providerPageSearch: async () => ({
				provider: "usenix",
				query: "systems",
				records: [record],
				requestUrl: "https://www.usenix.org/search/site/systems",
				failures: [
					{
						provider: "usenix",
						query: "systems",
						message: "one detail page timed out",
						retryable: true,
					},
				],
			}),
		});
		expect(result.run.results).toHaveLength(1);
		expect(result.run.failures).toHaveLength(1);
		expect(result.run.providerHealth?.usenix).toMatchObject({ status: "partial", failureCount: 1 });
		expect(result.run.executions).toMatchObject([{ provider: "usenix", status: "partial", resultCount: 1 }]);
		const stored = await new LiteratureStore(
			resolveCorpusRoot(root, "personal", "default"),
			"personal",
			"default",
		).getSearchRun(result.run.id);
		expect(stored?.failures).toHaveLength(1);
	});

	it("keeps once-mode collection out of a clean persistent corpus", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-once-isolation-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		let calls = 0;
		const result = await collectLiterature({
			queries: ["ephemeral evidence collection"],
			providers: ["dblp"],
			filters: {},
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			scope: "personal",
			mode: "once",
			namespace: "default",
			cwd: root,
			reuseCorpus: true,
			providerPageSearch: async (provider, options) => {
				calls++;
				return {
					provider,
					query: options.query,
					records: [],
					requestUrl: "https://example.test/provider-search",
				};
			},
		});

		expect(result.run.mode).toBe("once");
		expect(calls).toBe(1);
		// once 模式落盘 search-run(供 filter/save 复用), 但 records 语料保持空(论文不入库)
		expect(await store.listPapers()).toEqual([]);
		const savedRun = await store.getSearchRun(result.run.id);
		expect(savedRun?.id).toBe(result.run.id);
	});

	it("ranks exact query-title matches ahead of provider arrival order", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-relevance-"));
		temporaryPaths.push(root);
		const exactTitle =
			"ProtocolGuard: Detecting Protocol Non-compliance Bugs via LLM-guided Static Analysis and Dynamic Verification";
		const decoy = (index: number): PaperRecord => ({
			id: `decoy-${index}`,
			title: `A Survey of Protocol Testing Techniques ${index}`,
			authors: ["Grace Researcher"],
			year: 2024,
			identifiers: {},
			links: [],
			provenance: [{ provider: "arxiv", query: exactTitle, retrievedAt: "2026-01-01T00:00:00.000Z" }],
			mergedFrom: [],
		});
		const exact: PaperRecord = {
			id: "exact-paper",
			title: exactTitle,
			authors: ["Ada Researcher"],
			year: 2025,
			identifiers: {},
			links: [],
			provenance: [{ provider: "crossref", query: exactTitle, retrievedAt: "2026-01-01T00:00:00.000Z" }],
			mergedFrom: [],
		};
		const result = await collectLiterature({
			queries: [exactTitle],
			providers: ["arxiv", "crossref"],
			filters: {},
			pagesPerProvider: 1,
			maxResultsPerProvider: 5,
			scope: "personal",
			mode: "once",
			namespace: "default",
			cwd: root,
			providerPageSearch: async (provider, options) => ({
				provider,
				query: options.query,
				records: provider === "arxiv" ? [decoy(0), decoy(1)] : [exact],
				requestUrl: "https://example.test/provider-search",
			}),
		});

		expect(result.run.results.map((record) => record.title)).toEqual([exactTitle, decoy(0).title, decoy(1).title]);
	});

	it("scores relevance by query-token coverage over title and abstract", () => {
		const query = "ProtocolGuard: Detecting Protocol Non-compliance Bugs via LLM-guided Static Analysis";
		const exact: PaperRecord = {
			id: "exact",
			title: "ProtocolGuard: Detecting Protocol Non-compliance Bugs via LLM-guided Static Analysis",
			authors: [],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		};
		const titlePartial: PaperRecord = {
			id: "partial",
			title: "Detecting Protocol Bugs in TLS Stacks",
			authors: [],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		};
		const abstractOnly: PaperRecord = {
			id: "abstract-only",
			title: "Unrelated Systems Paper",
			abstract: "We study static analysis for detecting protocol non-compliance bugs.",
			authors: [],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		};
		const unrelated: PaperRecord = {
			id: "unrelated",
			title: "Deep Learning for Weather Forecasting",
			authors: [],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		};

		expect(searchRelevanceScore(exact, [query])).toBe(1);
		expect(searchRelevanceScore(titlePartial, [query])).toBeGreaterThan(searchRelevanceScore(abstractOnly, [query]));
		expect(searchRelevanceScore(unrelated, [query])).toBe(0);
		expect(rerankByQueryRelevance([unrelated, abstractOnly, titlePartial, exact], [query]).map((r) => r.id)).toEqual([
			"exact",
			"partial",
			"abstract-only",
			"unrelated",
		]);
	});

	it("applies publication type and open-access filters when reusing the corpus", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-corpus-filter-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "test"), "personal", "test");
		const record = (id: string, publicationType: string, openAccess: boolean): PaperRecord => ({
			id,
			title: `Program analysis ${id}`,
			authors: ["Ada Researcher"],
			publicationType,
			identifiers: {},
			links: [{ url: `https://example.org/${id}.pdf`, kind: "pdf", openAccess }],
			provenance: [{ provider: "local-pdf", query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		});
		await store.upsertPaper(record("conference-paper", "Conference", true));
		await store.upsertPaper(record("journal-paper", "Journal", false));

		const result = await collectLiterature({
			queries: ["program analysis"],
			providers: [],
			filters: { types: ["conference"], openAccess: true },
			pagesPerProvider: 1,
			maxResultsPerProvider: 20,
			scope: "personal",
			mode: "once",
			namespace: "test",
			cwd: root,
			corpusOnly: true,
		});

		expect(result.run.results).toHaveLength(1);
		expect(result.run.results[0]).toMatchObject({ publicationType: "Conference" });
		expect(result.run.results[0].discoveryPaths).toContainEqual(
			expect.objectContaining({ kind: "corpus-reuse", query: "program analysis" }),
		);
		expect(buildCandidatePaperTable(result.run.results)[0]).toMatchObject({
			title: "Program analysis conference-paper",
			discoveryPath: expect.stringContaining("corpus-reuse"),
			pdf: "https://example.org/conference-paper.pdf",
		});
		expect(result.run.results[0].links).toContainEqual(expect.objectContaining({ kind: "pdf", openAccess: true }));
	});
});
