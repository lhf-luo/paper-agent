import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	augmentPaperAssetsWithOcr,
	detectPaperAssets,
	type PaperAsset,
	type PdfBox,
	parsePdfTsv,
	refinePaperAssetRegions,
} from "./pdf-asset-tools.ts";
import { validatePdfPath } from "./pdf-tools.ts";

export interface AssetGoldAnnotation {
	type: PaperAsset["type"];
	identifier: string;
	page: number;
	region: PdfBox;
	continuationRegions?: Array<{ page: number; region: PdfBox }>;
	subfigureRegions?: Array<{ label: string; region: PdfBox }>;
	mentionPages?: number[];
}

export interface AssetEvaluationDataset {
	schemaVersion: 1 | 2;
	annotationStatus?: "human-reviewed" | "detector-bootstrap-requires-human-review";
	pdfPath: string;
	pdfSha256?: string;
	annotatedPages?: number[];
	metadata?: {
		paperId?: string;
		title?: string;
		domains?: string[];
		layouts?: string[];
		sourceUrl?: string;
	};
	assets: AssetGoldAnnotation[];
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

function intersectionOverUnion(left: PdfBox, right: PdfBox): number {
	const x1 = Math.max(left.x, right.x);
	const y1 = Math.max(left.y, right.y);
	const x2 = Math.min(left.x + left.width, right.x + right.width);
	const y2 = Math.min(left.y + left.height, right.y + right.height);
	const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
	if (intersection === 0) return 0;
	const union = left.width * left.height + right.width * right.height - intersection;
	return union > 0 ? intersection / union : 0;
}

function annotationKey(value: Pick<AssetGoldAnnotation, "type" | "identifier" | "page">): string {
	return `${value.type}|${value.identifier.toLowerCase()}|${value.page}`;
}

function normalizedSubfigureLabel(label: string): string {
	return label
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[()[\]{}]/g, "")
		.trim();
}

function matchSubfigures(
	detected: NonNullable<PaperAsset["subfigureRegions"]>,
	gold: NonNullable<AssetGoldAnnotation["subfigureRegions"]>,
): Array<{ label: string; cropIou: number }> {
	const used = new Set<number>();
	const matches: Array<{ label: string; cropIou: number }> = [];
	for (const annotation of gold) {
		const label = normalizedSubfigureLabel(annotation.label);
		let best: { index: number; cropIou: number } | undefined;
		for (const [index, candidate] of detected.entries()) {
			if (used.has(index) || normalizedSubfigureLabel(candidate.label) !== label) continue;
			const cropIou = intersectionOverUnion(candidate.region, annotation.region);
			if (!best || cropIou > best.cropIou) best = { index, cropIou };
		}
		if (best && best.cropIou >= 0.5) {
			used.add(best.index);
			matches.push({ label: annotation.label, cropIou: best.cropIou });
		}
	}
	return matches;
}

export function evaluatePaperAssets(
	detected: PaperAsset[],
	gold: AssetGoldAnnotation[],
	options: { annotatedPages?: number[] } = {},
) {
	const annotatedPages = options.annotatedPages ? new Set(options.annotatedPages) : undefined;
	const scopedDetected = annotatedPages ? detected.filter((asset) => annotatedPages.has(asset.page)) : detected;
	const detectedKeys = scopedDetected.map(annotationKey);
	const goldKeys = gold.map(annotationKey);
	if (new Set(detectedKeys).size !== detectedKeys.length)
		throw new Error("Detected assets contain duplicate type/id/page keys");
	if (new Set(goldKeys).size !== goldKeys.length) throw new Error("Gold assets contain duplicate type/id/page keys");
	const detectedByKey = new Map(scopedDetected.map((asset) => [annotationKey(asset), asset]));
	const goldByKey = new Map(gold.map((asset) => [annotationKey(asset), asset]));
	const matched = [];
	const missed = [];
	for (const annotation of gold) {
		const candidate = detectedByKey.get(annotationKey(annotation));
		if (!candidate) {
			missed.push(annotation);
			continue;
		}
		const goldMentionPages = new Set(annotation.mentionPages ?? []);
		const detectedMentionPages = new Set(candidate.mentions.map((mention) => mention.page));
		const mentionTruePositives = [...goldMentionPages].filter((page) => detectedMentionPages.has(page)).length;
		const detectedContinuations = new Map(
			(candidate.continuationRegions ?? []).map((continuation) => [continuation.page, continuation.region]),
		);
		const goldContinuations = annotation.continuationRegions ?? [];
		const continuationMatches = goldContinuations
			.map((continuation) => {
				const detectedRegion = detectedContinuations.get(continuation.page);
				if (!detectedRegion) return undefined;
				const cropIou = intersectionOverUnion(detectedRegion, continuation.region);
				return cropIou >= 0.5 ? { page: continuation.page, cropIou } : undefined;
			})
			.filter((value): value is { page: number; cropIou: number } => Boolean(value));
		const subfigureAnnotated = annotation.subfigureRegions !== undefined;
		const detectedSubfigures = subfigureAnnotated ? (candidate.subfigureRegions ?? []) : [];
		const goldSubfigures = annotation.subfigureRegions ?? [];
		const subfigureMatches = matchSubfigures(detectedSubfigures, goldSubfigures);
		matched.push({
			key: annotationKey(annotation),
			cropIou: intersectionOverUnion(candidate.candidateRegion, annotation.region),
			mentionTruePositives,
			goldMentionCount: goldMentionPages.size,
			detectedMentionCount: detectedMentionPages.size,
			continuationMatches,
			goldContinuationCount: goldContinuations.length,
			detectedContinuationCount: detectedContinuations.size,
			subfigureAnnotated,
			subfigureMatches,
			goldSubfigureCount: goldSubfigures.length,
			detectedSubfigureCount: detectedSubfigures.length,
		});
	}
	const falsePositives = scopedDetected.filter((asset) => !goldByKey.has(annotationKey(asset)));
	const truePositives = matched.length;
	const precision = scopedDetected.length ? truePositives / scopedDetected.length : gold.length === 0 ? 1 : 0;
	const recall = gold.length ? truePositives / gold.length : scopedDetected.length === 0 ? 1 : 0;
	const cropIous = matched.map((item) => item.cropIou);
	const cropIouMean = matched.length ? cropIous.reduce((total, value) => total + value, 0) / matched.length : 0;
	const mentionGold = matched.reduce((total, item) => total + item.goldMentionCount, 0);
	const mentionDetected = matched.reduce((total, item) => total + item.detectedMentionCount, 0);
	const mentionTruePositives = matched.reduce((total, item) => total + item.mentionTruePositives, 0);
	const continuationIous = matched.flatMap((item) => item.continuationMatches.map((match) => match.cropIou));
	const unmatchedMentionCount = falsePositives.reduce((total, asset) => total + asset.mentions.length, 0);
	const unmatchedContinuationCount = falsePositives.reduce(
		(total, asset) => total + (asset.continuationRegions?.length ?? 0),
		0,
	);
	const missedMentionCount = missed.reduce((total, annotation) => total + (annotation.mentionPages?.length ?? 0), 0);
	const missedContinuationCount = missed.reduce(
		(total, annotation) => total + (annotation.continuationRegions?.length ?? 0),
		0,
	);
	const continuationGold =
		matched.reduce((total, item) => total + item.goldContinuationCount, 0) + missedContinuationCount;
	const continuationDetected =
		matched.reduce((total, item) => total + item.detectedContinuationCount, 0) + unmatchedContinuationCount;
	const subfigureIous = matched.flatMap((item) => item.subfigureMatches.map((match) => match.cropIou));
	const subfigureGold =
		matched.reduce((total, item) => total + (item.subfigureAnnotated ? item.goldSubfigureCount : 0), 0) +
		missed.reduce((total, annotation) => total + (annotation.subfigureRegions?.length ?? 0), 0);
	const subfigureDetected = matched.reduce(
		(total, item) => total + (item.subfigureAnnotated ? item.detectedSubfigureCount : 0),
		0,
	);
	const totalMentionGold = mentionGold + missedMentionCount;
	const totalMentionDetected = mentionDetected + unmatchedMentionCount;
	return {
		captionPrecision: precision,
		captionRecall: recall,
		cropIouMean,
		cropIouMedian: percentile(cropIous, 0.5),
		cropIouP10: percentile(cropIous, 0.1),
		cropIouAt50: cropIous.length ? cropIous.filter((value) => value >= 0.5).length / cropIous.length : 0,
		cropIouAt75: cropIous.length ? cropIous.filter((value) => value >= 0.75).length / cropIous.length : 0,
		mentionPrecision: totalMentionDetected
			? mentionTruePositives / totalMentionDetected
			: totalMentionGold === 0
				? 1
				: 0,
		mentionRecall: totalMentionGold ? mentionTruePositives / totalMentionGold : totalMentionDetected === 0 ? 1 : 0,
		continuationPrecision: continuationDetected
			? continuationIous.length / continuationDetected
			: continuationGold === 0
				? 1
				: 0,
		continuationRecall: continuationGold
			? continuationIous.length / continuationGold
			: continuationDetected === 0
				? 1
				: 0,
		continuationCropIouMean: continuationIous.length
			? continuationIous.reduce((total, value) => total + value, 0) / continuationIous.length
			: continuationGold === 0
				? 1
				: 0,
		subfigurePrecision: subfigureDetected ? subfigureIous.length / subfigureDetected : subfigureGold === 0 ? 1 : 0,
		subfigureRecall: subfigureGold ? subfigureIous.length / subfigureGold : subfigureDetected === 0 ? 1 : 0,
		subfigureCropIouMean: subfigureIous.length
			? subfigureIous.reduce((total, value) => total + value, 0) / subfigureIous.length
			: subfigureGold === 0
				? 1
				: 0,
		truePositives,
		falsePositiveCount: falsePositives.length,
		missedCount: missed.length,
		mentionGoldCount: totalMentionGold,
		mentionDetectedCount: totalMentionDetected,
		mentionTruePositiveCount: mentionTruePositives,
		continuationGoldCount: continuationGold,
		continuationDetectedCount: continuationDetected,
		continuationTruePositiveCount: continuationIous.length,
		continuationIous,
		subfigureGoldCount: subfigureGold,
		subfigureDetectedCount: subfigureDetected,
		subfigureTruePositiveCount: subfigureIous.length,
		subfigureIous,
		matched,
		missed,
		falsePositives: falsePositives.map((asset) => ({
			id: asset.id,
			type: asset.type,
			identifier: asset.identifier,
			page: asset.page,
		})),
	};
}

export function parseAssetEvaluationDataset(value: unknown): AssetEvaluationDataset {
	if (typeof value !== "object" || value === null) throw new Error("Evaluation dataset must be an object");
	const dataset = value as AssetEvaluationDataset;
	if (
		![1, 2].includes(dataset.schemaVersion) ||
		typeof dataset.pdfPath !== "string" ||
		!Array.isArray(dataset.assets)
	) {
		throw new Error("Evaluation dataset must use schemaVersion=1 or 2 with pdfPath and assets[]");
	}
	if (dataset.schemaVersion === 2) {
		if (
			dataset.annotationStatus !== undefined &&
			dataset.annotationStatus !== "human-reviewed" &&
			dataset.annotationStatus !== "detector-bootstrap-requires-human-review"
		) {
			throw new Error("schemaVersion=2 annotationStatus is not recognized");
		}
		if (!dataset.pdfSha256?.match(/^[a-f0-9]{64}$/i)) throw new Error("schemaVersion=2 requires pdfSha256");
		if (
			!dataset.annotatedPages?.length ||
			!dataset.annotatedPages.every((page) => Number.isInteger(page) && page >= 1)
		) {
			throw new Error("schemaVersion=2 requires annotatedPages[]");
		}
	}
	if (dataset.metadata !== undefined) {
		if (
			typeof dataset.metadata !== "object" ||
			(dataset.metadata.paperId !== undefined && typeof dataset.metadata.paperId !== "string") ||
			(dataset.metadata.title !== undefined && typeof dataset.metadata.title !== "string") ||
			(dataset.metadata.sourceUrl !== undefined && typeof dataset.metadata.sourceUrl !== "string") ||
			(dataset.metadata.domains !== undefined &&
				(!Array.isArray(dataset.metadata.domains) ||
					!dataset.metadata.domains.every((value) => typeof value === "string" && value.trim()))) ||
			(dataset.metadata.layouts !== undefined &&
				(!Array.isArray(dataset.metadata.layouts) ||
					!dataset.metadata.layouts.every((value) => typeof value === "string" && value.trim())))
		) {
			throw new Error("Evaluation metadata fields are invalid");
		}
	}
	const annotatedPages = new Set(dataset.annotatedPages ?? []);
	for (const [index, asset] of dataset.assets.entries()) {
		if (
			!asset ||
			!["figure", "table", "algorithm", "listing"].includes(asset.type) ||
			typeof asset.identifier !== "string" ||
			!Number.isInteger(asset.page) ||
			asset.page < 1 ||
			!asset.region ||
			![asset.region.x, asset.region.y, asset.region.width, asset.region.height].every(
				(value) => Number.isFinite(value) && value >= 0,
			) ||
			asset.region.width <= 0 ||
			asset.region.height <= 0
		) {
			throw new Error(`Invalid asset annotation at index ${index}`);
		}
		if (dataset.schemaVersion === 2 && !annotatedPages.has(asset.page)) {
			throw new Error(`Gold asset page is outside annotatedPages at index ${index}`);
		}
		if (
			asset.continuationRegions?.some(
				(continuation) =>
					!Number.isInteger(continuation.page) ||
					continuation.page <= asset.page ||
					![
						continuation.region?.x,
						continuation.region?.y,
						continuation.region?.width,
						continuation.region?.height,
					].every((value) => Number.isFinite(value) && Number(value) >= 0) ||
					continuation.region.width <= 0 ||
					continuation.region.height <= 0,
			)
		) {
			throw new Error(`Invalid continuation annotation at asset index ${index}`);
		}
		if (
			dataset.schemaVersion === 2 &&
			asset.continuationRegions?.some((continuation) => !annotatedPages.has(continuation.page))
		) {
			throw new Error(`Continuation page is outside annotatedPages at asset index ${index}`);
		}
		if (asset.subfigureRegions !== undefined) {
			if (!Array.isArray(asset.subfigureRegions) || asset.type !== "figure") {
				throw new Error(`Invalid subfigure annotation at asset index ${index}`);
			}
			const labels = new Set<string>();
			for (const subfigure of asset.subfigureRegions) {
				const label = typeof subfigure?.label === "string" ? normalizedSubfigureLabel(subfigure.label) : "";
				if (
					!label ||
					label.length > 50 ||
					labels.has(label) ||
					![subfigure.region?.x, subfigure.region?.y, subfigure.region?.width, subfigure.region?.height].every(
						(value) => Number.isFinite(value) && Number(value) >= 0,
					) ||
					subfigure.region.width <= 0 ||
					subfigure.region.height <= 0
				) {
					throw new Error(`Invalid subfigure annotation at asset index ${index}`);
				}
				labels.add(label);
			}
		}
	}
	return dataset;
}

export function registerPdfAssetEvaluationTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "evaluate_pdf_asset_detection",
		label: "Evaluate PDF asset detection",
		description:
			"Run figure/table/caption/mention/subfigure detection against a local gold annotation JSON file and report precision, recall, crop IoU, and individual errors. Real PDFs and annotations can remain outside Git.",
		promptSnippet: "Measure PDF figure/table detection quality on an annotated regression paper",
		promptGuidelines: [
			"Use this for development regression and release acceptance, not as evidence about a paper's claims.",
			"Keep copyrighted PDFs outside the repository unless redistribution is explicitly permitted.",
		],
		parameters: Type.Object({
			annotation_path: Type.String({ description: "JSON file with schemaVersion, pdfPath, and assets[]" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const annotationPath = resolve(ctx.cwd, params.annotation_path);
			const dataset = parseAssetEvaluationDataset(JSON.parse(await readFile(annotationPath, "utf8")));
			const pdfPath = await validatePdfPath(resolve(dirname(annotationPath), dataset.pdfPath), ctx.cwd);
			if (dataset.pdfSha256) {
				const actualHash = createHash("sha256")
					.update(await readFile(pdfPath))
					.digest("hex");
				if (actualHash !== dataset.pdfSha256.toLowerCase()) {
					throw new Error(`PDF SHA-256 mismatch: annotation=${dataset.pdfSha256} actual=${actualHash}`);
				}
			}
			const layout = await pi.exec("pdftotext", ["-tsv", "-r", "72", "-enc", "UTF-8", pdfPath, "-"], {
				cwd: dirname(pdfPath),
				signal,
				timeout: 180_000,
			});
			if (layout.code !== 0 || layout.killed || signal?.aborted) {
				throw new Error(layout.stderr.trim() || "pdftotext -tsv failed during asset evaluation");
			}
			const layouts = parsePdfTsv(layout.stdout);
			const textAssets = detectPaperAssets(layouts);
			const detected = await refinePaperAssetRegions(
				pi,
				pdfPath,
				layouts,
				await augmentPaperAssetsWithOcr(pi, pdfPath, layouts, textAssets, { signal }),
				signal,
			);
			const evaluation = evaluatePaperAssets(detected, dataset.assets, { annotatedPages: dataset.annotatedPages });
			return {
				content: [
					{
						type: "text",
						text: [
							`PDF: ${pdfPath}`,
							`Gold/detected: ${dataset.assets.length}/${detected.length}`,
							`Caption precision/recall: ${evaluation.captionPrecision.toFixed(3)}/${evaluation.captionRecall.toFixed(3)}`,
							`Mean crop IoU: ${evaluation.cropIouMean.toFixed(3)}`,
							`Median/P10 crop IoU: ${evaluation.cropIouMedian.toFixed(3)}/${evaluation.cropIouP10.toFixed(3)}`,
							`Crop IoU pass rate @0.50/@0.75: ${evaluation.cropIouAt50.toFixed(3)}/${evaluation.cropIouAt75.toFixed(3)}`,
							`Mention precision/recall: ${evaluation.mentionPrecision.toFixed(3)}/${evaluation.mentionRecall.toFixed(3)}`,
							`Continuation precision/recall/mean IoU: ${evaluation.continuationPrecision.toFixed(3)}/${evaluation.continuationRecall.toFixed(3)}/${evaluation.continuationCropIouMean.toFixed(3)}`,
							`Subfigure precision/recall/mean IoU: ${evaluation.subfigurePrecision.toFixed(3)}/${evaluation.subfigureRecall.toFixed(3)}/${evaluation.subfigureCropIouMean.toFixed(3)}`,
							`Missed/false positives: ${evaluation.missedCount}/${evaluation.falsePositiveCount}`,
						].join("\n"),
					},
				],
				details: { annotationPath, pdfPath, detectedCount: detected.length, ...evaluation },
			};
		},
	});
}
