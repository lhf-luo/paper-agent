import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectLiterature } from "../src/literature/application/literature-collection.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { collectionParameters, optionsFromParams } from "../src/literature/presentation/collection-tool-formatting.ts";
import { registerLiteratureDiscoveryTools } from "../src/literature/presentation/literature-discovery-tools.ts";
import { searchArxivPage } from "../src/literature/infrastructure/provider-arxiv.ts";

const paths: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(id: string, title: string): PaperRecord {
	return {
		id,
		title,
		abstract: "Available abstract",
		authors: [id],
		year: 2026,
		identifiers: {},
		links: [],
		provenance: [],
		mergedFrom: [],
	};
}

describe("generic search and news boundaries", () => {
	it("keeps year-only multi-source search, relevance ranking and optional corpus reuse", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-boundary-"));
		paths.push(root);
		const query = "large language model vulnerability detection static analysis survey";
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		await store.upsertPaper(paper("local", "Local static analysis survey"));
		const base = optionsFromParams(
			{
				query,
				providers: ["arxiv", "openalex", "crossref", "semanticscholar", "dblp", "core", "exa", "usenix"],
				auto_expand: false,
				year_from: 2026,
				year_to: 2026,
			},
			root,
		);
		const searched = vi.fn<NonNullable<typeof base.providerPageSearch>>(async (provider, options) => ({
			provider,
			query: options.query,
			records: [paper(provider, provider === "crossref" ? query : `Peripheral work ${provider}`)],
			requestUrl: "https://example.test/search",
		}));
		const external = await collectLiterature({ ...base, providerPageSearch: searched });
		expect(searched).toHaveBeenCalledTimes(8);
		expect(external.run.failures).toEqual([]);
		expect(external.run.results[0].id).toBe("crossref");
		expect(external.run.corpusHitCount).toBe(0);
		const local = await collectLiterature({
			...base,
			corpusOnly: true,
			reuseCorpus: true,
			queries: ["static analysis"],
			providerPageSearch: searched,
		});
		expect(local.run.results.map((record) => record.id)).toContain("local");
		expect(local.run.corpusHitCount).toBe(1);
		expect(searched).toHaveBeenCalledTimes(8);
	});

	it("expands queries normally and rejects removed or misspelled tool arguments", () => {
		const options = optionsFromParams(
			{ query: "LLM static analysis", query_expansions: ["language model review"] },
			".",
		);
		expect(options.reuseCorpus).toBe(false);
		expect(optionsFromParams({ query: "kernel", reuse_corpus: true }, ".").reuseCorpus).toBe(true);
		expect(optionsFromParams({ query: "kernel", corpus_only: true }, ".").reuseCorpus).toBe(true);
		expect(options.queries).toContain("language model review");
		expect(options.queries).toContain("large language model static analysis");
		expect(collectionParameters()).toHaveProperty("additionalProperties", false);
		expect(collectionParameters().properties).not.toHaveProperty("arxiv_submitted_from");
		for (const extra of ["arxiv_submitted_from", "arxiv_submitted_to", "typo"]) {
			expect(() => optionsFromParams({ query: "kernel", [extra]: "2026-01-01" }, ".")).toThrow(
				"Unsupported search parameter",
			);
		}
		expect(() => optionsFromParams({ query: "   " }, ".")).toThrow("nonempty");
	});

	it("rejects unknown quick-search arguments even when invoked directly", async () => {
		type Tool = {
			name: string;
			parameters: { additionalProperties?: boolean };
			execute: (...args: unknown[]) => Promise<unknown>;
		};
		const tools: Tool[] = [];
		registerLiteratureDiscoveryTools({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
		const tool = tools.find((entry) => entry.name === "search_literature")!;
		expect(tool.parameters.additionalProperties).toBe(false);
		await expect(tool.execute("test", { query: "kernel", arxiv_submitted_from: "2026-01-01" })).rejects.toThrow(
			"Unsupported search parameter",
		);
		await expect(tool.execute("test", { query: "  " })).rejects.toThrow("nonempty");
	});

	it("keeps quick search external-only when the user omits library options", async () => {
		const collection = await import("../src/literature/application/literature-collection.ts");
		const collect = vi.spyOn(collection, "collectLiterature").mockRejectedValue(new Error("captured search input"));
		type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
		const tools: Tool[] = [];
		registerLiteratureDiscoveryTools({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
		await expect(tools.find((tool) => tool.name === "search_literature")!.execute("test", { query: "kernel" }, undefined, undefined, { cwd: "." })).rejects.toThrow("captured search input");
		expect(collect).toHaveBeenCalledWith(expect.objectContaining({ reuseCorpus: false }));
	});

	it("preserves keyword arXiv filters, raw-page pagination and a 10 second timeout", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const entry = (id: string, year: number, author: string) =>
			`<entry><id>https://arxiv.org/abs/${id}</id><title>Work ${id}</title><published>${year}-01-01T00:00:00Z</published><author><name>${author}</name></author></entry>`;
		const page = await searchArxivPage({
			query: "kernel",
			limit: 3,
			cursor: "6",
			filters: { yearFrom: 2026, yearTo: 2026, authors: ["Ada"] },
			fetcher: async () =>
				new Response(
					`<feed><opensearch:totalResults>9</opensearch:totalResults>${entry("2601.00001", 2026, "Ada")}${entry("2501.00002", 2025, "Ada")}${entry("2601.00003", 2026, "Grace")}</feed>`,
				),
		});
		expect(timeout).toHaveBeenCalledWith(10_000);
		expect(page.records).toHaveLength(1);
		expect(page.records[0]).not.toHaveProperty("firstSubmittedAt");
		expect(page.nextCursor).toBe("9");
	});

	it("does not route news through generic collection or the keyword adapter", async () => {
		for (const path of [
			"src/literature/application/arxiv-news.ts",
			"src/literature/infrastructure/arxiv-news-source.ts",
		]) {
			const source = await readFile(path, "utf8");
			expect(source).not.toMatch(/provider-arxiv|literature-collection|SearchFilters|ProviderSearchOptions/);
		}
		for (const path of [
			"src/literature/application/literature-collection.ts",
			"src/literature/infrastructure/provider-arxiv.ts",
			"src/literature/infrastructure/provider-common.ts",
		]) {
			const source = await readFile(path, "utf8");
			expect(source).not.toMatch(/arxiv-news|arxivSubmitted|firstSubmittedAt|arxivCategories|beforeAttempt/);
		}
	});
});
