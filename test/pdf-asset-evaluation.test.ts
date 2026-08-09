import { describe, expect, it } from "vitest";
import { evaluatePaperAssets, parseAssetEvaluationDataset } from "../src/pdf-asset-evaluation.ts";
import type { PaperAsset } from "../src/pdf-asset-tools.ts";

describe("PDF asset evaluation", () => {
	it("computes caption, crop, and mention metrics with auditable errors", () => {
		const detected: PaperAsset[] = [
			{
				id: "figure-1-p2",
				type: "figure",
				identifier: "1",
				page: 2,
				caption: "Figure 1. Pipeline",
				captionBox: { x: 10, y: 60, width: 80, height: 10 },
				candidateRegion: { x: 10, y: 10, width: 80, height: 40 },
				continuationRegions: [{ page: 3, region: { x: 10, y: 10, width: 80, height: 40 }, confidence: "high" }],
				regionConfidence: "high",
				mentions: [
					{
						page: 1,
						matchedText: "Figure 1",
						context: "See Figure 1",
						lineBox: { x: 10, y: 10, width: 80, height: 10 },
						confidence: "high",
					},
				],
			},
			{
				id: "table-9-p3",
				type: "table",
				identifier: "9",
				page: 3,
				caption: "Table 9. False positive",
				captionBox: { x: 0, y: 0, width: 10, height: 10 },
				candidateRegion: { x: 0, y: 0, width: 10, height: 10 },
				regionConfidence: "low",
				mentions: [],
			},
		];
		const evaluation = evaluatePaperAssets(detected, [
			{
				type: "figure",
				identifier: "1",
				page: 2,
				region: { x: 10, y: 10, width: 80, height: 40 },
				continuationRegions: [{ page: 3, region: { x: 10, y: 10, width: 80, height: 40 } }],
				mentionPages: [1, 4],
			},
			{
				type: "table",
				identifier: "2",
				page: 4,
				region: { x: 20, y: 20, width: 60, height: 30 },
			},
		]);

		expect(evaluation).toMatchObject({
			captionPrecision: 0.5,
			captionRecall: 0.5,
			cropIouMean: 1,
			mentionPrecision: 1,
			mentionRecall: 0.5,
			continuationPrecision: 1,
			continuationRecall: 1,
			continuationCropIouMean: 1,
			falsePositiveCount: 1,
			missedCount: 1,
		});
	});

	it("counts mentions and continuations on unmatched detections as false positives", () => {
		const falsePositive: PaperAsset = {
			id: "table-99-p2",
			type: "table",
			identifier: "99",
			page: 2,
			caption: "Table 99. Noise",
			captionBox: { x: 0, y: 0, width: 10, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 10, height: 10 },
			regionConfidence: "low",
			mentions: [
				{
					page: 1,
					matchedText: "Table 99",
					context: "noise",
					lineBox: { x: 0, y: 0, width: 10, height: 10 },
					confidence: "ambiguous",
				},
			],
			continuationRegions: [{ page: 3, region: { x: 0, y: 0, width: 10, height: 10 }, confidence: "medium" }],
		};
		const evaluation = evaluatePaperAssets([falsePositive], []);
		expect(evaluation.mentionPrecision).toBe(0);
		expect(evaluation.continuationPrecision).toBe(0);
		expect(evaluation.mentionDetectedCount).toBe(1);
		expect(evaluation.continuationDetectedCount).toBe(1);
	});

	it("ignores detections outside fully annotated pages in empty-gold recall", () => {
		const outsideScope: PaperAsset = {
			id: "figure-7-p7",
			type: "figure",
			identifier: "7",
			page: 7,
			caption: "Figure 7. Outside review scope",
			captionBox: { x: 0, y: 0, width: 10, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 10, height: 10 },
			regionConfidence: "low",
			mentions: [],
		};
		const evaluation = evaluatePaperAssets([outsideScope], [], { annotatedPages: [1] });
		expect(evaluation.captionPrecision).toBe(1);
		expect(evaluation.captionRecall).toBe(1);
	});

	it("does not count a disjoint continuation region as a true positive", () => {
		const detected: PaperAsset = {
			id: "table-1-p2",
			type: "table",
			identifier: "1",
			page: 2,
			caption: "Table 1. Results",
			captionBox: { x: 0, y: 0, width: 10, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 100, height: 100 },
			regionConfidence: "high",
			mentions: [],
			continuationRegions: [{ page: 3, region: { x: 0, y: 0, width: 10, height: 10 }, confidence: "high" }],
		};
		const evaluation = evaluatePaperAssets(
			[detected],
			[
				{
					type: "table",
					identifier: "1",
					page: 2,
					region: { x: 0, y: 0, width: 100, height: 100 },
					continuationRegions: [{ page: 3, region: { x: 50, y: 50, width: 10, height: 10 } }],
				},
			],
		);
		expect(evaluation.continuationPrecision).toBe(0);
		expect(evaluation.continuationRecall).toBe(0);
	});

	it("matches independently annotated subfigures by label and IoU while counting misses and false positives", () => {
		const detected: PaperAsset = {
			id: "figure-3-p5",
			type: "figure",
			identifier: "3",
			page: 5,
			caption: "Figure 3. (a) first, (b) second",
			captionBox: { x: 0, y: 90, width: 100, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 100, height: 90 },
			regionConfidence: "high",
			mentions: [],
			subfigureRegions: [
				{ label: "a", region: { x: 0, y: 0, width: 45, height: 80 }, confidence: "medium" },
				{ label: "b", region: { x: 70, y: 0, width: 30, height: 30 }, confidence: "medium" },
				{ label: "c", region: { x: 45, y: 0, width: 25, height: 80 }, confidence: "low" },
			],
		};
		const evaluation = evaluatePaperAssets(
			[detected],
			[
				{
					type: "figure",
					identifier: "3",
					page: 5,
					region: detected.candidateRegion,
					subfigureRegions: [
						{ label: "(a)", region: { x: 0, y: 0, width: 45, height: 80 } },
						{ label: "b", region: { x: 45, y: 0, width: 45, height: 80 } },
					],
				},
			],
		);

		expect(evaluation.subfigurePrecision).toBeCloseTo(1 / 3);
		expect(evaluation.subfigureRecall).toBe(0.5);
		expect(evaluation.subfigureCropIouMean).toBe(1);
		expect(evaluation.subfigureGoldCount).toBe(2);
		expect(evaluation.subfigureDetectedCount).toBe(3);
		expect(evaluation.subfigureTruePositiveCount).toBe(1);
	});

	it("does not score subfigure output when the gold asset was not annotated at subfigure level", () => {
		const detected: PaperAsset = {
			id: "figure-1-p1",
			type: "figure",
			identifier: "1",
			page: 1,
			caption: "Figure 1. (a) left and (b) right",
			captionBox: { x: 0, y: 90, width: 100, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 100, height: 90 },
			regionConfidence: "medium",
			mentions: [],
			subfigureRegions: [
				{ label: "a", region: { x: 0, y: 0, width: 50, height: 90 }, confidence: "medium" },
				{ label: "b", region: { x: 50, y: 0, width: 50, height: 90 }, confidence: "medium" },
			],
		};
		const evaluation = evaluatePaperAssets(
			[detected],
			[{ type: "figure", identifier: "1", page: 1, region: detected.candidateRegion }],
		);
		expect(evaluation.subfigureGoldCount).toBe(0);
		expect(evaluation.subfigureDetectedCount).toBe(0);
		expect(evaluation.subfigurePrecision).toBe(1);
		expect(evaluation.subfigureRecall).toBe(1);
	});

	it("rejects duplicate type/id/page gold keys", () => {
		const duplicate = {
			type: "figure" as const,
			identifier: "1",
			page: 1,
			region: { x: 0, y: 0, width: 10, height: 10 },
		};
		expect(() => evaluatePaperAssets([], [duplicate, duplicate])).toThrow("duplicate type/id/page keys");
	});

	it("validates reviewed annotation scope and keeps bootstrap candidates visibly distinct", () => {
		const dataset = parseAssetEvaluationDataset({
			schemaVersion: 2,
			annotationStatus: "detector-bootstrap-requires-human-review",
			pdfPath: "paper.pdf",
			pdfSha256: "a".repeat(64),
			annotatedPages: [2],
			metadata: { domains: ["security"], layouts: ["two-column"] },
			assets: [{ type: "figure", identifier: "1", page: 2, region: { x: 1, y: 2, width: 3, height: 4 } }],
		});
		expect(dataset.annotationStatus).toBe("detector-bootstrap-requires-human-review");
		expect(() =>
			parseAssetEvaluationDataset({
				...dataset,
				annotationStatus: "human-reviewed",
				assets: [{ ...dataset.assets[0], page: 3 }],
			}),
		).toThrow("outside annotatedPages");
	});
});
