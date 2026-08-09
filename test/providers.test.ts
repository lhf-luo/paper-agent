import { describe, expect, it } from "vitest";
import {
	fetchOpenAlexWorks,
	searchArxivPage,
	searchOpenAlexPage,
	searchSemanticScholarCitations,
	searchSemanticScholarPage,
} from "../src/literature-providers.ts";

describe("literature providers", () => {
	it("parses an arXiv page and exposes an offset cursor", async () => {
		const xml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<feed xmlns:arxiv="http://arxiv.org/schemas/atom">',
			"<entry>",
			"<id>https://arxiv.org/abs/2501.01234v2</id>",
			"<title> Stateful &amp; Reproducible Fuzzing </title>",
			"<summary>Primary abstract.</summary>",
			"<published>2025-01-03T00:00:00Z</published>",
			"<author><name>Ada Example</name></author>",
			"<arxiv:doi>10.1234/ARXIV.TEST</arxiv:doi>",
			"</entry>",
			"</feed>",
		].join("");
		const page = await searchArxivPage({
			query: "stateful fuzzing",
			limit: 1,
			fetcher: async () => new Response(xml, { headers: { "content-type": "application/atom+xml" } }),
		});

		expect(page.nextCursor).toBe("1");
		expect(page.records).toMatchObject([
			{
				title: "Stateful & Reproducible Fuzzing",
				year: 2025,
				identifiers: { doi: "10.1234/arxiv.test", arxivId: "2501.01234" },
			},
		]);
		expect(page.records[0].links.some((link) => link.kind === "pdf")).toBe(true);
	});

	it("parses OpenAlex cursor, abstract, references, authors, and OA PDF provenance", async () => {
		const payload = {
			meta: { count: 1, next_cursor: "next-page" },
			results: [
				{
					id: "https://openalex.org/W123",
					display_name: "OpenAlex Paper",
					publication_year: 2024,
					type: "article",
					doi: "https://doi.org/10.9999/example",
					cited_by_count: 7,
					abstract_inverted_index: { Rebuilt: [0], abstract: [1] },
					authorships: [{ author: { display_name: "Researcher One" } }],
					primary_location: {
						landing_page_url: "https://example.org/paper",
						pdf_url: "https://example.org/paper.pdf",
						source: { display_name: "ExampleConf" },
					},
					referenced_works: ["https://openalex.org/W9"],
					cited_by_api_url: "https://api.openalex.org/works?filter=cites:W123",
				},
			],
		};
		const page = await searchOpenAlexPage({
			query: "open alex",
			limit: 10,
			fetcher: async () => Response.json(payload),
		});

		expect(page.nextCursor).toBe("next-page");
		expect(page.records[0]).toMatchObject({
			abstract: "Rebuilt abstract",
			authors: ["Researcher One"],
			venue: "ExampleConf",
			referencedWorks: ["https://openalex.org/W9"],
			identifiers: { openAlexId: "https://openalex.org/W123", doi: "10.9999/example" },
		});
		expect(page.records[0].links).toContainEqual({
			url: "https://example.org/paper.pdf",
			kind: "pdf",
			openAccess: true,
		});
	});

	it("parses Semantic Scholar identifiers, OA PDF, and offset pagination", async () => {
		const page = await searchSemanticScholarPage({
			query: "stateful fuzzing",
			limit: 10,
			fetcher: async () =>
				Response.json({
					total: 20,
					next: 10,
					data: [
						{
							paperId: "s2-paper-1",
							title: "Stateful Fuzzing",
							abstract: "A primary abstract.",
							authors: [{ name: "Ada Example" }],
							year: 2025,
							venue: "TestConf",
							publicationTypes: ["Conference"],
							externalIds: { DOI: "10.5555/S2.TEST", ArXiv: "2501.01234" },
							url: "https://www.semanticscholar.org/paper/s2-paper-1",
							openAccessPdf: { url: "https://example.org/paper.pdf" },
							citationCount: 9,
						},
					],
				}),
		});

		expect(page.nextCursor).toBe("10");
		expect(page.records[0]).toMatchObject({
			title: "Stateful Fuzzing",
			identifiers: {
				doi: "10.5555/s2.test",
				arxivId: "2501.01234",
				semanticScholarId: "s2-paper-1",
			},
			citationCount: 9,
		});
		expect(page.records[0].links).toContainEqual({
			url: "https://example.org/paper.pdf",
			kind: "pdf",
			openAccess: true,
		});
	});

	it("expands Semantic Scholar reference and citation edges", async () => {
		const page = await searchSemanticScholarCitations("seed-paper", "references", {
			limit: 10,
			queryLabel: "references:seed-paper",
			fetcher: async () =>
				Response.json({
					next: 10,
					data: [
						{
							citedPaper: {
								paperId: "neighbor-paper",
								title: "Neighbor Paper",
								authors: [{ name: "A. Author" }],
								year: 2024,
								externalIds: {},
							},
						},
					],
				}),
		});
		expect(page.nextCursor).toBe("10");
		expect(page.records[0]).toMatchObject({
			title: "Neighbor Paper",
			identifiers: { semanticScholarId: "neighbor-paper" },
		});
	});

	it("fetches all OpenAlex work ids in supported batches", async () => {
		const requestUrls: string[] = [];
		const ids = Array.from({ length: 51 }, (_, index) => `https://openalex.org/W${index + 1}`);
		await fetchOpenAlexWorks(ids, {
			queryLabel: "batch",
			fetcher: async (input) => {
				requestUrls.push(input.toString());
				return Response.json({ results: [] });
			},
		});
		expect(requestUrls).toHaveLength(2);
		expect(new URL(requestUrls[0]).searchParams.get("filter")).toContain("ids.openalex:W1|W2");
		expect(new URL(requestUrls[0]).searchParams.get("per-page")).toBe("50");
		expect(new URL(requestUrls[1]).searchParams.get("filter")).toBe("ids.openalex:W51");
	});
});
