import { describe, expect, it } from "vitest";
import { evaluateArtifactDiscovery, type ArtifactGoldAnnotation } from "../src/artifact-evaluation.ts";
import type { ArtifactManifest } from "../src/literature-types.ts";

const sha256 = "a".repeat(64);
const annotation: ArtifactGoldAnnotation = {
	schemaVersion: 1,
	annotationStatus: "human-reviewed",
	source: {
		slug: "fixture",
		title: "Artifact fixture",
		pdfPath: "fixture.pdf",
		pdfSha256: sha256,
		sourceUrl: "https://example.org/paper",
	},
	inspection: {
		allPagesReviewed: true,
		pageCount: 9,
		reviewedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9],
		reviewer: "human-reviewer",
		reviewedAt: "2026-08-01T00:00:00.000Z",
	},
	expectedArtifacts: [
		{
			id: "repository",
			urls: ["https://github.com/example/project", "https://github.com/example/project.git"],
			kind: "repository",
			pages: [2],
		},
		{ id: "dataset", urls: ["https://zenodo.org/records/123"], kind: "dataset" },
	],
	ignoredUrls: [{ url: "https://github.com/example/citation-only", reason: "bibliography entry, not this paper's artifact" }],
};

const manifest: ArtifactManifest = {
	schemaVersion: 1,
	pdfPath: "fixture.pdf",
	pdfSha256: sha256,
	discoveredAt: "2026-08-01T00:00:00.000Z",
	acquisitions: [],
	candidates: [
		{
			id: "candidate-1",
			url: "https://github.com/example/project.git",
			kind: "repository",
			host: "github.com",
			confidence: "high",
			sources: [{ method: "pdftotext", page: 2, context: "Code is available at the repository." }],
		},
		{
			id: "candidate-2",
			url: "https://github.com/example/citation-only",
			kind: "repository",
			host: "github.com",
			confidence: "high",
			sources: [{ method: "pdftotext", page: 9, context: "Reference" }],
		},
		{
			id: "candidate-3",
			url: "https://example.org/unexpected/artifact",
			kind: "supplement",
			host: "example.org",
			confidence: "medium",
			sources: [{ method: "pdfinfo-url", context: "Artifact" }],
		},
	],
};

describe("artifact discovery evaluation", () => {
	it("matches URL aliases, ignores reviewed non-artifacts, and reports missing/unexpected candidates", () => {
		expect(evaluateArtifactDiscovery(annotation, manifest)).toMatchObject({
			truePositives: 1,
			falsePositives: 1,
			falseNegatives: 1,
			precision: 0.5,
			recall: 0.5,
			kindCorrect: 1,
			kindEvaluated: 1,
			pageCorrect: 1,
			pageEvaluated: 1,
			provenanceComplete: 1,
			matchedExpectedIds: ["repository"],
			missingExpectedIds: ["dataset"],
			unexpectedUrls: ["https://example.org/unexpected/artifact"],
		});
	});

	it("rejects machine-generated candidates when they are mislabeled as reviewed gold", () => {
		expect(() =>
			evaluateArtifactDiscovery(
				{
					...annotation,
					inspection: { allPagesReviewed: true },
				},
				manifest,
			),
		).toThrow("name a reviewer");
	});
});
