import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore } from "../src/literature-store.ts";
import type { ArtifactManifest, DerivedRecord, PaperRecord } from "../src/literature-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../src/team-corpus-server.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(): PaperRecord {
	return {
		id: "paper-team-server",
		title: "Secure Binary Analysis",
		authors: ["Ada Example"],
		year: 2026,
		identifiers: {},
		links: [],
		provenance: [{ provider: "local-pdf", query: "import", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		curation: {
			tags: ["binary-analysis"],
			userNotes: [{ id: "private", text: "private note", author: "alice", createdAt: "2026-01-01T00:00:00Z" }],
			screening: {
				status: "include",
				updatedBy: "alice",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		},
	};
}

describe("team corpus server", () => {
	it("keeps read-only requests from creating an empty team namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-readonly-"));
		temporaryPaths.push(root);
		const corpusRoot = join(root, "corpus");
		const namespaceRoot = join(corpusRoot, "new-namespace");
		const server = createTeamCorpusServer({
			root: corpusRoot,
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/new-namespace`;
			for (const resource of ["search", "derived", "artifacts", "events", "stats", "audit"]) {
				const response = await fetch(`${base}/${resource}`, {
					headers: { authorization: "Bearer admin-token" },
				});
				expect(response.status).toBe(200);
			}
			await expect(access(namespaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("enforces roles, strips personal curation, reviews proposals, and creates a consistent backup", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-server-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			backupRoot: join(root, "backups"),
			identities: [
				{ name: "alice", tokenSha256: hashTeamToken("alice-token"), roles: ["reader", "contributor"] },
				{ name: "bob", tokenSha256: hashTeamToken("bob-token"), roles: ["reader", "reviewer"] },
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const origin = `http://127.0.0.1:${address.port}`;
			const base = `${origin}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const traversal = await fetch(`${origin}/v1/namespaces/%252e%252e/search`, {
				headers: { authorization: "Bearer alice-token" },
			});
			expect(traversal.status).toBe(400);

			const forbidden = await call("/reviews", "alice-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});
			expect(forbidden.status).toBe(403);
			for (const malformedReview of ["null", '"not-an-object"', "[]"]) {
				const malformed = await call("/reviews", "bob-token", { method: "POST", body: malformedReview });
				expect(malformed.status).toBe(400);
				expect(await malformed.json()).toMatchObject({ error: "review request must be a JSON object" });
			}
			const oversizedReview = await call("/reviews", "bob-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: Array(501).fill("paper-team-server"), decision: "team-approved" }),
			});
			expect(oversizedReview.status).toBe(400);

			const proposed = await call("/proposals", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [paper()] }),
			});
			expect(proposed.status).toBe(200);
			const invalidProvenance = paper();
			invalidProvenance.id = "paper-invalid-provenance";
			invalidProvenance.provenance[0].rawUrl = "file:///private/source";
			const rejectedProposal = await call("/proposals", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [invalidProvenance] }),
			});
			expect(rejectedProposal.status).toBe(400);
			const malformedOptionalMetadata = { ...paper(), id: "paper-malformed", publicationType: {} };
			const rejectedMetadata = await call("/proposals", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [malformedOptionalMetadata] }),
			});
			expect(rejectedMetadata.status).toBe(400);
			const store = new LiteratureStore(join(root, "corpus", "security"), "team", "security");
			const teamRecord = await store.getPaper("paper-team-server");
			expect(teamRecord?.curation?.userNotes).toEqual([]);
			expect(teamRecord?.curation?.screening).toBeUndefined();
			expect(teamRecord?.curation?.teamReview).toMatchObject({ status: "team-proposed", proposedBy: "alice" });

			const reviewed = await call("/reviews", "bob-token", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-team-server"],
					decision: "team-approved",
					reason: "traceable",
				}),
			});
			expect(reviewed.status).toBe(200);
			expect((await store.getPaper("paper-team-server"))?.curation?.teamReview).toMatchObject({
				status: "team-approved",
				reviewedBy: "bob",
			});

			const search = await call("/search?q=binary", "alice-token");
			expect(search.status).toBe(200);
			expect(((await search.json()) as { hits: unknown[] }).hits).toHaveLength(1);

			const backup = await call("/backups", "admin-token", { method: "POST", body: "{}" });
			expect(backup.status).toBe(200);
			const backupPath = ((await backup.json()) as { backupPath: string }).backupPath;
				expect(JSON.parse(await readFile(join(backupPath, "namespace", "manifest.json"), "utf8"))).toMatchObject({
					scope: "team",
					namespace: "security",
					recordCount: 1,
				});
				expect(JSON.parse(await readFile(join(backupPath, "backup-manifest.json"), "utf8"))).toMatchObject({
					schemaVersion: 1,
					namespace: "security",
					includes: { namespace: true, tokenRegistry: true, tokenAudit: true },
				});
				expect(JSON.parse(await readFile(join(backupPath, "_security", "identities.json"), "utf8"))).toMatchObject({
					identities: expect.arrayContaining([expect.objectContaining({ name: "admin" })]),
				});
				const restoredPath = join(root, "restore-drill", "security");
				await cp(join(backupPath, "namespace"), restoredPath, { recursive: true });
			const restored = new LiteratureStore(restoredPath, "team", "security");
			expect(await restored.audit()).toMatchObject({
				manifest: { scope: "team", namespace: "security", recordCount: 1 },
			});
			expect((await restored.getPaper("paper-team-server"))?.curation?.teamReview?.status).toBe("team-approved");
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("filters and paginates shared records without leaking unrestricted scans", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-filter-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
		});
		const records = [
			{
				...paper(),
				id: "paper-one",
				title: "Binary Analysis One",
				venue: "SecureConf",
				publicationType: "Conference",
				links: [{ url: "https://example.org/one.pdf", kind: "pdf" as const, openAccess: true }],
			},
			{
				...paper(),
				id: "paper-two",
				title: "Binary Analysis Two",
				venue: "SecureConf",
				publicationType: "Conference",
				links: [{ url: "https://example.org/two", kind: "landing" as const }],
			},
		];
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
				});
			expect((await call("/proposals", { method: "POST", body: JSON.stringify({ records }) })).status).toBe(200);
			const first = (await (await call("/search?q=binary&venue=secure&type=conference&limit=1")).json()) as {
				hits: unknown[];
				nextCursor?: string;
			};
			expect(first.hits).toHaveLength(1);
			expect(first.nextCursor).toBe("1");
			const second = (await (
				await call(`/search?q=binary&venue=secure&type=conference&limit=1&cursor=${first.nextCursor}`)
			).json()) as { hits: unknown[] };
			expect(second.hits).toHaveLength(1);
			const open = (await (await call("/search?q=binary&openAccess=true")).json()) as { hits: unknown[] };
			expect(open.hits).toHaveLength(1);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("shares reviewed derived knowledge and artifact manifests, verifies blobs, rotates tokens, and backs up the full namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-knowledge-http-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			backupRoot: join(root, "backups"),
				identities: [
					{ name: "contributor", tokenSha256: hashTeamToken("contributor-token"), roles: ["reader", "contributor"] },
					{ name: "reviewer", tokenSha256: hashTeamToken("reviewer-token"), roles: ["reviewer"] },
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const origin = `http://127.0.0.1:${address.port}`;
			const base = `${origin}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
				});
			const adminCall = (path: string, token = "admin-token", init: RequestInit = {}) =>
				fetch(origin + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
				});

			const derived: DerivedRecord = {
				key: "team-skim-one",
				paperId: "paper-team-server",
				operation: "skim-card",
				inputHashes: ["a".repeat(64)],
				pipelineVersion: "research-workspace-v1",
				normalizedConfig: { language: "zh-CN" },
				createdAt: "2026-01-02T00:00:00.000Z",
				result: { finding: "traceable" },
			};
			const proposedDerived = await call("/derived", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ records: [derived] }),
			});
			expect(proposedDerived.status).toBe(200);
			expect(await proposedDerived.json()).toMatchObject({ entries: [{ review: { status: "team-proposed" } }] });
			expect(await (await call("/derived", "contributor-token")).json()).toMatchObject({ entries: [] });
			expect(await (await call("/derived?pending=true", "reviewer-token")).json()).toMatchObject({
				entries: [{ record: { key: "team-skim-one" }, review: { status: "team-proposed" } }],
			});
			const reviewedDerived = await call("/derived/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ keys: [derived.key], decision: "team-approved", reason: "source checked" }),
			});
			expect(reviewedDerived.status).toBe(200);
			expect(await reviewedDerived.json()).toMatchObject({
				entries: [{ review: { status: "team-approved", reviewedBy: "reviewer" } }],
			});

			const manifest: ArtifactManifest = {
				schemaVersion: 1,
				pdfPath: "D:\\private\\paper.pdf",
				pdfSha256: "b".repeat(64),
				discoveredAt: "2026-01-02T00:00:00.000Z",
				candidates: [],
				acquisitions: [],
			};
			const proposedArtifact = await call("/artifacts", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ paperId: "paper-team-server", manifest }),
			});
			expect(proposedArtifact.status).toBe(200);
			expect(await proposedArtifact.json()).toMatchObject({
				entry: { manifest: { pdfPath: "paper.pdf" }, review: { status: "team-proposed" } },
			});
			const reviewedArtifact = await call("/artifacts/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});
			expect(reviewedArtifact.status).toBe(200);

			const blob = Buffer.from("%PDF-1.4\nteam fixture\n%%EOF\n");
			const sha256 = createHash("sha256").update(blob).digest("hex");
			const mismatch = await call(`/blobs/${"0".repeat(64)}`, "contributor-token", {
				method: "PUT",
				body: blob,
				headers: { "content-type": "application/pdf" },
			});
			expect(mismatch.status).toBe(400);
			const uploaded = await call(`/blobs/${sha256}`, "contributor-token", {
				method: "PUT",
				body: blob,
				headers: {
					"content-type": "application/pdf",
					"x-paper-id": "paper-team-server",
					"x-source-url": "https://example.org/paper.pdf",
					"x-final-url": "https://cdn.example.org/paper.pdf",
					"x-retrieved-at": "2026-01-02T00:00:00.000Z",
				},
			});
			expect(uploaded.status).toBe(200);
			expect(await uploaded.json()).toMatchObject({ sha256, existed: false });
			const downloaded = await call(`/blobs/${sha256}`, "contributor-token");
			expect(downloaded.status).toBe(200);
			expect(downloaded.headers.get("content-type")).toBe("application/pdf");
			expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(blob);

			const createdIdentity = await adminCall("/v1/admin/identities/guest/rotate", "admin-token", {
				method: "POST",
				body: JSON.stringify({ roles: ["reader"] }),
			});
			expect(createdIdentity.status).toBe(200);
			const firstToken = ((await createdIdentity.json()) as { token: string }).token;
			expect(await (await adminCall("/v1/whoami", firstToken)).json()).toMatchObject({
				identity: { name: "guest", roles: ["reader"] },
			});
			const rotatedIdentity = await adminCall("/v1/admin/identities/guest/rotate", "admin-token", {
				method: "POST",
				body: JSON.stringify({ roles: ["reader", "contributor"] }),
			});
			const secondToken = ((await rotatedIdentity.json()) as { token: string }).token;
			expect((await adminCall("/v1/whoami", firstToken)).status).toBe(401);
			expect((await adminCall("/v1/whoami", secondToken)).status).toBe(200);
			expect(
				(await adminCall("/v1/admin/identities/admin/revoke", "admin-token", { method: "POST", body: "{}" }))
					.status,
			).toBe(400);
			expect(
				(await adminCall("/v1/admin/identities/guest/revoke", "admin-token", { method: "POST", body: "{}" }))
					.status,
			).toBe(200);
			expect((await adminCall("/v1/whoami", secondToken)).status).toBe(401);

			const backupResponse = await call("/backups", "admin-token", { method: "POST", body: "{}" });
			expect(backupResponse.status).toBe(200);
				const backupPath = ((await backupResponse.json()) as { backupPath: string }).backupPath;
				expect(
					JSON.parse(
						await readFile(join(backupPath, "namespace", "knowledge", "derived", `${derived.key}.json`), "utf8"),
					),
				).toMatchObject({
				review: { status: "team-approved" },
			});
				expect(
					JSON.parse(
						await readFile(
							join(backupPath, "namespace", "knowledge", "artifacts", "paper-team-server.json"),
							"utf8",
						),
					),
			).toMatchObject({
				review: { status: "team-approved" },
			});
				expect(
					await readFile(join(backupPath, "namespace", "blobs", "sha256", sha256.slice(0, 2), sha256)),
				).toEqual(blob);
				const events = await readFile(join(backupPath, "namespace", "events", "audit.jsonl"), "utf8");
			for (const action of [
				"derived.propose",
				"derived.review",
				"artifact.propose",
				"artifact.review",
				"blob.put",
				"backup.create",
			]) {
					expect(events).toContain(action);
				}
				const restoreDrill = await call("/backups/drill", "admin-token", {
					method: "POST",
					body: JSON.stringify({ backupPath }),
				});
				expect(restoreDrill.status).toBe(200);
				expect(await restoreDrill.json()).toMatchObject({
					validated: true,
					namespace: "security",
					stats: { derivedCount: 1, artifactCount: 1, blobCount: 1 },
				});
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});
});
