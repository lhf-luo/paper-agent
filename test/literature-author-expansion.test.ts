import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAuthorPapers } from "../src/literature/application/literature-author-expansion.ts";
import { filterGroup } from "../src/literature/application/literature-filtering.ts";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import {
	type AuthorSourceResult,
	findAuthorSourcePapers,
	isSeedWork,
	parseDblpPersonXml,
	sameAuthorName,
} from "../src/literature/infrastructure/provider-author-papers.ts";
import { withId } from "../src/literature/infrastructure/provider-common.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function paper(title: string, doi: string, authors = ["Ada Example", "Bob Coauthor"]): PaperRecord {
	return withId({
		title,
		authors,
		identifiers: { doi },
		links: [],
		provenance: [],
		mergedFrom: [],
	});
}

const seed: PaperRecord = {
	...paper("Seed Work on Systems", "10.1000/seed"),
	identifiers: {
		doi: "10.1000/seed",
		openAlexId: "https://openalex.org/W1",
		semanticScholarId: "S1",
		dblpKey: "conf/test/Seed24",
	},
};

const openAlexWork = (id: string, title: string, doi: string, authorId = "A10") => ({
	id: `https://openalex.org/${id}`,
	display_name: title,
	doi: `https://doi.org/${doi}`,
	publication_year: 2025,
	authorships: [
		{ author: { id: `https://openalex.org/${authorId}`, display_name: "Ada Example" } },
		{ author: { id: "https://openalex.org/A11", display_name: "Bob Coauthor" } },
	],
});
const semanticWork = (id: string, title: string, doi: string, authorId = "44") => ({
	paperId: id,
	title,
	externalIds: { DOI: doi },
	authors: [
		{ authorId, name: "Ada Example" },
		{ authorId: "45", name: "Bob Coauthor" },
	],
	year: 2025,
});

const dblpXml = `<?xml version="1.0"?>
<dblpperson name="Ada Example" pid="a/AdaExample">
<r><inproceedings key="conf/test/Seed24"><author>Ada Example</author><author>Bob Coauthor</author><title>Seed Work on Systems</title><year>2024</year><ee>https://doi.org/10.1000/seed</ee></inproceedings></r>
<r><article key="journals/test/Common25"><author>Ada Example</author><title>Common Follow-up Paper</title><year>2025</year><ee>https://doi.org/10.1000/common</ee></article></r>
<r><article key="journals/test/Only25"><author>Ada Example</author><title>DBLP-only Paper</title><year>2025</year></article></r>
</dblpperson>`;

function fixtureFetcher(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (input) => {
		const url = new URL(String(input));
		if (url.hostname === "api.openalex.org") {
			if (url.pathname === "/works/W1") return Response.json(openAlexWork("W1", seed.title, "10.1000/seed"));
			if (url.pathname === "/works") {
				return Response.json({
					results: [
						openAlexWork("W1", seed.title, "10.1000/seed"),
						openAlexWork("W2", "Common Follow-up Paper", "10.1000/common"),
					],
					meta: { count: 2 },
				});
			}
		}
		if (url.hostname === "api.semanticscholar.org") {
			if (url.pathname === "/graph/v1/paper/S1")
				return Response.json(semanticWork("S1", seed.title, "10.1000/seed"));
			if (url.pathname === "/graph/v1/author/44/papers") {
				return Response.json({
					data: [
						semanticWork("S1", seed.title, "10.1000/seed"),
						semanticWork("S2", "Common Follow-up Paper", "10.1000/common"),
					],
				});
			}
		}
		if (url.hostname === "dblp.org") {
			if (url.pathname === "/search/author/api")
				return Response.json({
					result: {
						hits: {
							hit: [
								{ info: { author: "Ada Example", url: "https://dblp.org/pid/a/AdaExample" } },
								{ info: { author: "Ada Example 0001", url: "https://dblp.org/pid/a/OtherAda" } },
							],
						},
					},
				});
			if (url.pathname === "/pid/a/AdaExample.xml")
				return new Response(dblpXml, { headers: { "content-type": "application/xml" } });
			if (url.pathname === "/pid/a/OtherAda.xml")
				return new Response(
					'<dblpperson><r><article key="journals/test/Other"><author>Ada Example</author><title>Another Person Work</title><year>2025</year></article></r></dblpperson>',
				);
		}
		throw new Error(`Unexpected fixture URL: ${url.href}`);
	};
}

describe("author paper expansion", () => {
	it("resolves author IDs through the seed work, merges sources, excludes the seed, and produces a reusable Search Run", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-author-test-"));
		temporaryRoots.push(root);
		const run = await collectAuthorPapers({
			seed,
			authorName: "Example, Ada",

			fetcher: fixtureFetcher(),
		});
		expect(run.runKind).toBe("author-expansion");
		expect(run.results.map((record) => record.title)).toEqual(["Common Follow-up Paper", "DBLP-only Paper"]);
		expect(run.results[0].provenance.map((entry) => entry.provider).sort()).toEqual([
			"dblp",
			"openalex",
			"semanticscholar",
		]);
		expect(run.results[0].discoveryPaths?.map((entry) => entry.kind)).toEqual([
			"author-homepage",
			"author-homepage",
			"author-homepage",
		]);
		expect(run.authorExpansion?.sources.openalex?.authorId).toBe("A10");
		expect(run.authorExpansion?.sources.semanticscholar?.authorId).toBe("44");
		expect(run.authorExpansion?.sources.dblp?.authorId).toBe("a/AdaExample");
		const store = new LiteratureStore(root, "personal");
		await store.saveSearchRun(run);
		expect((await store.getSearchRun(run.id))?.results).toHaveLength(2);
		expect(await store.listPapers()).toHaveLength(0);
		const filtered = filterGroup(run, {
			withAbstract: { includeTerms: ["common"] },
			withoutAbstract: { includeTerms: ["paper"] },
		});
		expect(filtered.unresolved.map((item) => item.record.title)).toEqual([
			"Common Follow-up Paper",
			"DBLP-only Paper",
		]);
	});

	it("rejects same-name strangers and ambiguous seed authors", async () => {
		expect(sameAuthorName("Example, Ada", "Ada Example")).toBe(true);
		expect(isSeedWork(seed, paper(seed.title, "10.1000/other"), "Ada Example")).toBe(false);
		await expect(
			collectAuthorPapers({
				seed,
				authorName: "Unknown",

				sourceSearch: async () => {
					throw new Error("should not query");
				},
			}),
		).rejects.toThrow("uniquely match");
		const duplicateName = { ...seed, authors: ["Ada Example", "Example, Ada"] };
		await expect(collectAuthorPapers({ seed: duplicateName, authorName: "Ada Example" })).rejects.toThrow("found 2");
	});

	it("supports exact-title seed resolution without DOI and reports missing identity without guessing", async () => {
		const noDoi = { ...seed, identifiers: {} };
		const fetcher = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(String(input));
			if (
				url.hostname === "api.openalex.org" &&
				url.pathname === "/works" &&
				url.searchParams.get("search") === seed.title
			) {
				return Response.json({ results: [openAlexWork("W1", seed.title, "10.1000/seed")], meta: { count: 1 } });
			}
			if (url.hostname === "api.openalex.org") return Response.json({ results: [], meta: { count: 0 } });
			if (url.hostname === "api.semanticscholar.org") return Response.json({ data: [] });
			return Response.json({ result: { hits: { hit: [] } } });
		};
		const resolved = await findAuthorSourcePapers("openalex", {
			seed: noDoi,
			authorName: "Ada Example",
			limit: 10,
			fetcher,
		});
		expect(resolved.authorId).toBe("A10");
		const run = await collectAuthorPapers({ seed: noDoi, authorName: "Ada Example", fetcher });
		expect(run.authorExpansion?.sources.semanticscholar?.status).toBe("unresolved");
		expect(run.authorExpansion?.sources.dblp?.status).toBe("unresolved");
	});

	it("reports truncation, rate limits, and source-specific failures while retaining healthy results", async () => {
		const sourceSearch = async (provider: "openalex" | "semanticscholar" | "dblp"): Promise<AuthorSourceResult> => {
			if (provider === "semanticscholar") throw new Error("HTTP 429 rate limited");
			if (provider === "dblp")
				return { provider, status: "unresolved", records: [], truncated: false, message: "Seed not found" };
			return {
				provider,
				status: "partial",
				authorId: "A10",
				profileUrl: "https://openalex.org/A10",
				records: [paper("Useful Paper", "10.1000/useful")],
				total: 1000,
				truncated: true,
				message: "Later page timed out",
			};
		};
		const run = await collectAuthorPapers({
			seed,
			authorName: "Ada Example",

			maxResultsPerProvider: 1,
			sourceSearch,
		});
		expect(run.results).toHaveLength(1);
		expect(run.authorExpansion?.sources.openalex).toMatchObject({ status: "partial", truncated: true });
		expect(run.authorExpansion?.sources.semanticscholar?.status).toBe("failed");
		expect(run.authorExpansion?.sources.dblp?.status).toBe("unresolved");
		expect(run.coverage?.status).toBe("partial");
		expect(run.failures.find((failure) => failure.provider === "semanticscholar")).toMatchObject({
			provider: "semanticscholar",
			rateLimited: true,
		});
	});

	it("counts the cap after excluding the seed work", async () => {
		const sourceSearch = async (provider: "openalex" | "semanticscholar" | "dblp"): Promise<AuthorSourceResult> =>
			provider === "openalex"
				? {
						provider,
						status: "succeeded",
						authorId: "A10",
						records: [seed, paper("First Other", "10.1000/first"), paper("Second Other", "10.1000/second")],
						truncated: false,
					}
				: { provider, status: "unresolved", records: [], truncated: false };
		const run = await collectAuthorPapers({
			seed,
			authorName: "Ada Example",

			maxResultsPerProvider: 1,
			sourceSearch,
		});
		expect(run.results.map((record) => record.title)).toEqual(["First Other"]);
		expect(run.authorExpansion?.sources.openalex).toMatchObject({ fetchedCount: 1, truncated: true });
	});

	it("keeps earlier pages when a later OpenAlex request is rate-limited", async () => {
		const fetcher = async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(String(input));
			if (url.pathname === "/works/W1") return Response.json(openAlexWork("W1", seed.title, "10.1000/seed"));
			if (url.searchParams.get("cursor") === "*") {
				return Response.json({
					results: [openAlexWork("W2", "Useful Paper", "10.1000/useful")],
					meta: { count: 200, next_cursor: "next" },
				});
			}
			return new Response("rate limited", { status: 429 });
		};
		const result = await findAuthorSourcePapers("openalex", { seed, authorName: "Ada Example", limit: 150, fetcher });
		expect(result).toMatchObject({ status: "partial", truncated: true, records: [{ title: "Useful Paper" }] });
		expect(result.message).toContain("429");
	});

	it("parses bounded DBLP person XML into paper records", () => {
		const records = parseDblpPersonXml(dblpXml, "Ada Example", "https://dblp.org/pid/a/AdaExample.xml");
		expect(records).toHaveLength(3);
		expect(records[0].identifiers).toMatchObject({ dblpKey: "conf/test/Seed24", doi: "10.1000/seed" });
	});
});
