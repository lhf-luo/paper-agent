import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverArtifactsFromPdf, sha256File } from "../src/artifact-discovery.ts";
import {
	evaluateArtifactDiscovery,
	type ArtifactDiscoveryEvaluation,
	type ArtifactGoldAnnotation,
	validateArtifactGoldAnnotation,
} from "../src/artifact-evaluation.ts";
import { NodeCommandExecutor } from "../src/command-executor.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(projectRoot, process.argv[2] ?? "eval-data/artifacts");
const annotationRoot = join(artifactRoot, "annotations");
const candidateRoot = join(artifactRoot, "candidates");
const check = process.argv.includes("--check");
const outputArgument = process.argv.indexOf("--output");
const outputPath = outputArgument >= 0 ? resolve(projectRoot, process.argv[outputArgument + 1] ?? "") : undefined;
const minimumPapers = 30;
const minimumExpectedArtifacts = 20;
const sources = JSON.parse(await readFile(join(artifactRoot, "sources.json"), "utf8")) as Array<{
	slug: string;
	status: "available" | "pending-download";
}>;

const names = (await readdir(annotationRoot).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
const executor = new NodeCommandExecutor();
const evaluations: ArtifactDiscoveryEvaluation[] = [];
const pending: string[] = [];
const annotated = new Set<string>();
let candidateSnapshotCount = 0;
let sourcesWithCandidates = 0;
const candidateSnapshotErrors: Array<{ slug: string; error: string }> = [];
for (const source of sources) {
	try {
		const snapshot = JSON.parse(await readFile(join(candidateRoot, `${source.slug}.json`), "utf8")) as ArtifactGoldAnnotation;
		validateArtifactGoldAnnotation(snapshot);
		candidateSnapshotCount += snapshot.detectorCandidates?.length ?? 0;
		sourcesWithCandidates++;
	} catch (error) {
		// Candidate snapshots are local review aids and are not required to evaluate committed gold annotations.
		candidateSnapshotErrors.push({ slug: source.slug, error: error instanceof Error ? error.message : String(error) });
	}
}
for (const name of names) {
	const annotationPath = join(annotationRoot, name);
	const annotation = JSON.parse(await readFile(annotationPath, "utf8")) as ArtifactGoldAnnotation;
	validateArtifactGoldAnnotation(annotation);
	annotated.add(annotation.source.slug);
	if (annotation.annotationStatus !== "human-reviewed") {
		pending.push(annotation.source.slug);
		continue;
	}
	const pdfPath = resolve(annotationRoot, annotation.source.pdfPath);
	if ((await sha256File(pdfPath)) !== annotation.source.pdfSha256) {
		throw new Error(`Pinned PDF SHA-256 changed for ${annotation.source.slug}`);
	}
	evaluations.push(evaluateArtifactDiscovery(annotation, await discoverArtifactsFromPdf(executor, pdfPath)));
}
for (const source of sources) {
	if (!annotated.has(source.slug)) pending.push(source.slug);
}

const totals = evaluations.reduce(
	(accumulator, evaluation) => ({
		truePositives: accumulator.truePositives + evaluation.truePositives,
		falsePositives: accumulator.falsePositives + evaluation.falsePositives,
		falseNegatives: accumulator.falseNegatives + evaluation.falseNegatives,
		kindCorrect: accumulator.kindCorrect + evaluation.kindCorrect,
		kindEvaluated: accumulator.kindEvaluated + evaluation.kindEvaluated,
		pageCorrect: accumulator.pageCorrect + evaluation.pageCorrect,
		pageEvaluated: accumulator.pageEvaluated + evaluation.pageEvaluated,
		provenanceComplete: accumulator.provenanceComplete + evaluation.provenanceComplete,
	}),
	{
		truePositives: 0,
		falsePositives: 0,
		falseNegatives: 0,
		kindCorrect: 0,
		kindEvaluated: 0,
		pageCorrect: 0,
		pageEvaluated: 0,
		provenanceComplete: 0,
	},
);
const ratio = (numerator: number, denominator: number): number | null =>
	denominator === 0 ? null : numerator / denominator;
const precision = ratio(totals.truePositives, totals.truePositives + totals.falsePositives);
const recall = ratio(totals.truePositives, totals.truePositives + totals.falseNegatives);
const kindAccuracy = ratio(totals.kindCorrect, totals.kindEvaluated);
const pageAccuracy = ratio(totals.pageCorrect, totals.pageEvaluated);
const provenanceCompleteness = ratio(totals.provenanceComplete, totals.truePositives);
const uniquePending = [...new Set(pending)].sort();
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	sourcePapers: sources.length,
	availableSourcePapers: sources.filter((source) => source.status === "available").length,
	sourcesWithCandidateSnapshots: sourcesWithCandidates,
	candidateSnapshotCount,
	candidateSnapshotErrors,
	papers: evaluations.length,
	reviewCoverage: sources.length ? evaluations.length / sources.length : 0,
	pendingAnnotations: uniquePending,
	expectedArtifacts: totals.truePositives + totals.falseNegatives,
	predictedArtifacts: totals.truePositives + totals.falsePositives,
	precision,
	recall,
	kindAccuracy,
	pageAccuracy,
	provenanceCompleteness,
	readyForReleaseGate:
		evaluations.length >= minimumPapers &&
		uniquePending.length === 0 &&
		totals.truePositives + totals.falseNegatives >= minimumExpectedArtifacts,
	totals,
	evaluations,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, output, "utf8");
console.log(output.trimEnd());

if (check) {
	const below = (value: number | null, threshold: number) => value === null || value < threshold;
	const failures = [
		evaluations.length < minimumPapers ? `human-reviewed papers ${evaluations.length} < ${minimumPapers}` : undefined,
		report.expectedArtifacts < minimumExpectedArtifacts
			? `expected artifacts ${report.expectedArtifacts} < ${minimumExpectedArtifacts}`
			: undefined,
		below(report.precision, 0.9) ? `precision ${report.precision?.toFixed(4) ?? "not measured"} < 0.9000` : undefined,
		below(report.recall, 0.9) ? `recall ${report.recall?.toFixed(4) ?? "not measured"} < 0.9000` : undefined,
		below(report.kindAccuracy, 0.9)
			? `kind accuracy ${report.kindAccuracy?.toFixed(4) ?? "not measured"} < 0.9000`
			: undefined,
		below(report.provenanceCompleteness, 1)
			? `provenance completeness ${report.provenanceCompleteness?.toFixed(4) ?? "not measured"} < 1.0000`
			: undefined,
		uniquePending.length ? `${uniquePending.length} source papers are not human-reviewed` : undefined,
	].filter((failure): failure is string => Boolean(failure));
	if (failures.length) throw new Error(`Artifact discovery release gate failed:\n- ${failures.join("\n- ")}`);
}
