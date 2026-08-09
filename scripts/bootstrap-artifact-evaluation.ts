import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverArtifactsFromPdf, sha256File } from "../src/artifact-discovery.ts";
import type { ArtifactGoldAnnotation } from "../src/artifact-evaluation.ts";
import { NodeCommandExecutor } from "../src/command-executor.ts";

interface ArtifactEvaluationSource {
	slug: string;
	title: string;
	paperId?: string;
	pdfPath: string;
	pdfSha256?: string;
	sourceUrl: string;
	status: "available" | "pending-download";
	tags?: string[];
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(projectRoot, process.argv[2] ?? "eval-data/artifacts");
const sourcePath = join(artifactRoot, "sources.json");
const outputRoot = join(artifactRoot, "candidates");
const force = process.argv.includes("--force");
const sources = JSON.parse(await readFile(sourcePath, "utf8")) as ArtifactEvaluationSource[];
const executor = new NodeCommandExecutor();
await mkdir(outputRoot, { recursive: true });

const summary = { generated: 0, skipped: 0, missing: [] as string[], failed: [] as Array<{ slug: string; error: string }> };
for (const source of sources) {
	const outputPath = join(outputRoot, `${source.slug}.json`);
	if (!force) {
		try {
			await access(outputPath);
			summary.skipped++;
			continue;
		} catch {
			// Generate a new candidate below.
		}
	}
	const pdfPath = resolve(artifactRoot, source.pdfPath);
	try {
		await access(pdfPath);
	} catch {
		summary.missing.push(source.slug);
		continue;
	}
	try {
		const pdfSha256 = await sha256File(pdfPath);
		if (source.pdfSha256 && source.pdfSha256 !== pdfSha256) {
			throw new Error(`expected ${source.pdfSha256}, found ${pdfSha256}`);
		}
		const manifest = await discoverArtifactsFromPdf(executor, pdfPath);
		const annotation: ArtifactGoldAnnotation = {
			schemaVersion: 1,
			annotationStatus: "machine-generated-candidate",
			source: {
				slug: source.slug,
				title: source.title,
				paperId: source.paperId,
				pdfPath: relative(outputRoot, pdfPath).replaceAll("\\", "/"),
				pdfSha256,
				sourceUrl: source.sourceUrl,
			},
			inspection: {
				allPagesReviewed: false,
				notes:
					"Machine-generated discovery snapshot only. Inspect every PDF page and independently fill expectedArtifacts and ignoredUrls before changing annotationStatus.",
			},
			expectedArtifacts: [],
			ignoredUrls: [],
			detectorCandidates: manifest.candidates,
		};
		await writeFile(outputPath, `${JSON.stringify(annotation, null, 2)}\n`, "utf8");
		summary.generated++;
	} catch (error) {
		summary.failed.push({ slug: source.slug, error: error instanceof Error ? error.message : String(error) });
	}
}

console.log(JSON.stringify({ sourcePath, outputRoot, sourceCount: sources.length, ...summary }, null, 2));
if (summary.failed.length) process.exitCode = 1;
