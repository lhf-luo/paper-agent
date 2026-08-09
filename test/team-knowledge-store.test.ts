import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactManifest, DerivedRecord } from "../src/literature-types.ts";
import { TeamKnowledgeStore } from "../src/team-knowledge-store.ts";
import { hashTeamTokenValue, TeamTokenRegistry } from "../src/team-token-registry.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function derived(result: unknown = { finding: "traceable" }): DerivedRecord {
	return {
		key: "research-skim-card-one",
		paperId: "paper-one",
		operation: "skim-card",
		inputHashes: ["a".repeat(64)],
		pipelineVersion: "research-workspace-v1",
		normalizedConfig: { humanReviewed: true },
		createdAt: "2026-08-01T00:00:00.000Z",
		createdBy: "local-user",
		result,
	};
}

function artifact(): ArtifactManifest {
	return {
		schemaVersion: 1,
		pdfPath: "D:\\private\\papers\\paper.pdf",
		pdfSha256: "b".repeat(64),
		discoveredAt: "2026-08-01T00:00:00.000Z",
		candidates: [
			{
				id: "artifact-one",
				url: "https://example.org/artifact.zip",
				kind: "supplement",
				host: "example.org",
				sources: [{ method: "pdftotext", page: 3, context: "x".repeat(3_000) }],
				confidence: "high",
			},
		],
		acquisitions: [
			{
				candidateId: "artifact-one",
				sourceUrl: "https://example.org/artifact.zip",
				status: "downloaded",
				localPath: "D:\\private\\artifact.zip",
				retrievedAt: "2026-08-01T00:01:00.000Z",
				sha256: "c".repeat(64),
				licenseFiles: ["D:\\private\\LICENSE"],
				metadataFile: { name: "D:\\private\\metadata.json", url: "https://example.org/metadata.json" },
			},
		],
	};
}

describe("team knowledge store", () => {
	it("reviews derived records and artifacts, resets approval when content changes, and backs up all knowledge", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-knowledge-"));
		temporaryPaths.push(root);
		const namespaceRoot = join(root, "security");
		const store = new TeamKnowledgeStore(namespaceRoot, "security");

		expect(await store.proposeDerived([derived()], "alice")).toMatchObject([{ review: { status: "team-proposed" } }]);
		expect(await store.listDerived()).toEqual([]);
		await store.reviewDerived(["research-skim-card-one"], "team-approved", "bob", "checked");
		expect(await store.listDerived()).toHaveLength(1);
		expect(await store.proposeDerived([derived()], "alice")).toMatchObject([
			{ review: { status: "team-approved", reviewedBy: "bob" } },
		]);
		expect(await store.proposeDerived([derived({ finding: "changed" })], "alice")).toMatchObject([
			{ review: { status: "team-proposed", proposedBy: "alice" } },
		]);

		const proposedArtifact = await store.proposeArtifact("paper-one", artifact(), "alice");
		expect(proposedArtifact.manifest.pdfPath).toBe("paper.pdf");
		expect(proposedArtifact.manifest.acquisitions[0]).toMatchObject({
			localPath: undefined,
			licenseFiles: ["LICENSE"],
			metadataFile: { name: "metadata.json" },
		});
		expect(proposedArtifact.manifest.candidates[0].sources[0].context).toHaveLength(2_000);
		await store.reviewArtifact(["paper-one"], "team-approved", "bob");
		expect((await store.proposeArtifact("paper-one", artifact(), "alice")).review.status).toBe("team-approved");
		const changedArtifact = artifact();
		changedArtifact.candidates[0].confidence = "medium";
		expect((await store.proposeArtifact("paper-one", changedArtifact, "alice")).review.status).toBe("team-proposed");

		const body = Buffer.from("team-pdf");
		const sha256 = createHash("sha256").update(body).digest("hex");
		await expect(store.putBlob(body, "0".repeat(64), "alice")).rejects.toThrow("does not match");
		await store.putBlob(body, sha256, "alice", {
			paperId: "paper-one",
			sourceUrl: "https://example.org/paper.pdf",
			finalUrl: "https://cdn.example.org/paper.pdf",
			retrievedAt: "2026-08-01T00:02:00.000Z",
			contentType: "application/pdf",
		});
		expect(await store.readBlob(sha256)).toMatchObject({ body, contentType: "application/pdf" });
		expect(await store.stats()).toMatchObject({
			derivedCount: 1,
			artifactCount: 1,
			blobCount: 1,
			blobBytes: body.length,
		});

			const registry = new TeamTokenRegistry(root, [
				{ name: "admin", tokenSha256: hashTeamTokenValue("seed-token"), roles: ["admin"] },
			]);
			const { backupPath } = await store.backupTo(join(root, "backups"), await registry.backupSnapshot(), "admin");
			expect(
				JSON.parse(
					await readFile(
						join(backupPath, "namespace", "knowledge", "derived", "research-skim-card-one.json"),
						"utf8",
					),
				),
			).toBeTruthy();
			expect(await readFile(join(backupPath, "namespace", "events", "audit.jsonl"), "utf8")).toContain("blob.put");
			expect(
				await readFile(join(backupPath, "namespace", "blobs", "sha256", sha256.slice(0, 2), sha256)),
			).toEqual(body);
			expect(await readFile(join(backupPath, "_security", "identities.json"), "utf8")).not.toContain("seed-token");
			expect(await store.restoreDrill(backupPath, join(root, "drills"), "admin")).toMatchObject({
				validated: true,
				stats: { derivedCount: 1, artifactCount: 1, blobCount: 1 },
			});
	});

	it("stores only token hashes and supports online create, rotate, and revoke", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-tokens-"));
		temporaryPaths.push(root);
		const registry = new TeamTokenRegistry(root, [
			{ name: "admin", tokenSha256: hashTeamTokenValue("seed-token"), roles: ["admin"] },
		]);
		expect(await registry.authenticate("seed-token")).toMatchObject({ name: "admin", roles: ["admin"] });
		const created = await registry.rotate("reader-one", "admin", ["reader"]);
		expect(created.token).toBeTruthy();
		expect(await registry.authenticate(created.token)).toMatchObject({ name: "reader-one", roles: ["reader"] });
		const rotated = await registry.rotate("reader-one", "admin", ["reader", "contributor"]);
		expect(await registry.authenticate(created.token)).toBeUndefined();
		expect(await registry.authenticate(rotated.token)).toMatchObject({ roles: ["reader", "contributor"] });
		await registry.revoke("reader-one", "admin");
		expect(await registry.authenticate(rotated.token)).toBeUndefined();
		expect(await registry.list()).toMatchObject([
			{ name: "admin" },
			{ name: "reader-one", revokedAt: expect.any(String) },
		]);

		const registryText = await readFile(join(root, "_security", "identities.json"), "utf8");
		const auditText = await readFile(join(root, "_security", "token-audit.jsonl"), "utf8");
		expect(registryText).not.toContain("seed-token");
		expect(registryText).not.toContain(created.token);
		expect(registryText).not.toContain(rotated.token);
		expect(auditText).not.toContain(created.token);
		expect(auditText).not.toContain(rotated.token);
	});
});
