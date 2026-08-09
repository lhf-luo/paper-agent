import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
}

const projectRoot = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(projectRoot, process.argv[2] ?? "eval-data/artifacts");
const requestedSlug = process.argv.find((argument) => argument.startsWith("--slug="))?.slice("--slug=".length);
const sourcePath = join(artifactRoot, "sources.json");
const candidateRoot = join(artifactRoot, "candidates");
const outputRoot = join(artifactRoot, "review-workspaces");
const sources = JSON.parse(await readFile(sourcePath, "utf8")) as ArtifactEvaluationSource[];
const selected = requestedSlug ? sources.filter((source) => source.slug === requestedSlug) : sources;
if (requestedSlug && selected.length === 0) throw new Error(`Unknown artifact evaluation slug: ${requestedSlug}`);
const executor = new NodeCommandExecutor();
await mkdir(outputRoot, { recursive: true });
const indexRows: string[] = ["# Artifact review workspaces", "", "| Paper | Pages | Candidates | Workspace |", "| --- | ---: | ---: | --- |"];

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

for (const source of selected) {
	if (!source.pdfSha256 || source.status !== "available") {
		throw new Error(`${source.slug}: PDF is not downloaded and hash-pinned`);
	}
	const pdfPath = resolve(artifactRoot, source.pdfPath);
	const candidatePath = join(candidateRoot, `${source.slug}.json`);
	const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as ArtifactGoldAnnotation;
	const detectorCandidates = candidate.detectorCandidates ?? [];
	const info = await executor.exec("pdfinfo", [pdfPath], { timeout: 30_000 });
	if (info.code !== 0 || info.killed) throw new Error(`${source.slug}: ${info.stderr.trim() || "pdfinfo failed"}`);
	const pageCount = Number(/^Pages:\s+(\d+)\s*$/im.exec(info.stdout)?.[1]);
	if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error(`${source.slug}: pdfinfo did not report a page count`);
	const workspaceName = `${source.slug}.md`;
	const lines = [
		`# ${source.title}`,
		"",
		`- Slug: \`${source.slug}\``,
		`- Paper: ${source.paperId ?? "not supplied"}`,
		`- Source: ${source.sourceUrl}`,
		`- Local PDF: \`${pdfPath}\``,
		`- SHA-256: \`${source.pdfSha256}\``,
		`- Physical pages: ${pageCount}`,
		"",
		"## Review rules",
		"",
		"Inspect every physical page independently. Record only artifacts belonging to this paper; put citation-only repositories, datasets, and archival links in `ignoredUrls`. Do not promote the detector snapshot unchanged. After review, copy and edit the candidate JSON under `annotations/`, set `annotationStatus` to `human-reviewed`, and provide reviewer identity and timestamp.",
		"",
		"## Page checklist",
		"",
		...Array.from({ length: pageCount }, (_value, index) => `- [ ] Page ${index + 1}`),
		"",
		"## Detector candidates (not gold)",
		"",
		"| Kind | Confidence | Pages | URL | Context |",
		"| --- | --- | --- | --- | --- |",
		...detectorCandidates.map((item) => {
			const pages = [...new Set(item.sources.map((entry) => entry.page).filter((page): page is number => Boolean(page)))];
			const context = item.sources.map((entry) => entry.context).find((value) => value?.trim()) ?? "";
			return `| ${item.kind} | ${item.confidence} | ${pages.join(", ") || "metadata"} | ${escapeCell(item.url)} | ${escapeCell(context.slice(0, 320))} |`;
		}),
		"",
		`Candidate JSON: \`${candidatePath}\``,
		"",
	];
	await writeFile(join(outputRoot, workspaceName), lines.join("\n"), "utf8");
	indexRows.push(`| ${escapeCell(source.title)} | ${pageCount} | ${detectorCandidates.length} | [open](./${workspaceName}) |`);
}

await writeFile(join(outputRoot, "README.md"), `${indexRows.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ outputRoot, paperCount: selected.length, requestedSlug: requestedSlug ?? null }, null, 2));
