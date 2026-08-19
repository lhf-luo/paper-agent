import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireArtifacts, artifactAcquisitionPlan, assertArtifactSelection } from "../src/artifact-acquisition.ts";
import type { ArtifactManifest } from "../src/literature-types.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

const temporaryPaths: string[] = [];

async function authorize(
	manifest: ArtifactManifest,
	options: { candidateIds?: string[]; maxArtifacts: number; maxBytesPerArtifact: number },
) {
	const manager = new OperationConsentManager();
	const prepared = await manager.prepare(artifactAcquisitionPlan(manifest, options));
	const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "test-user");
	return { manager, grant };
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact acquisition manifest", () => {
	it("reuses an existing provenance snapshot without repeating network acquisition", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		const pdfSha256 = "a".repeat(64);
		const artifactRoot = join(root, "artifacts", `paper-${pdfSha256.slice(0, 12)}`);
		const localPath = join(artifactRoot, "downloads", "existing.zip");
		await mkdir(join(artifactRoot, "downloads"), { recursive: true });
		await writeFile(localPath, "existing");
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath,
			pdfSha256,
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-existing",
					url: "https://example.org/existing.zip",
					kind: "supplement",
					host: "example.org",
					confidence: "medium",
					sources: [{ method: "pdftotext", page: 2 }],
				},
			],
			acquisitions: [
				{
					candidateId: "artifact-existing",
					sourceUrl: "https://example.org/existing.zip",
					status: "downloaded",
					localPath,
					retrievedAt: "2026-01-01T00:01:00.000Z",
					sha256: createHash("sha256").update("existing").digest("hex"),
					bytes: 8,
				},
			],
		};
		await writeFile(join(artifactRoot, "artifact-manifest.json"), JSON.stringify(manifest));
		const exec = vi.fn();
		const inputManifest = { ...manifest, acquisitions: [] };
		const options = { maxArtifacts: 10, maxBytesPerArtifact: 1024 };
		const result = await acquireArtifacts({ exec } as unknown as ExtensionAPI, inputManifest, {
			...options,
			authorization: await authorize(inputManifest, options),
		});

		expect(exec).not.toHaveBeenCalled();
		expect(result.manifest.acquisitions).toHaveLength(2);
		expect(result.manifest.acquisitions.at(-1)).toMatchObject({
			candidateId: "artifact-existing",
			status: "skipped",
			localPath,
		});
		expect(await readFile(result.manifestPath, "utf8")).toContain(
			"integrity-verified provenance snapshot without repeated network acquisition",
		);
	});

	it("refuses to reuse a downloaded snapshot whose content no longer matches its manifest hash", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-tamper-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		const pdfSha256 = "d".repeat(64);
		const artifactRoot = join(root, "artifacts", `paper-${pdfSha256.slice(0, 12)}`);
		const localPath = join(artifactRoot, "downloads", "existing.zip");
		await mkdir(join(artifactRoot, "downloads"), { recursive: true });
		await writeFile(localPath, "tampered");
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath,
			pdfSha256,
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-tampered",
					url: "https://example.org/existing.zip",
					kind: "supplement",
					host: "example.org",
					confidence: "medium",
					sources: [{ method: "pdftotext", page: 2 }],
				},
			],
			acquisitions: [
				{
					candidateId: "artifact-tampered",
					sourceUrl: "https://example.org/existing.zip",
					status: "downloaded",
					localPath,
					retrievedAt: "2026-01-01T00:01:00.000Z",
					sha256: "e".repeat(64),
				},
			],
		};
		await writeFile(join(artifactRoot, "artifact-manifest.json"), JSON.stringify(manifest));
		const inputManifest = { ...manifest, acquisitions: [] };
		const options = { maxArtifacts: 10, maxBytesPerArtifact: 1024 };
		const result = await acquireArtifacts({ exec: vi.fn() } as unknown as ExtensionAPI, inputManifest, {
			...options,
			authorization: await authorize(inputManifest, options),
		});

		expect(result.manifest.acquisitions.at(-1)).toMatchObject({
			candidateId: "artifact-tampered",
			status: "failed",
			localPath,
		});
		expect(result.manifest.acquisitions.at(-1)?.failureReason).toMatch(/SHA-256 mismatch/);
	});

	it("does not trust an existing manifest path outside the paper artifact root", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-boundary-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		const pdfSha256 = "c".repeat(64);
		const artifactRoot = join(root, "artifacts", `paper-${pdfSha256.slice(0, 12)}`);
		const outsidePath = join(root, "outside-repository");
		await mkdir(outsidePath, { recursive: true });
		await mkdir(artifactRoot, { recursive: true });
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath,
			pdfSha256,
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-outside",
					url: "https://127.0.0.1/repository",
					kind: "repository",
					host: "127.0.0.1",
					confidence: "low",
					sources: [{ method: "pdftotext", page: 1 }],
				},
			],
			acquisitions: [
				{
					candidateId: "artifact-outside",
					sourceUrl: "https://127.0.0.1/repository",
					status: "cloned",
					localPath: outsidePath,
					retrievedAt: "2026-01-01T00:01:00.000Z",
				},
			],
		};
		await writeFile(join(artifactRoot, "artifact-manifest.json"), JSON.stringify(manifest));
		const exec = vi.fn();
		const inputManifest = { ...manifest, acquisitions: [] };
		const options = {
			candidateIds: ["artifact-outside"],
			maxArtifacts: 10,
			maxBytesPerArtifact: 1024,
		};
		const result = await acquireArtifacts({ exec } as unknown as ExtensionAPI, inputManifest, {
			...options,
			authorization: await authorize(inputManifest, options),
		});

		expect(exec).not.toHaveBeenCalled();
		expect(result.manifest.acquisitions.at(-1)).toMatchObject({
			candidateId: "artifact-outside",
			status: "failed",
		});
		expect(result.manifest.acquisitions.at(-1)?.failureReason).toMatch(/outside this paper's artifact root/);
	});

	it("excludes low-confidence candidates by default but allows an explicit selection", () => {
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: "C:/papers/example.pdf",
			pdfSha256: "f".repeat(64),
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-high",
					url: "https://github.com/example/high",
					kind: "repository",
					host: "github.com",
					confidence: "high",
					sources: [{ method: "pdftotext", page: 1 }],
				},
				{
					id: "artifact-low",
					url: "https://github.com/example/citation",
					kind: "repository",
					host: "github.com",
					confidence: "low",
					sources: [{ method: "pdftotext", page: 9 }],
				},
			],
			acquisitions: [],
		};

		expect(artifactAcquisitionPlan(manifest, { maxArtifacts: 10, maxBytesPerArtifact: 1024 })).toMatchObject({
			targets: [{ value: "https://github.com/example/high" }],
			details: { candidateIds: ["artifact-high"], excludedLowConfidenceCount: 1 },
		});
			expect(
				artifactAcquisitionPlan(manifest, {
				candidateIds: ["artifact-low"],
				maxArtifacts: 10,
				maxBytesPerArtifact: 1024,
			}),
			).toMatchObject({
				targets: [{ value: "https://github.com/example/citation", risk: "high" }],
				details: { candidateIds: ["artifact-low"], excludedLowConfidenceCount: 0 },
			});
			const lowOnly = { ...manifest, candidates: manifest.candidates.filter((candidate) => candidate.id === "artifact-low") };
			expect(() => assertArtifactSelection(lowOnly)).toThrow(/Only low-confidence/);
			expect(() => assertArtifactSelection(manifest, [])).toThrow(/Select at least one/);
		});
});
