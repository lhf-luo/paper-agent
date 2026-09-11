import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireArtifacts,
	artifactAcquisitionPlan,
	assertArtifactSelection,
} from "../src/artifacts/application/artifact-acquisition.ts";
import { acquisitionRoot, artifactDirectoryNames } from "../src/artifacts/application/artifact-acquisition-files.ts";
import { cloneRepository } from "../src/artifacts/application/artifact-git-acquisition.ts";
import {
	artifactByteLimit,
	DEFAULT_ARTIFACT_MEGABYTES,
	MAX_ARTIFACT_BYTES,
} from "../src/artifacts/application/artifact-limits.ts";
import {
	buildPaperMaterialPackage,
	hasAvailableArtifact,
	latestArtifactSnapshots,
} from "../src/artifacts/presentation/paper-package-tools.ts";
import type { ArtifactManifest } from "../src/literature/domain/literature-types.ts";
import { OperationConsentManager } from "../src/shared/application/operation-consent.ts";

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
	it("uses 200 MB by default and rejects limits above 500 MB", () => {
		expect(DEFAULT_ARTIFACT_MEGABYTES).toBe(200);
		expect(artifactByteLimit()).toBe(200 * 1024 * 1024);
		expect(artifactByteLimit(500)).toBe(MAX_ARTIFACT_BYTES);
		expect(() => artifactByteLimit(501)).toThrow(/between 1 and 500/);
	});
	it("reuses an existing provenance snapshot without repeating network acquisition", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		const pdfSha256 = "a".repeat(64);
		const artifactRoot = join(root, "artifacts");
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
		expect(result.attemptAcquisitions).toHaveLength(1);
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
		const artifactRoot = join(root, "artifacts");
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
		const artifactRoot = join(root, "artifacts");
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
		const lowOnly = {
			...manifest,
			candidates: manifest.candidates.filter((candidate) => candidate.id === "artifact-low"),
		};
		expect(() => assertArtifactSelection(lowOnly)).toThrow(/Only low-confidence/);
		expect(() => assertArtifactSelection(manifest, [])).toThrow(/Select at least one/);
	});

	it("stores repositories directly below the paper artifact directory with readable project names", () => {
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: "D:/papers/material-1/Long Paper Title.pdf",
			pdfSha256: "a".repeat(64),
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [],
			acquisitions: [],
		};
		const candidate = {
			id: "artifact-45a82915933dc5f1",
			url: "https://github.com/linli1724647576/ValScope",
			kind: "repository" as const,
			host: "github.com",
			confidence: "high" as const,
			sources: [{ method: "pdftotext" as const, page: 3 }],
		};

		expect(acquisitionRoot(manifest)).toBe(join("D:/papers/material-1", "artifacts"));
		expect(artifactDirectoryNames(candidate)).toEqual(["ValScope", "ValScope-linli1724647576", "ValScope-45a82915"]);
	});

	it("treats only the latest existing successful snapshot as an available artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-availability-"));
		temporaryPaths.push(root);
		const repository = join(root, "artifacts", "ValScope");
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: join(root, "paper.pdf"),
			pdfSha256: "b".repeat(64),
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [],
			acquisitions: [
				{
					candidateId: "artifact-repository",
					sourceUrl: "https://github.com/example/repository",
					status: "failed",
					retrievedAt: "2026-01-01T00:00:00.000Z",
					failureReason: "old failure",
				},
				{
					candidateId: "artifact-repository",
					sourceUrl: "https://github.com/example/repository",
					status: "cloned",
					localPath: repository,
					retrievedAt: "2026-01-02T00:00:00.000Z",
				},
			],
		};

		expect(latestArtifactSnapshots([manifest])).toHaveLength(1);
		expect(await hasAvailableArtifact([manifest])).toBe(false);
		expect(
			buildPaperMaterialPackage(
				{
					id: "paper",
					title: "Paper",
					authors: ["Researcher"],
					identifiers: {},
					links: [],
					provenance: [],
					mergedFrom: [],
				},
				[],
				[manifest],
				false,
			).missing,
		).toContain("artifact");
		await mkdir(repository, { recursive: true });
		expect(await hasAvailableArtifact([manifest])).toBe(true);
	});

	it("retries a transient shallow-clone failure into the readable project directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-clone-"));
		temporaryPaths.push(root);
		let cloneCalls = 0;
		let checkoutCalls = 0;
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("clone")) {
				cloneCalls += 1;
				if (cloneCalls === 1) {
					return { code: 1, stdout: "", stderr: "RPC failed: unexpected disconnect; early EOF", killed: false };
				}
				const temporary = args.at(-1)!;
				await mkdir(join(temporary, ".git"), { recursive: true });
				await writeFile(join(temporary, "README.md"), "artifact");
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args.includes("reset")) {
				checkoutCalls += 1;
				return checkoutCalls === 1
					? { code: 1, stdout: "", stderr: "server closed abruptly; early EOF", killed: false }
					: { code: 0, stdout: "HEAD is now ready", stderr: "", killed: false };
			}
			if (args.includes("rev-parse") && args.includes("HEAD")) {
				return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", killed: false };
			}
			if (args.includes("get-url")) {
				return { code: 0, stdout: "https://github.com/example/ValScope.git\n", stderr: "", killed: false };
			}
			if (args.includes("--show-current")) {
				return { code: 0, stdout: "main\n", stderr: "", killed: false };
			}
			if (args.includes("--is-shallow-repository")) {
				return { code: 0, stdout: "true\n", stderr: "", killed: false };
			}
			return { code: 1, stdout: "", stderr: "", killed: false };
		});
		const snapshot = await cloneRepository(
			{ exec } as unknown as ExtensionAPI,
			{
				id: "artifact-valscope",
				url: "https://github.com/example/ValScope",
				kind: "repository",
				host: "github.com",
				confidence: "high",
				sources: [{ method: "pdftotext", page: 3 }],
			},
			join(root, "artifacts"),
			1024 * 1024,
			undefined,
			undefined,
			undefined,
			{ resolver: async () => [{ address: "93.184.216.34" }] },
		);

		expect(snapshot).toMatchObject({
			status: "cloned",
			localPath: join(root, "artifacts", "ValScope"),
			shallow: true,
		});
		const cloneArgs = exec.mock.calls.find((call) => call[1].includes("clone"))?.[1] ?? [];
		expect(cloneArgs).toEqual(
			expect.arrayContaining([
				"clone",
				"--depth",
				"1",
				"--filter=blob:none",
				"--single-branch",
				"--no-tags",
				"--no-checkout",
			]),
		);
		expect(String(cloneArgs.at(-1))).toMatch(/ValScope\.partial-[a-f0-9]{8}$/);
		expect(cloneCalls).toBe(2);
		expect(checkoutCalls).toBe(2);
	});
});
