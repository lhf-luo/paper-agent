import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCandidatePaperTable,
	type CollectLiteratureOptions,
	collectionPersistencePlan,
	collectLiterature,
	expandLiteratureQueries,
	planLiteratureSearch,
} from "../src/collection-tools.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature-store.ts";
import type { PaperRecord } from "../src/literature-types.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

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
		title: ["Paper " + index],
		DOI: "10.5555/test." + index,
		URL: "https://doi.org/10.5555/test." + index,
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
	});

	it("keeps once-mode collection out of a clean persistent corpus", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-once-isolation-"));
		temporaryPaths.push(root);
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
		await expect(access(join(root, ".paper-agent"))).rejects.toMatchObject({ code: "ENOENT" });
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
