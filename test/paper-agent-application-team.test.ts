import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";
import { saveTeamAccess } from "../src/team/infrastructure/team-access-file.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const temporaryPaths: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PaperAgentApplication team overview", () => {
	it("keeps limited contributor and reviewer identities connected without probing reader-only endpoints", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-overview-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [
				{
					name: "contributor",
					tokenSha256: hashTeamToken("contributor-token"),
					roles: ["contributor"],
					namespaces: ["security"],
				},
				{
					name: "reviewer",
					tokenSha256: hashTeamToken("reviewer-token"),
					roles: ["reviewer"],
					namespaces: ["security"],
				},
			],
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		const serverUrl = `http://127.0.0.1:${address.port}`;
		await saveTeamAccess(root, {
			serverUrl,
			namespace: "security",
			token: "contributor-token",
			identity: "contributor",
		});
		const application = new PaperAgentApplication({ projectRoot: root });

		await expect(application.teamOverview()).resolves.toMatchObject({
			connected: true,
			identity: { name: "contributor", roles: ["contributor"] },
			capabilities: { canRead: false, canContribute: true, canReview: false, canAdmin: false },
			papers: [],
			pendingPapers: [],
		});

		await saveTeamAccess(root, {
			serverUrl,
			namespace: "security",
			token: "reviewer-token",
			identity: "reviewer",
		});
		await expect(application.teamOverview()).resolves.toMatchObject({
			connected: true,
			identity: { name: "reviewer", roles: ["reviewer"] },
			capabilities: { canRead: false, canContribute: false, canReview: true, canAdmin: false },
			papers: [],
			pendingPapers: [],
			derived: [],
			artifacts: [],
			events: [],
		});
		await application.close();
	});

	it("searches the shared corpus with bounded query, year filters, and cursor pagination", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-search-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
				{
					name: "reader",
					tokenSha256: hashTeamToken("reader-token"),
					roles: ["reader"],
					namespaces: ["security"],
				},
			],
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		const serverUrl = `http://127.0.0.1:${address.port}`;
		await saveTeamAccess(root, {
			serverUrl,
			namespace: "security",
			token: "reader-token",
			identity: "reader",
		});
		const record = (id: string, year: number, title: string): PaperRecord => ({
			id,
			title,
			authors: ["Search Researcher"],
			year,
			venue: "SearchConf",
			publicationType: "Conference",
			identifiers: {},
			links: [{ url: `https://example.org/${id}.pdf`, kind: "pdf", openAccess: true }],
			provenance: [{ provider: "json-import", query: "team-search", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		});
		const records = [
			record("team-search-2024", 2024, "Stateful Search One"),
			record("team-search-2025", 2025, "Stateful Search Two"),
		];
		const proposal = await fetch(`${serverUrl}/v1/namespaces/security/proposals`, {
			method: "POST",
			headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
			body: JSON.stringify({ records }),
		});
		expect(proposal.status).toBe(200);
		// The reader identity only sees approved records, so approve both proposals first.
		const approval = await fetch(`${serverUrl}/v1/namespaces/security/reviews`, {
			method: "POST",
			headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
			body: JSON.stringify({
				paperIds: records.map((entry) => entry.id),
				decision: "team-approved",
			}),
		});
		expect(approval.status).toBe(200);
		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			const first = await application.searchTeamLibrary({
				query: "stateful",
				yearFrom: 2024,
				yearTo: 2025,
				limit: 1,
			});
			expect(first.namespace).toBe("security");
			expect(first.hits).toHaveLength(1);
			expect(first.hits[0].record.id).toBe("team-search-2024");
			expect(first.nextCursor).toBe("1");
			const second = await application.searchTeamLibrary({
				query: "stateful",
				yearFrom: 2024,
				yearTo: 2025,
				limit: 1,
				cursor: first.nextCursor,
			});
			expect(second.hits).toHaveLength(1);
			expect(second.hits[0].record.id).toBe("team-search-2025");
			const empty = await application.searchTeamLibrary({ query: "absent", yearFrom: 2024, yearTo: 2025 });
			expect(empty.hits).toEqual([]);
		} finally {
			await application.close();
		}
	});

	it("confirms artifact manifests, PDF blobs, backups, and restore drills before team writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-writes-"));
		temporaryPaths.push(root);
		const backupRoot = join(root, "backups");
		const server = createTeamCorpusServer({
			root: join(root, "team"),
			backupRoot,
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		await saveTeamAccess(root, {
			serverUrl: `http://127.0.0.1:${address.port}`,
			namespace: "security",
			token: "admin-token",
			identity: "admin",
		});
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfixture\n"));
		const executor: CommandExecutor = {
			exec: async (command) => ({
				stdout:
					command === "pdftotext"
						? "Code and data are available at https://github.com/example/stateful-fuzzing"
						: "",
				stderr: "",
				code: 0,
				killed: false,
			}),
		};
		const application = new PaperAgentApplication({ projectRoot: root, executor });
		try {
			const record: PaperRecord = {
				id: "paper-team-write",
				title: "Stateful fuzzing",
				authors: ["Researcher"],
				identifiers: {},
				links: [{ url: "https://example.org/paper", kind: "landing" }],
				provenance: [{ provider: "local-pdf", query: pdfPath, retrievedAt: new Date().toISOString() }],
				mergedFrom: [],
			};
			const store = application.personalStore();
			await store.upsertPaper(record);
			const pdf = Buffer.from("%PDF-1.4\nteam blob\n");
			const blob = await store.putBlob(pdf);
			await store.savePaperVersion({
				paperId: record.id,
				sourceUrl: "https://example.org/paper.pdf",
				finalUrl: "https://example.org/paper.pdf",
				retrievedAt: new Date().toISOString(),
				sha256: blob.sha256,
				bytes: pdf.length,
				blobPath: blob.path,
				contentType: "application/pdf",
			});

			const discovery = await application.enqueueArtifactDiscovery({ pdfPath });
			for (let attempt = 0; attempt < 100 && application.jobs.get(discovery.id)?.status !== "succeeded"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(application.jobs.get(discovery.id)?.status).toBe("succeeded");
			const artifactInput = { artifactJobId: discovery.id, paperId: record.id };
			const artifactPlan = await application.prepareTeamArtifactProposal(artifactInput);
			const artifactGrant = await application.confirmOperation(
				artifactPlan.operationId,
				artifactPlan.manifestFingerprint,
			);
			await expect(application.proposeTeamArtifact(artifactInput, artifactGrant)).resolves.toMatchObject({
				entry: { paperId: record.id, review: { status: "team-proposed" } },
			});

			const blobInput = { paperId: record.id, sha256: blob.sha256 };
			const blobPlan = await application.prepareTeamBlobUpload(blobInput);
			const blobGrant = await application.confirmOperation(blobPlan.operationId, blobPlan.manifestFingerprint);
			await expect(application.uploadTeamBlob(blobInput, blobGrant)).resolves.toMatchObject({ sha256: blob.sha256 });

			const backupPlan = await application.prepareTeamBackup();
			const backupGrant = await application.confirmOperation(backupPlan.operationId, backupPlan.manifestFingerprint);
			const backup = await application.backupTeam(backupGrant);
			expect(backup.backupPath).toContain("security");
			const drillInput = { backupPath: backup.backupPath };
			const drillPlan = await application.prepareTeamRestoreDrill(drillInput);
			const drillGrant = await application.confirmOperation(drillPlan.operationId, drillPlan.manifestFingerprint);
			await expect(application.drillTeamRestore(drillInput, drillGrant)).resolves.toMatchObject({
				validated: true,
				namespace: "security",
				stats: { recordCount: 0, artifactCount: 1, blobCount: 1 },
			});
		} finally {
			await application.close();
		}
	});

	it("pulls an approved team paper and its PDF back into the personal library", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-pull-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		const serverUrl = `http://127.0.0.1:${address.port}`;
		await saveTeamAccess(root, {
			serverUrl,
			namespace: "security",
			token: "admin-token",
			identity: "admin",
		});

		const teamRecord: PaperRecord = {
			id: "team-pull-paper",
			title: "Downstream Pull",
			abstract: "A team-shared abstract.",
			authors: ["Pull Author"],
			year: 2026,
			identifiers: {},
			links: [{ url: "https://example.org/pull.pdf", kind: "pdf", openAccess: true }],
			provenance: [
				{ provider: "json-import", query: "team-pull", retrievedAt: "2026-01-01T00:00:00.000Z" },
			],
			mergedFrom: [],
		};
		const teamHeaders = { authorization: "Bearer admin-token", "content-type": "application/json" };
		expect(
			(
				await fetch(`${serverUrl}/v1/namespaces/security/proposals`, {
					method: "POST",
					headers: teamHeaders,
					body: JSON.stringify({ records: [teamRecord] }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await fetch(`${serverUrl}/v1/namespaces/security/reviews`, {
					method: "POST",
					headers: teamHeaders,
					body: JSON.stringify({ paperIds: [teamRecord.id], decision: "team-approved" }),
				})
			).status,
		).toBe(200);

		const pdf = Buffer.from("%PDF-1.4\nteam downlink\n%%EOF\n");
		const sha256 = createHash("sha256").update(pdf).digest("hex");
		expect(
			(
				await fetch(`${serverUrl}/v1/namespaces/security/blobs/${sha256}`, {
					method: "PUT",
					headers: {
						authorization: "Bearer admin-token",
						"content-type": "application/pdf",
						"x-paper-id": teamRecord.id,
						"x-source-url": "https://example.org/pull.pdf",
						"x-final-url": "https://cdn.example.org/pull.pdf",
						"x-retrieved-at": "2026-01-02T00:00:00.000Z",
					},
					body: pdf,
				})
			).status,
		).toBe(200);

		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			const input = { paperIds: [teamRecord.id], includePdf: true };
			const plan = await application.prepareTeamPull(input);
			expect(plan.kind).toBe("personal-corpus-write");
			const grant = await application.confirmOperation(plan.operationId, plan.manifestFingerprint);
			const result = await application.pullTeamPapers(input, grant);
			expect(result).toMatchObject({
				pulled: 1,
				created: [teamRecord.id],
				updated: [],
				unchanged: [],
				pdfs: [{ paperId: teamRecord.id, sha256, status: "stored" }],
			});

			const store = application.personalStore();
			const stored = await store.getPaper(teamRecord.id);
			expect(stored?.curation?.userNotes).toEqual([]);
			expect(stored?.curation?.screening).toBeUndefined();
			expect(stored?.curation?.teamReview?.status).toBe("team-approved");
			expect(stored?.provenance).toHaveLength(1);
			const versions = await store.listPaperVersions(teamRecord.id);
			expect(versions.map((version) => version.sha256)).toContain(sha256);

			const again = await application.prepareTeamPull(input);
			const secondGrant = await application.confirmOperation(again.operationId, again.manifestFingerprint);
			await expect(application.pullTeamPapers(input, secondGrant)).resolves.toMatchObject({
				pulled: 1,
				created: [],
				updated: [],
				unchanged: [teamRecord.id],
				pdfs: [{ paperId: teamRecord.id, sha256, status: "existed" }],
			});
		} finally {
			await application.close();
		}
	});
});
