import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluatePaperAssets, parseAssetEvaluationDataset } from "../src/pdf-asset-evaluation.ts";
import {
	augmentPaperAssetsWithOcr,
	detectPaperAssets,
	parsePdfTsv,
	refinePaperAssetRegions,
} from "../src/pdf-asset-tools.ts";

const annotationsDirectory = resolve(process.argv[2] ?? "eval-data/annotations");
const enforceReleaseGate = process.argv.includes("--check");
const baselinePath = resolve("eval-data/baseline.json");
const pdftotext = process.env.PDFTOTEXT_BIN || "pdftotext";
const pdftoppm = process.env.PDFTOPPM_BIN || "pdftoppm";

const pi = {
	async exec(command: string, args: string[], options: { cwd?: string } = {}) {
		const result = spawnSync(command === "pdftoppm" ? pdftoppm : command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: 128 * 1024 * 1024,
		});
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
	},
} as unknown as ExtensionAPI;

const annotationFiles = (await readdir(annotationsDirectory)).filter((name) => name.endsWith(".json")).sort();
const papers = [];
for (const name of annotationFiles) {
	const annotationPath = join(annotationsDirectory, name);
	const dataset = parseAssetEvaluationDataset(JSON.parse(await readFile(annotationPath, "utf8")));
	if (dataset.annotationStatus !== "human-reviewed") {
		throw new Error(`${name}: release annotations must declare annotationStatus=human-reviewed`);
	}
	const pdfPath = resolve(dirname(annotationPath), dataset.pdfPath);
	const pdf = await readFile(pdfPath);
	const actualHash = createHash("sha256").update(pdf).digest("hex");
	if (dataset.pdfSha256 && actualHash !== dataset.pdfSha256.toLowerCase())
		throw new Error(`SHA-256 mismatch: ${name}`);
	const layout = spawnSync(pdftotext, ["-tsv", "-r", "72", "-enc", "UTF-8", pdfPath, "-"], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	if (layout.status !== 0) throw new Error(layout.stderr || `pdftotext failed: ${name}`);
	const layouts = parsePdfTsv(layout.stdout);
	const detected = await refinePaperAssetRegions(
		pi,
		pdfPath,
		layouts,
		await augmentPaperAssetsWithOcr(pi, pdfPath, layouts, detectPaperAssets(layouts), {
			pages: new Set(dataset.annotatedPages),
		}),
	);
	const metrics = evaluatePaperAssets(detected, dataset.assets, { annotatedPages: dataset.annotatedPages });
	papers.push({
		annotation: name,
		metadata: dataset.metadata,
		annotatedPageCount: new Set(dataset.annotatedPages ?? []).size,
		goldCount: dataset.assets.length,
		metrics,
		detectedOnAnnotatedPages: detected
			.filter((asset) => dataset.annotatedPages?.includes(asset.page))
			.map((asset) => ({
				id: asset.id,
				caption: asset.caption,
				region: asset.candidateRegion,
				subfigureRegions: asset.subfigureRegions,
			})),
	});
}

const sums = papers.reduce(
	(accumulator, paper) => {
		accumulator.gold += paper.goldCount;
		accumulator.truePositives += paper.metrics.truePositives;
		accumulator.falsePositives += paper.metrics.falsePositiveCount;
		accumulator.cropIous.push(...paper.metrics.matched.map((item) => item.cropIou));
		accumulator.mentionTruePositives += paper.metrics.mentionTruePositiveCount;
		accumulator.mentionGold += paper.metrics.mentionGoldCount;
		accumulator.mentionDetected += paper.metrics.mentionDetectedCount;
		accumulator.continuationTruePositives += paper.metrics.continuationTruePositiveCount;
		accumulator.continuationGold += paper.metrics.continuationGoldCount;
		accumulator.continuationDetected += paper.metrics.continuationDetectedCount;
		accumulator.continuationIous.push(...paper.metrics.continuationIous);
		accumulator.subfigureTruePositives += paper.metrics.subfigureTruePositiveCount;
		accumulator.subfigureGold += paper.metrics.subfigureGoldCount;
		accumulator.subfigureDetected += paper.metrics.subfigureDetectedCount;
		accumulator.subfigureIous.push(...paper.metrics.subfigureIous);
		return accumulator;
	},
	{
		gold: 0,
		truePositives: 0,
		falsePositives: 0,
		cropIous: [] as number[],
		mentionTruePositives: 0,
		mentionGold: 0,
		mentionDetected: 0,
		continuationTruePositives: 0,
		continuationGold: 0,
		continuationDetected: 0,
		continuationIous: [] as number[],
		subfigureTruePositives: 0,
		subfigureGold: 0,
		subfigureDetected: 0,
		subfigureIous: [] as number[],
	},
);
const sortedIous = sums.cropIous.sort((left, right) => left - right);
const percentile = (fraction: number) => sortedIous[Math.max(0, Math.ceil(sortedIous.length * fraction) - 1)] ?? 0;
const coverageDomains = [
	...new Set(
		papers
			.flatMap((paper) => paper.metadata?.domains ?? [])
			.map((value) => value.trim())
			.filter(Boolean),
	),
].sort();
const coverageLayouts = [
	...new Set(
		papers
			.flatMap((paper) => paper.metadata?.layouts ?? [])
			.map((value) => value.trim())
			.filter(Boolean),
	),
].sort();
const aggregate = {
	paperCount: papers.length,
	goldAssetCount: sums.gold,
	captionPrecision: sums.truePositives / Math.max(1, sums.truePositives + sums.falsePositives),
	captionRecall: sums.truePositives / Math.max(1, sums.gold),
	cropIouMean: sortedIous.reduce((total, value) => total + value, 0) / Math.max(1, sortedIous.length),
	cropIouMedian: percentile(0.5),
	cropIouP10: percentile(0.1),
	cropIouAt50: sortedIous.filter((value) => value >= 0.5).length / Math.max(1, sortedIous.length),
	cropIouAt75: sortedIous.filter((value) => value >= 0.75).length / Math.max(1, sortedIous.length),
	mentionPrecision: sums.mentionTruePositives / Math.max(1, sums.mentionDetected),
	mentionRecall: sums.mentionTruePositives / Math.max(1, sums.mentionGold),
	continuationPrecision: sums.continuationTruePositives / Math.max(1, sums.continuationDetected),
	continuationRecall: sums.continuationTruePositives / Math.max(1, sums.continuationGold),
	continuationCropIouMean:
		sums.continuationIous.reduce((total, value) => total + value, 0) / Math.max(1, sums.continuationIous.length),
	goldSubfigureCount: sums.subfigureGold,
	detectedSubfigureCount: sums.subfigureDetected,
	subfigureTruePositiveCount: sums.subfigureTruePositives,
	subfigurePrecision: sums.subfigureDetected
		? sums.subfigureTruePositives / sums.subfigureDetected
		: sums.subfigureGold === 0
			? 1
			: 0,
	subfigureRecall: sums.subfigureGold
		? sums.subfigureTruePositives / sums.subfigureGold
		: sums.subfigureDetected === 0
			? 1
			: 0,
	subfigureCropIouMean: sums.subfigureIous.length
		? sums.subfigureIous.reduce((total, value) => total + value, 0) / sums.subfigureIous.length
		: sums.subfigureGold === 0
			? 1
			: 0,
};
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
	dataset: string;
	paperCount: number;
	fullyInspectedPageCount: number;
	goldAssetCount: number;
	goldSubfigureCount?: number;
	requiredLayoutTags?: string[];
	knownGaps?: string[];
	thresholds: Record<string, number>;
};
const thresholds = baseline.thresholds;
const unknownThresholdMetrics = Object.keys(thresholds).filter((metric) => !Object.hasOwn(aggregate, metric));
if (unknownThresholdMetrics.length > 0) {
	throw new Error(`Unknown release-gate threshold metric(s): ${unknownThresholdMetrics.sort().join(", ")}`);
}
const actualAnnotatedPageCount = papers.reduce((total, paper) => total + paper.annotatedPageCount, 0);
const failures: Array<{ metric: string; actual: number; minimum: number }> = Object.entries(thresholds)
	.filter(([metric, minimum]) => aggregate[metric as keyof typeof aggregate] < minimum)
	.map(([metric, minimum]) => ({ metric, actual: aggregate[metric as keyof typeof aggregate], minimum }));
for (const [metric, actual, minimum] of [
	["paperCount", aggregate.paperCount, baseline.paperCount],
	["fullyInspectedPageCount", actualAnnotatedPageCount, baseline.fullyInspectedPageCount],
	["goldAssetCount", aggregate.goldAssetCount, baseline.goldAssetCount],
	["goldSubfigureCount", aggregate.goldSubfigureCount, baseline.goldSubfigureCount ?? 0],
] as const) {
	if (actual < minimum) failures.push({ metric, actual, minimum });
}
for (const layout of baseline.requiredLayoutTags ?? []) {
	if (!coverageLayouts.includes(layout)) failures.push({ metric: `layout:${layout}`, actual: 0, minimum: 1 });
}
console.log(
	JSON.stringify(
		{
			schemaVersion: 1,
			dataset: baseline.dataset,
			fullyInspectedPageCount: actualAnnotatedPageCount,
			coverage: {
				humanReviewedPaperCount: papers.length,
				domains: coverageDomains,
				layouts: coverageLayouts,
				knownGaps: baseline.knownGaps ?? [],
			},
			aggregate,
			releaseGate: { passed: failures.length === 0, thresholds, failures },
			papers,
		},
		null,
		2,
	),
);
if (enforceReleaseGate && failures.length > 0) process.exitCode = 1;
