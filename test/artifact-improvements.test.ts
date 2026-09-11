import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectArtifactCandidates } from "../src/artifacts/application/artifact-acquisition.ts";
import { resolveArtifactSourceMetadata } from "../src/artifacts/application/artifact-content.ts";
import {
	discoverArtifactsFromPdf,
	extractArtifactCandidates,
} from "../src/artifacts/application/artifact-discovery.ts";

const temporaryPaths: string[] = [];
const publicResolver = async () => [{ address: "93.184.216.34" }];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact discovery improvements", () => {
	it("prefers clean LaTeX provenance and marks third-party repositories", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-latex-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		const sourceDirectory = join(root, "source");
		await mkdir(sourceDirectory);
		await writeFile(pdfPath, "%PDF-fixture");
		await writeFile(
			join(sourceDirectory, "main.tex"),
			String.raw`Our code is available at \url{https://github.com/authors/official}.`,
		);
		const exec = vi.fn(async (command: string) =>
			command === "pdfinfo"
				? { code: 0, stdout: "", stderr: "", killed: false }
				: {
						code: 0,
						stdout: "We use the tokenizer from https://github.com/baseline/tokenizer.\f",
						stderr: "",
						killed: false,
					},
		);
		const manifest = await discoverArtifactsFromPdf({ exec }, pdfPath, undefined, sourceDirectory);
		const official = manifest.candidates.find((candidate) => candidate.url.includes("authors/official"));
		const baseline = manifest.candidates.find((candidate) => candidate.url.includes("baseline/tokenizer"));
		expect(official).toMatchObject({ confidence: "high", relationship: "author-released" });
		expect(official?.sources[0]).toMatchObject({ method: "latex-source", path: "main.tex" });
		expect(baseline).toMatchObject({ confidence: "low", relationship: "third-party" });
		expect(selectArtifactCandidates(manifest).map((candidate) => candidate.url)).toEqual([
			"https://github.com/authors/official",
		]);
	});

	it("recognizes current Papers with Code and anonymous artifact hosts", () => {
		const candidates = extractArtifactCandidates(
			[
				"Our project page is available at https://paperswithcode.co/paper/example.",
				"Our anonymous code is available at https://anonymous.4open.science/r/example-1234.",
			].join("\n"),
			"pdftotext",
			1,
		);
		expect(candidates.map((candidate) => candidate.host).sort()).toEqual([
			"anonymous.4open.science",
			"paperswithcode.co",
		]);
		expect(candidates.find((candidate) => candidate.host === "paperswithcode.co")?.kind).toBe("project");
	});
});

describe("artifact platform metadata", () => {
	it("expands Hugging Face dataset files", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				sha: "abc123",
				lastModified: "2026-01-01T00:00:00Z",
				siblings: [{ rfilename: "data/test.zip", lfs: { size: 42, sha256: "a".repeat(64) } }],
			}),
		);
		const metadata = await resolveArtifactSourceMetadata(
			{
				id: "hf",
				url: "https://huggingface.co/datasets/example/paper-data",
				kind: "dataset",
				host: "huggingface.co",
				sources: [],
				confidence: "high",
			},
			{ fetcher, resolver: publicResolver },
		);
		expect(metadata).toMatchObject({ provider: "huggingface", recordId: "example/paper-data", version: "abc123" });
		expect(metadata?.files?.[0]).toMatchObject({
			name: "data/test.zip",
			bytes: 42,
			checksum: `sha256:${"a".repeat(64)}`,
		});
	});

	it("expands OSF and Dataverse landing pages through their APIs", async () => {
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.hostname === "api.osf.io" && url.pathname.endsWith("/files/")) {
				return Response.json({
					data: [
						{ relationships: { files: { links: { related: { href: "https://api.osf.io/v2/files/root/" } } } } },
					],
				});
			}
			if (url.hostname === "api.osf.io") {
				return Response.json({
					data: [
						{
							attributes: { name: "artifact.zip", size: 12, kind: "file" },
							links: { download: "https://osf.io/download/abc/" },
						},
					],
				});
			}
			return Response.json({
				data: {
					latestVersion: {
						versionNumber: 2,
						versionMinorNumber: 1,
						files: [
							{
								dataFile: {
									id: 9,
									filename: "data.csv",
									filesize: 20,
									checksum: { type: "MD5", value: "b".repeat(32) },
								},
							},
						],
					},
				},
			});
		});
		const base = { kind: "dataset" as const, sources: [], confidence: "high" as const };
		const osf = await resolveArtifactSourceMetadata(
			{ ...base, id: "osf", url: "https://osf.io/abc12/", host: "osf.io" },
			{ fetcher, resolver: publicResolver },
		);
		const dataverse = await resolveArtifactSourceMetadata(
			{
				...base,
				id: "dv",
				url: "https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/ABC",
				host: "dataverse.harvard.edu",
			},
			{ fetcher, resolver: publicResolver },
		);
		expect(osf).toMatchObject({ provider: "osf", recordId: "abc12", files: [{ name: "artifact.zip" }] });
		expect(dataverse).toMatchObject({
			provider: "dataverse",
			recordId: "doi:10.7910/DVN/ABC",
			version: "2.1",
			files: [{ name: "data.csv", checksum: `MD5:${"b".repeat(32)}` }],
		});
	});
});
