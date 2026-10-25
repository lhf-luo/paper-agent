import { expect, it } from "vitest";
import {
	calculateRelations,
	existingFeatures,
	sparseRelations,
	type GraphFeatures,
	type GraphRelation,
} from "../src/canvas/domain/search-graph-relations.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { unionPapers } from "../src/literature/domain/citation-seeds.ts";
const paper = (id: string): PaperRecord => ({
	id,
	title: id,
	authors: [],
	identifiers: { openAlexId: `https://openalex.org/W${id}` },
	links: [],
	mergedFrom: [],
	provenance: [],
});
const papers = ["1", "2", "3", "4"].map(paper);
it("normalizes provider aliases and directs reference/citation discoveries without self edges", () => {
	const input = structuredClone(papers);
	input[0].referencedWorks = ["https://openalex.org/W2"];
	input[2].discoveryPaths = [
		{ kind: "citation-expansion", seedPaperId: "1", provider: "openalex", discoveredAt: "2026-10-22" },
	];
	const features = existingFeatures(input),
		edges = calculateRelations(input, features);
	expect(edges.map((e) => [e.from, e.to, e.kind])).toEqual([
		["1", "2", "citation"],
		["3", "1", "citation"],
	]);
	expect(features[0]).toBeUndefined();
	expect(features["1"].references.status).toBe("partial");
});
it("does not invent similarity from a universal seed, one shared item, authors or year", () => {
	const f = existingFeatures(papers);
	for (const value of Object.values(f)) {
		value.references = { ids: ["seed", "background"], status: "complete", provider: "openalex" };
	}
	expect(calculateRelations(papers, f)).toEqual([]);
	f["1"].references.ids.push("rare");
	f["2"].references.ids.push("rare");
	expect(calculateRelations(papers, f)).toEqual([]);
});
it("uses IDF cosine, two positive shared evidence IDs and separate unknown channels", () => {
	const f = existingFeatures(papers);
	for (const id of ["1", "2"]) {
		f[id].references = { ids: ["rare-a", "rare-b"], status: "partial", provider: "s2" };
	}
	for (const id of ["3", "4"]) {
		f[id].references = { ids: [], status: "complete", provider: "s2" };
	}
	const [edge] = calculateRelations(papers, f);
	expect(edge).toMatchObject({ from: "1", to: "2", coupling: 1, cocitation: undefined, score: 1 });
	expect(edge.evidence.references).toEqual(["rare-a", "rare-b"]);
	expect(edge.evidence.coverage).toEqual(["partial", "missing", "partial", "missing"]);
});
it("combines both known channels and keeps direct citations below association threshold", () => {
	const f: GraphFeatures = existingFeatures(papers);
	for (const id of ["1", "2"]) f[id].references = { ids: ["x", "y"], status: "complete", provider: "s2" };
	for (const id of ["3", "4"]) f[id].references = { ids: [], status: "complete", provider: "s2" };
	for (const id of ["1", "2"]) f[id].citations = { ids: [`unique-${id}`], status: "partial", provider: "s2" };
	expect(calculateRelations(papers, f)[0].score).toBeCloseTo(0.6);
	f["1"].references.ids.push("2");
	expect(calculateRelations(papers, f).some((e) => e.kind === "citation" && e.from === "1" && e.to === "2")).toBe(
		true,
	);
});
it("keeps reliable first identity and merges provenance without title-only merging", () => {
	const a = paper("1"),
		b = { ...paper("external"), title: a.title, identifiers: { openAlexId: "W1" } },
		c = { ...paper("3"), title: a.title };
	const merged = unionPapers([a, b, c]);
	expect(merged.map((p) => p.id)).toEqual(["1", "3"]);
	expect(merged[0].mergedFrom).toContain("external");
});
it("bounds rendered edges while retaining the maximum spanning forest", () => {
	const edges: GraphRelation[] = [];
	for (let a = 0; a < 100; a++)
		for (let b = a + 1; b < 100; b++)
			edges.push({
				id: `${a}-${b}`,
				from: `${a}`,
				to: `${b}`,
				kind: "association",
				score: 1 / (b - a),
				label: "关联",
				evidence: { references: [], citations: [], sources: [], collectedAt: [], coverage: [] },
			});
	const shown = sparseRelations(edges);
	expect(shown.length).toBeLessThanOrEqual(1200);
	for (let a = 0; a < 99; a++) expect(shown.some((e) => e.id === `${a}-${a + 1}`)).toBe(true);
	expect(sparseRelations([...edges].reverse())).toEqual(shown);
});
