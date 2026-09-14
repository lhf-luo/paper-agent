import { createHash } from "node:crypto";
import { fetchWithReviewPreview as fetch } from "./team-http-fixture.ts";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import type { ArtifactManifest, DerivedRecord, PaperRecord } from "../src/literature/domain/literature-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

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
				{
					name: "alice",
					tokenSha256: hashTeamToken("alice-token"),
					roles: ["reader", "contributor"],
					namespaces: ["security"],
				},
				{
					name: "bob",
					tokenSha256: hashTeamToken("bob-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
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
			// Readers only see approved records, so approve before asserting on search results.
			expect(
				(
					await call("/reviews", {
						method: "POST",
						body: JSON.stringify({ paperIds: ["paper-one", "paper-two"], decision: "team-approved" }),
					})
				).status,
			).toBe(200);
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
				{
					name: "contributor",
					tokenSha256: hashTeamToken("contributor-token"),
					roles: ["reader", "contributor"],
					namespaces: ["security"],
				},
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reviewer"],
					namespaces: ["security"],
				},
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
			expect(
				(
					await call("/proposals", "contributor-token", {
						method: "POST",
						body: JSON.stringify({ records: [paper()] }),
					})
				).status,
			).toBe(200);
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
			expect(
				(
					await call("/reviews", "reviewer-token", {
						method: "POST",
						body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
					})
				).status,
			).toBe(200);
			const downloaded = await call(`/blobs/${sha256}`, "contributor-token");
			expect(downloaded.status).toBe(200);
			expect(downloaded.headers.get("content-type")).toBe("application/pdf");
			expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(blob);

			const adminIdentity = ((await (await adminCall("/v1/whoami")).json()) as { identity: { id: string } })
				.identity;
			const createdIdentity = await adminCall("/v1/admin/identities", "admin-token", {
				method: "POST",
				body: JSON.stringify({ name: "guest", roles: ["reader"], namespaces: ["security"] }),
			});
			expect(createdIdentity.status).toBe(201);
			const created = (await createdIdentity.json()) as { token: string; identity: { id: string } };
			const firstToken = created.token;
			expect(await (await adminCall("/v1/whoami", firstToken)).json()).toMatchObject({
				identity: { name: "guest", roles: ["reader"] },
			});
			const rotatedIdentity = await adminCall(`/v1/admin/identities/${created.identity.id}/rotate`, "admin-token", {
				method: "POST",
				body: JSON.stringify({ roles: ["reader", "contributor"], namespaces: ["security"] }),
			});
			const secondToken = ((await rotatedIdentity.json()) as { token: string }).token;
			expect((await adminCall("/v1/whoami", firstToken)).status).toBe(401);
			expect((await adminCall("/v1/whoami", secondToken)).status).toBe(200);
			expect(
				(
					await adminCall(`/v1/admin/identities/${adminIdentity.id}/revoke`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(400);
			expect(
				(
					await adminCall(`/v1/admin/identities/${created.identity.id}/revoke`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(200);
			expect((await adminCall("/v1/whoami", secondToken)).status).toBe(401);

			const backupResponse = await call("/backups", "admin-token", { method: "POST", body: "{}" });
			expect(backupResponse.status).toBe(200);
			const backupPath = ((await backupResponse.json()) as { backupPath: string }).backupPath;
			const derivedBackup = JSON.parse(
				await readFile(join(backupPath, "namespace", "knowledge", "derived", `${derived.key}.json`), "utf8"),
			);
			expect(derivedBackup.published ?? derivedBackup).toMatchObject({
				review: { status: "team-approved" },
			});
			const artifactBackup = JSON.parse(
				await readFile(join(backupPath, "namespace", "knowledge", "artifacts", "paper-team-server.json"), "utf8"),
			);
			expect(artifactBackup.published ?? artifactBackup).toMatchObject({
				review: { status: "team-approved" },
			});
			expect(await readFile(join(backupPath, "namespace", "blobs", "sha256", sha256.slice(0, 2), sha256))).toEqual(
				blob,
			);
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

	it("hides pending and rejected records from readers while keeping reviewers omniscient", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-visibility-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "contributor",
					tokenSha256: hashTeamToken("contributor-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
				{
					name: "reader",
					tokenSha256: hashTeamToken("reader-token"),
					roles: ["reader"],
					namespaces: ["security"],
				},
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const hits = async (path: string, token: string) =>
				((await (await call(path, token)).json()) as { hits: unknown[] }).hits;

			const proposed = await call("/proposals", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ records: [paper()] }),
			});
			expect(proposed.status).toBe(200);

			// Readers cannot discover pending records, and cannot ask for a non-approved status.
			expect(await hits("/search?q=binary", "reader-token")).toHaveLength(0);
			expect((await call("/papers/paper-team-server", "reader-token")).status).toBe(404);
			expect((await call("/search?q=binary&status=team-proposed", "reader-token")).status).toBe(403);

			// Reviewers keep full visibility, including explicitly requesting pending records.
			expect(await hits("/search?q=binary&status=team-proposed", "reviewer-token")).toHaveLength(1);
			expect((await call("/papers/paper-team-server", "reviewer-token")).status).toBe(200);

			await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});
			expect(await hits("/search?q=binary", "reader-token")).toHaveLength(1);
			expect((await call("/papers/paper-team-server", "reader-token")).status).toBe(200);

			await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-rejected" }),
			});
			expect(await hits("/search?q=binary", "reader-token")).toHaveLength(0);
			expect((await call("/papers/paper-team-server", "reader-token")).status).toBe(404);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("keeps approved papers visible while content changes wait as a reviewable revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-reset-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "alice",
					tokenSha256: hashTeamToken("alice-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
				{ name: "bob", tokenSha256: hashTeamToken("bob-token"), roles: ["reviewer"], namespaces: ["security"] },
				{
					name: "carol",
					tokenSha256: hashTeamToken("carol-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const propose = (token: string, record: PaperRecord) =>
				call("/proposals", token, { method: "POST", body: JSON.stringify({ records: [record] }) });
			const approve = () =>
				call("/reviews", "bob-token", {
					method: "POST",
					body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
				});
			const store = new LiteratureStore(join(root, "corpus", "security"), "team", "security");
			const status = async () => (await store.getPaper("paper-team-server"))?.curation?.teamReview?.status;

			expect((await propose("alice-token", paper())).status).toBe(200);
			await approve();
			expect(await status()).toBe("team-approved");

			// Re-proposing byte-identical content keeps the prior decision.
			expect((await propose("alice-token", paper())).status).toBe(200);
			expect(await status()).toBe("team-approved");

			// A second member re-proposing the same paper from a different search brings new provenance, a
			// refreshed citation count, a fuller author list, and a landing link. That is bookkeeping, not a content
			// change: the approval survives and readers keep seeing the record.
			const duplicate = paper();
			duplicate.provenance = [
				{ provider: "openalex", query: "secure binary analysis 2026", retrievedAt: "2026-03-01T00:00:00.000Z" },
			];
			duplicate.citationCount = 42;
			duplicate.authors = ["Ada Example", "Grace Example"];
			duplicate.links = [{ url: "https://example.org/secure-binary-analysis", kind: "landing" }];
			expect((await propose("carol-token", duplicate)).status).toBe(200);
			expect(await status()).toBe("team-approved");
			expect((await store.getPaper("paper-team-server"))?.citationCount).toBe(42);

			// A new downloadable link is something readers would act on. The approved record stays exactly as
			// reviewed (and visible), while the merged content waits as a pending revision in the reviewer queue.
			const withPdf = paper();
			withPdf.links = [{ url: "https://example.org/secure-binary-analysis.pdf", kind: "pdf" }];
			expect((await propose("alice-token", withPdf)).status).toBe(200);
			expect(await status()).toBe("team-approved");
			const pdfUrl = "https://example.org/secure-binary-analysis.pdf";
			expect((await store.getPaper("paper-team-server"))?.links.map((link) => link.url)).not.toContain(pdfUrl);
			const pendingRevision = async () =>
				((await (await call("/proposals", "bob-token")).json()) as { records: PaperRecord[] }).records.find(
					(record) => record.id === "paper-team-server",
				);
			expect(await pendingRevision()).toMatchObject({
				links: [{ url: "https://example.org/secure-binary-analysis" }, { url: pdfUrl }],
				curation: { teamReview: { status: "team-proposed", proposedBy: "alice", revision: true } },
			});

			// Approving the revision replaces the approved record with the revised content.
			await approve();
			expect(await status()).toBe("team-approved");
			expect((await store.getPaper("paper-team-server"))?.links.map((link) => link.url)).toContain(pdfUrl);
			expect(await pendingRevision()).toBeUndefined();

			// Rejecting a revision discards it and leaves the approved record untouched: that is the rollback for
			// unwanted "longer wins" merges.
			const revised = paper();
			revised.abstract = "A materially revised abstract.";
			expect((await propose("alice-token", revised)).status).toBe(200);
			expect(await pendingRevision()).toMatchObject({ abstract: "A materially revised abstract." });
			await call("/reviews", "bob-token", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-team-server"],
					decision: "team-rejected",
					reason: "not this paper's abstract",
				}),
			});
			expect(await status()).toBe("team-approved");
			expect((await store.getPaper("paper-team-server"))?.abstract).toBeUndefined();
			expect(await pendingRevision()).toBeUndefined();

			const events = await (await call("/events?limit=50", "bob-token")).json();
			const audit = JSON.stringify(events);
			expect(audit.match(/paper\.propose/g) ?? []).toHaveLength(5);
			expect(audit.match(/paper\.review/g) ?? []).toHaveLength(3);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("rejects a proposal that reuses an approved paper id for a different paper", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-conflict-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "alice",
					tokenSha256: hashTeamToken("alice-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
				{
					name: "mallory",
					tokenSha256: hashTeamToken("mallory-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
				{
					name: "bob",
					tokenSha256: hashTeamToken("bob-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const propose = (token: string, records: PaperRecord[]) =>
				call("/proposals", token, { method: "POST", body: JSON.stringify({ records }) });
			const current = async () =>
				(await (await call("/papers/paper-team-server", "bob-token")).json()) as PaperRecord;

			const original = paper();
			original.identifiers = { doi: "10.1000/secure-binary" };
			expect((await propose("alice-token", [original])).status).toBe(200);
			await call("/reviews", "bob-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});

			// Copying an approved id onto a different paper (other DOI, foreign title, attacker-controlled PDF link)
			// must be refused outright instead of merged and knocked back into review.
			const hijack = paper();
			hijack.title = "An Entirely Different Paper With A Much Longer Title";
			hijack.identifiers = { doi: "10.1000/other" };
			hijack.links = [{ url: "https://evil.example/other.pdf", kind: "pdf" }];
			const rejected = await propose("mallory-token", [hijack]);
			expect(rejected.status).toBe(409);
			expect(await current()).toMatchObject({
				title: "Secure Binary Analysis",
				identifiers: { doi: "10.1000/secure-binary" },
				links: [],
				curation: { teamReview: { status: "team-approved" } },
			});

			// An identifier-less impostor with a different title is refused as well.
			const impostor = paper();
			impostor.title = "Something Else Entirely";
			expect((await propose("mallory-token", [impostor])).status).toBe(409);

			// Conflicts are detected before any record in the batch is written.
			const sibling = paper();
			sibling.id = "paper-team-sibling";
			sibling.title = "Sibling Paper";
			expect((await propose("mallory-token", [sibling, hijack])).status).toBe(409);
			expect((await call("/papers/paper-team-sibling", "bob-token")).status).toBe(404);

			// The same paper under the same DOI may still be re-proposed, even with a corrected title; the change
			// waits as a revision while readers keep the approved title.
			const corrected = paper();
			corrected.identifiers = { doi: "10.1000/secure-binary" };
			corrected.title = "Secure Binary Analysis: Extended Version";
			expect((await propose("alice-token", [corrected])).status).toBe(200);
			expect((await current()).title).toBe("Secure Binary Analysis");
			const queue = (await (await call("/proposals", "bob-token")).json()) as { records: PaperRecord[] };
			expect(queue.records).toMatchObject([
				{
					id: "paper-team-server",
					title: "Secure Binary Analysis: Extended Version",
					curation: { teamReview: { revision: true } },
				},
			]);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("lists paper PDF versions only for records the caller is allowed to see", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-versions-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "contributor",
					tokenSha256: hashTeamToken("contributor-token"),
					roles: ["reader", "contributor"],
					namespaces: ["security"],
				},
				{
					name: "reader",
					tokenSha256: hashTeamToken("reader-token"),
					roles: ["reader"],
					namespaces: ["security"],
				},
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});

			await call("/proposals", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ records: [paper()] }),
			});
			const blob = Buffer.from("%PDF-1.4\nversion listing\n%%EOF\n");
			const sha256 = createHash("sha256").update(blob).digest("hex");
			const uploaded = await fetch(`${base}/blobs/${sha256}`, {
				method: "PUT",
				headers: {
					authorization: "Bearer contributor-token",
					"content-type": "application/pdf",
					"x-paper-id": "paper-team-server",
					"x-source-url": "https://example.org/paper.pdf",
					"x-final-url": "https://cdn.example.org/paper.pdf",
					"x-retrieved-at": "2026-01-02T00:00:00.000Z",
				},
				body: blob,
			});
			expect(uploaded.status).toBe(200);

			// Pending records stay invisible, including their version lists.
			expect((await call("/papers/paper-team-server/versions", "reader-token")).status).toBe(404);
			const reviewerVersions = await call("/papers/paper-team-server/versions?pending=true", "reviewer-token");
			expect(reviewerVersions.status).toBe(200);
			expect(
				((await reviewerVersions.json()) as { versions: Array<{ sha256: string }> }).versions.map((v) => v.sha256),
			).toContain(sha256);

			await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});
			const readerVersions = await call("/papers/paper-team-server/versions", "reader-token");
			expect(readerVersions.status).toBe(200);
			expect(
				((await readerVersions.json()) as { versions: Array<{ sha256: string }> }).versions.map((v) => v.sha256),
			).toContain(sha256);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("rate-limits repeated authentication failures per IP without locking out valid tokens or /health", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-ratelimit-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const origin = `http://127.0.0.1:${address.port}`;
			for (let attempt = 0; attempt < 20; attempt++) {
				const response = await fetch(`${origin}/v1/namespaces/security/search`, {
					headers: { authorization: "Bearer not-a-real-token" },
				});
				expect(response.status, `attempt ${attempt + 1}`).toBe(401);
			}
			const blocked = await fetch(`${origin}/v1/namespaces/security/search`, {
				headers: { authorization: "Bearer not-a-real-token" },
			});
			expect(blocked.status).toBe(429);
			expect(await blocked.json()).toMatchObject({ error: "too many authentication failures" });
			// Only failed authentication is throttled: a valid token from the same address keeps working, so one
			// misconfigured client behind a shared NAT cannot lock out the whole lab.
			expect(
				(
					await fetch(`${origin}/v1/namespaces/security/search`, {
						headers: { authorization: "Bearer admin-token" },
					})
				).status,
			).toBe(200);
			// `/health` is always available so orchestrators can still probe the service.
			expect((await fetch(`${origin}/health`)).status).toBe(200);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("scopes paper search to shared categories and keeps cursor pagination correct", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-categories-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reader", "contributor", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const search = async (query = "") =>
				(await (await call(`/search${query}`, "reviewer-token")).json()) as {
					hits: Array<{ record: PaperRecord }>;
					nextCursor?: string;
				};
			const titlesOf = (result: { hits: Array<{ record: PaperRecord }> }) =>
				result.hits.map((hit) => hit.record.title).sort();

			const variant = (id: string, title: string): PaperRecord => ({ ...paper(), id, title });
			const proposed = await call("/proposals", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({
					records: [
						variant("paper-alpha", "Alpha Unsafe Free"),
						variant("paper-beta", "Beta Use After Free"),
						variant("paper-gamma", "Gamma Fuzzing"),
					],
				}),
			});
			expect(proposed.status).toBe(200);
			const reviewed = await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-alpha", "paper-beta", "paper-gamma"],
					decision: "team-approved",
				}),
			});
			expect(reviewed.status).toBe(200);

			// Category entries must use the stored ids, which merging is free to recompute.
			const approved = await search("?limit=50");
			const idOf = (title: string) => {
				const found = approved.hits.find((hit) => hit.record.title === title)?.record.id;
				if (!found) throw new Error(`the approved paper is missing: ${title}`);
				return found;
			};
			const createTopic = (id: string, title: string, paperIds: string[]) =>
				call("/topics", "reviewer-token", {
					method: "POST",
					body: JSON.stringify({
						id,
						title,
						description: "",
						entries: paperIds.map((paperId) => ({ resource: "papers", id: paperId })),
					}),
				});
			const uaf = await createTopic("uaf", "UAF 漏洞检测", [idOf("Alpha Unsafe Free"), idOf("Beta Use After Free")]);
			expect(uaf.status).toBe(200);
			const fuzzing = await createTopic("fuzzing", "模糊测试", [idOf("Gamma Fuzzing")]);
			expect(fuzzing.status).toBe(200);

			// One category, the union of two categories, and a category nothing belongs to.
			expect(titlesOf(await search("?topic=uaf"))).toEqual(["Alpha Unsafe Free", "Beta Use After Free"]);
			expect(titlesOf(await search("?topic=fuzzing"))).toEqual(["Gamma Fuzzing"]);
			expect(titlesOf(await search("?topic=uaf&topic=fuzzing"))).toEqual([
				"Alpha Unsafe Free",
				"Beta Use After Free",
				"Gamma Fuzzing",
			]);
			// An unknown category yields an empty page, not a 404 that would confirm whether it exists.
			const unknown = await call("/search?topic=missing", "reviewer-token");
			expect(unknown.status).toBe(200);
			expect(((await unknown.json()) as { hits: unknown[] }).hits).toHaveLength(0);

			// The filter must be applied before the offset/limit slice, otherwise page two would be empty.
			const first = await search("?topic=uaf&limit=1");
			expect(first.hits).toHaveLength(1);
			expect(first.nextCursor).toBe("1");
			const second = await search(`?topic=uaf&limit=1&cursor=${first.nextCursor}`);
			expect(second.hits).toHaveLength(1);
			expect(second.nextCursor).toBeUndefined();
			expect(titlesOf({ hits: [...first.hits, ...second.hits] })).toEqual([
				"Alpha Unsafe Free",
				"Beta Use After Free",
			]);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("files a proposed paper into a requested category only once a reviewer approves it", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-topic-request-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "contributor",
					tokenSha256: hashTeamToken("contributor-token"),
					roles: ["reader", "contributor"],
					namespaces: ["security"],
				},
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});
			const hits = async (path: string, token: string) =>
				((await (await call(path, token)).json()) as { hits: unknown[] }).hits;

			// A curator defines the category first: a proposal may only ask for categories that exist.
			const created = await call("/topics", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ id: "uaf", title: "UAF 漏洞检测", description: "", entries: [] }),
			});
			expect(created.status).toBe(200);

			const proposed = await call("/proposals", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ records: [paper()], topicIds: ["uaf", "missing"] }),
			});
			expect(proposed.status).toBe(200);
			expect(await proposed.json()).toMatchObject({ requestedTopicIds: ["uaf", "missing"] });

			// The request is recorded, not applied: nothing is filed while the paper is still pending.
			expect(await hits("/search?topic=uaf", "reviewer-token")).toHaveLength(0);
			expect(await hits("/search", "reviewer-token")).toHaveLength(0);

			const reviewed = await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["paper-team-server"], decision: "team-approved" }),
			});
			expect(reviewed.status).toBe(200);
			// The existing category receives the paper; the unknown one is reported, never invented.
			expect(await reviewed.json()).toMatchObject({ categories: { applied: ["uaf"], skipped: ["missing"] } });
			expect(await hits("/search?topic=uaf", "reviewer-token")).toHaveLength(1);
			expect(await hits("/search", "reviewer-token")).toHaveLength(1);

			// A published record has no review step left, so a category request for it is refused outright
			// rather than becoming an unreviewed category write.
			const repeated = await call("/proposals", "contributor-token", {
				method: "POST",
				body: JSON.stringify({ records: [paper()], topicIds: ["uaf"] }),
			});
			expect(repeated.status).toBe(400);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});
});
