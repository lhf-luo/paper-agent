import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactEvaluationReviewService,
	type ArtifactReviewSubmissionInput,
} from "../src/artifact-evaluation-review.ts";
import type { CommandExecutor } from "../src/command-executor.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-review-"));
	temporaryPaths.push(root);
	const artifactRoot = join(root, "eval-data", "artifacts");
	const pdfRoot = join(root, "eval-data", "pdfs");
	await mkdir(join(artifactRoot, "candidates"), { recursive: true });
	await mkdir(join(artifactRoot, "annotations"), { recursive: true });
	await mkdir(pdfRoot, { recursive: true });
	const pdf = Buffer.from("%PDF-1.4\nreview fixture\n");
	const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
	await writeFile(join(pdfRoot, "fixture.pdf"), pdf);
	await writeFile(
		join(artifactRoot, "sources.json"),
		JSON.stringify([
			{
				slug: "fixture",
				title: "Artifact Review Fixture",
				paperId: "arxiv:0000.00000",
				pdfPath: "../pdfs/fixture.pdf",
				pdfSha256,
				sourceUrl: "https://arxiv.org/pdf/0000.00000",
				status: "available",
				tags: ["fixture"],
			},
		]),
	);
	await writeFile(
		join(artifactRoot, "candidates", "fixture.json"),
		JSON.stringify({
			schemaVersion: 1,
			annotationStatus: "machine-generated-candidate",
			source: {
				slug: "fixture",
				title: "Artifact Review Fixture",
				paperId: "arxiv:0000.00000",
				pdfPath: "../../pdfs/fixture.pdf",
				pdfSha256,
				sourceUrl: "https://arxiv.org/pdf/0000.00000",
			},
			inspection: { allPagesReviewed: false },
			expectedArtifacts: [],
			ignoredUrls: [],
			detectorCandidates: [
				{
					id: "candidate-repository",
					url: "https://github.com/example/project",
					kind: "repository",
					host: "github.com",
					confidence: "high",
					sources: [{ method: "pdftotext", page: 2, context: "Code is available." }],
				},
			],
		}),
	);
	const executor: CommandExecutor = {
		exec: async () => ({ stdout: "Pages:          2\n", stderr: "", code: 0, killed: false }),
	};
	const consent = new OperationConsentManager();
	const service = new ArtifactEvaluationReviewService({
		projectRoot: root,
		dataRoot: join(root, ".paper-agent"),
		artifactRoot,
		executor,
		consent,
	});
	const submission: ArtifactReviewSubmissionInput = {
		reviewer: "human-researcher",
		reviewedAt: "2026-08-07T08:00:00.000Z",
		reviewedPages: [1, 2],
		notes: "Every physical page was inspected independently.",
		candidateReviews: [
			{
				candidateId: "candidate-repository",
				disposition: "expected",
				artifactId: "official-code",
				kind: "repository",
				acceptedUrls: ["https://github.com/example/project.git"],
				pages: [2],
			},
		],
		manualArtifacts: [
			{
				id: "missed-dataset",
				urls: ["https://zenodo.org/records/12345"],
				kind: "dataset",
				pages: [1],
				note: "Detector-missed dataset recorded by the reviewer.",
			},
		],
	};
	return { root, artifactRoot, service, consent, submission };
}

describe("artifact evaluation review service", () => {
	it("loads the pinned PDF and candidate snapshot, then writes gold only after exact confirmation", async () => {
		const { artifactRoot, service, consent, submission } = await fixture();
		const queue = await service.list();
		expect(queue.totals).toMatchObject({ papers: 1, humanReviewed: 0, pending: 1, candidates: 1 });
		const detail = await service.detail("fixture");
		expect(detail).toMatchObject({ pageCount: 2, candidates: [{ id: "candidate-repository" }] });

		const prepared = await service.prepare("fixture", submission);
		expect(prepared.kind).toBe("artifact-evaluation-write");
		const grant = await consent.confirm(prepared.operationId, prepared.manifestFingerprint, "human-researcher");
		const saved = await service.save("fixture", submission, grant);
		expect(saved.annotation).toMatchObject({
			annotationStatus: "human-reviewed",
			inspection: { pageCount: 2, reviewedPages: [1, 2], reviewer: "human-researcher" },
			expectedArtifacts: expect.arrayContaining([
				expect.objectContaining({ id: "official-code", pages: [2] }),
				expect.objectContaining({ id: "missed-dataset", pages: [1] }),
			]),
		});
		const onDisk = JSON.parse(await readFile(join(artifactRoot, "annotations", "fixture.json"), "utf8"));
		expect(onDisk.inspection.reviewedPages).toEqual([1, 2]);
		expect((await service.list()).totals.humanReviewed).toBe(1);
	});

	it("rejects incomplete page inspection and unclassified candidates", async () => {
		const { service, submission } = await fixture();
		await expect(service.prepare("fixture", { ...submission, reviewedPages: [1] })).rejects.toThrow(
			"Every physical PDF page",
		);
		await expect(service.prepare("fixture", { ...submission, candidateReviews: [] })).rejects.toThrow(
			"Every detector candidate",
		);
	});

	it("rejects execution when the reviewed annotation changes after confirmation", async () => {
		const { artifactRoot, service, consent, submission } = await fixture();
		const prepared = await service.prepare("fixture", submission);
		const grant = await consent.confirm(prepared.operationId, prepared.manifestFingerprint, "human-researcher");
		const changed = {
			...submission,
			manualArtifacts: [{ ...submission.manualArtifacts![0], note: "Changed after confirmation" }],
		};
		await expect(service.save("fixture", changed, grant)).rejects.toThrow("manifest");
		await expect(readFile(join(artifactRoot, "annotations", "fixture.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects URL aliases that would assign one canonical Artifact URL to multiple gold ids", async () => {
		const { service, submission } = await fixture();
		const sharedAlias = "https://example.org/artifacts/shared-release";
		await expect(
			service.prepare("fixture", {
				...submission,
				candidateReviews: [
					{
						...submission.candidateReviews[0],
						acceptedUrls: [...(submission.candidateReviews[0].acceptedUrls ?? []), sharedAlias],
					},
				],
				manualArtifacts: [
					...(submission.manualArtifacts ?? []),
					{ id: "conflicting-manual", urls: [sharedAlias], kind: "supplement", pages: [2] },
				],
			}),
		).rejects.toThrow("same canonical URL");

		await expect(
			service.prepare("fixture", {
				...submission,
				manualArtifacts: [
					{ id: "manual-one", urls: [sharedAlias], kind: "dataset", pages: [1] },
					{ id: "manual-two", urls: [sharedAlias], kind: "supplement", pages: [2] },
				],
			}),
		).rejects.toThrow("same canonical URL");
	});
});
