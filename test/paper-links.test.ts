import { describe, expect, it } from "vitest";
import { paperLinksForDisplay, paperPrimaryAction, paperPrimaryUrl } from "../web/src/paper-links.ts";
import type { PaperRecord } from "../web/src/types.ts";

function paper(): PaperRecord {
	return {
		id: "paper-link-test",
		title: "Paper Link Test",
		authors: ["Ada Researcher"],
		identifiers: { doi: "10.1000/EXAMPLE" },
		links: [
			{ url: "https://openalex.org/W123", kind: "landing" },
			{ url: "https://example.org/paper.pdf", kind: "pdf" },
		],
		provenance: [],
	};
}

describe("paper links", () => {
	it("uses a canonical DOI URL as the primary link", () => {
		expect(paperPrimaryUrl(paper())).toBe("https://doi.org/10.1000/example");
		expect(paperPrimaryAction(paper())).toEqual({
			url: "https://doi.org/10.1000/example",
			label: "打开 DOI",
		});
	});

	it("falls back to arXiv when DOI is unavailable", () => {
		const record = paper();
		record.identifiers = { arxivId: "2002.10751v2" };
		record.links = [];
		expect(paperPrimaryAction(record)).toEqual({
			url: "https://arxiv.org/abs/2002.10751",
			label: "打开 arXiv",
		});
	});

	it("falls back to a landing page when DOI and arXiv are unavailable", () => {
		const record = paper();
		record.identifiers = {};
		record.links = [
			{
				url: "https://www.semanticscholar.org/paper/example",
				kind: "landing",
			},
		];
		expect(paperPrimaryAction(record)).toEqual({
			url: "https://www.semanticscholar.org/paper/example",
			label: "打开论文页",
		});
	});

	it("shows the DOI first without dropping provider and PDF links", () => {
		expect(paperLinksForDisplay(paper())).toEqual([
			{ url: "https://doi.org/10.1000/example", kind: "doi" },
			{ url: "https://openalex.org/W123", kind: "landing" },
			{ url: "https://example.org/paper.pdf", kind: "pdf" },
		]);
	});
});
