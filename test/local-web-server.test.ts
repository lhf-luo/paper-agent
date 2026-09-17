import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";
import { saveTeamAccess } from "../src/team/infrastructure/team-access-file.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local Paper Agent web server", () => {
	it("serves the UI and API on loopback without local session credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent</title>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const executor: CommandExecutor = {
			exec: async () => ({ stdout: "Pages:          2\n", stderr: "", code: 0, killed: false }),
		};
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
			executor,
		});
		const record: PaperRecord = {
			id: "paper-web",
			title: "Stateful fuzzing",
			authors: ["Researcher"],
			identifiers: {},
			links: [{ url: "https://example.org/paper", kind: "landing" }],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore().upsertPaper(record);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const page = await fetch(server.url);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("Paper Agent");
			const workerModule = await fetch(`${server.url}/assets/worker.mjs`);
			expect(workerModule.status).toBe(200);
			expect(workerModule.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

			const status = await fetch(`${server.url}/api/status`);
			expect(status.status).toBe(200);
			const agentConfig = await fetch(`${server.url}/api/agent/config`);
			expect(agentConfig.status).toBe(503);
			expect(await agentConfig.json()).toEqual({ error: "Web Agent service is unavailable" });

			const library = await fetch(`${server.url}/api/library?q=stateful`);
			expect(library.status).toBe(200);
			expect((await library.json()) as unknown).toMatchObject({ hits: [{ record: { id: "paper-web" } }] });
			expect((await fetch(`${server.url}/api/evaluation/artifacts`)).status).toBe(404);

			const authenticated = (path: string, init: RequestInit = {}) =>
				fetch(`${server.url}${path}`, {
					...init,
					headers: { "content-type": "application/json", ...init.headers },
				});
			const annotationPrepare = await authenticated("/api/library/annotations/prepare", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-web"],
					tags: ["web-tested"],
					note: "Keep the evidence boundary visible.",
					screeningStatus: "include",
					screeningReason: "Fixture is relevant",
				}),
			});
			expect(annotationPrepare.status).toBe(200);
			const annotationPlan = (await annotationPrepare.json()) as {
				operationId: string;
				manifestFingerprint: string;
			};
			const annotationGrantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(annotationPlan),
			});
			const annotationGrant = await annotationGrantResponse.json();
			const annotationExecute = await authenticated("/api/library/annotations/execute", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-web"],
					tags: ["web-tested"],
					note: "Keep the evidence boundary visible.",
					screeningStatus: "include",
					screeningReason: "Fixture is relevant",
					grant: annotationGrant,
				}),
			});
			expect(annotationExecute.status).toBe(200);
			expect(await annotationExecute.json()).toMatchObject({ count: 1 });
			const annotatedDetails = await authenticated("/api/papers/paper-web?namespace=default");
			expect(await annotatedDetails.json()).toMatchObject({
				paper: {
					curation: {
						tags: ["web-tested"],
						screening: { status: "include" },
					},
				},
			});
			const exportPrepare = await authenticated("/api/library/export/prepare", {
				method: "POST",
				body: JSON.stringify({ format: "json", filename: "web-library.json", paperIds: ["paper-web"] }),
			});
			const exportPlan = (await exportPrepare.json()) as {
				operationId: string;
				manifestFingerprint: string;
			};
			const exportGrantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(exportPlan),
			});
			const exportGrant = await exportGrantResponse.json();
			const exportExecute = await authenticated("/api/library/export/execute", {
				method: "POST",
				body: JSON.stringify({
					format: "json",
					filename: "web-library.json",
					paperIds: ["paper-web"],
					grant: exportGrant,
				}),
			});
			expect(exportExecute.status).toBe(200);
			const exported = await authenticated("/api/library/exports/web-library.json?namespace=default");
			expect(exported.status).toBe(200);
			expect(JSON.parse(await exported.text())).toMatchObject({ records: [{ id: "paper-web" }] });
			expect((await authenticated("/api/config")).status).toBe(200);
			const providers = await authenticated("/api/providers");
			expect(providers.status).toBe(200);
			expect((await providers.json()) as unknown).toMatchObject({
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "arxiv" }),
					expect.objectContaining({
						id: "acl_anthology",
						searchConstraints: expect.objectContaining({ exactYear: true, singleVenue: true }),
					}),
					expect.objectContaining({ id: "exa", searchLimits: { supportsPagination: false, maxPageSize: 10 } }),
					expect.objectContaining({ id: "usenix", searchLimits: { supportsPagination: true, maxPageSize: 10 } }),
				]),
			});
			const namespaces = await authenticated("/api/namespaces");
			expect(namespaces.status).toBe(200);
			expect(await namespaces.json()).toMatchObject({ defaultNamespace: "default", personal: ["default"] });
			const malformedSearch = await authenticated("/api/search", {
				method: "POST",
				body: JSON.stringify({
					query: "stateful fuzzing",
					providers: ["arxiv"],
					filters: { authors: "not-an-array" },
				}),
			});
			expect(malformedSearch.status).toBe(400);
			expect(await malformedSearch.json()).toMatchObject({ error: expect.stringContaining("filters.authors") });
			const unconstrainedAclSearch = await authenticated("/api/search", {
				method: "POST",
				body: JSON.stringify({ query: "language models", providers: ["acl_anthology"], filters: {} }),
			});
			expect(unconstrainedAclSearch.status).toBe(400);
			expect(await unconstrainedAclSearch.json()).toMatchObject({ error: expect.stringContaining("exact year") });
			const nonSearchProvider = await authenticated("/api/search", {
				method: "POST",
				body: JSON.stringify({ query: "stateful fuzzing", providers: ["unpaywall"], filters: {} }),
			});
			expect(nonSearchProvider.status).toBe(400);
			expect(await nonSearchProvider.json()).toMatchObject({
				error: expect.stringContaining("Unsupported literature provider"),
			});
			const team = await authenticated("/api/team/overview");
			expect(await team.json()).toMatchObject({ configured: false, connected: false });

			const writeJob = await application.jobs.enqueue("pdf-download", {
				authorizationKey: "missing-confirmation",
				namespace: "default",
				request: { maxFiles: 1, maxBytesPerFile: 1, concurrency: 1 },
			});
			for (let attempt = 0; attempt < 100 && application.jobs.get(writeJob.id)?.status !== "failed"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(application.jobs.get(writeJob.id)?.status).toBe("failed");
			const rejectedRetry = await authenticated(`/api/jobs/${encodeURIComponent(writeJob.id)}/retry`, {
				method: "POST",
				body: "{}",
			});
			expect(rejectedRetry.status).toBe(409);
			expect(await rejectedRetry.json()).toMatchObject({
				error: expect.stringContaining("new review and confirmation"),
			});

			const folderPayload = { namespace: "default", name: "Security" };
			const folderPrepared = (await (
				await authenticated("/api/research/folders/create/prepare", {
					method: "POST",
					body: JSON.stringify(folderPayload),
				})
			).json()) as { operationId: string; manifestFingerprint: string };
			const folderGrant = await (
				await authenticated("/api/operations/confirm", {
					method: "POST",
					body: JSON.stringify(folderPrepared),
				})
			).json();
			const folderCreated = (await (
				await authenticated("/api/research/folders/create/execute", {
					method: "POST",
					body: JSON.stringify({ ...folderPayload, grant: folderGrant }),
				})
			).json()) as { folder: { id: string } };
			expect(await (await authenticated("/api/research/folders?namespace=default")).json()).toMatchObject({
				folders: [{ id: folderCreated.folder.id, name: "Security" }],
			});

			const researchNote = {
				title: "Web research note",
				markdown: "# Findings\n\nStateful fuzzing.",
				paperIds: ["paper-web"],
				templateId: "skim",
				folderId: folderCreated.folder.id,
			};
			const preparedResponse = await authenticated("/api/research/notes/create/prepare", {
				method: "POST",
				body: JSON.stringify(researchNote),
			});
			expect(preparedResponse.status).toBe(200);
			const prepared = (await preparedResponse.json()) as { operationId: string; manifestFingerprint: string };
			const grantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(prepared),
			});
			expect(grantResponse.status).toBe(200);
			const grant = await grantResponse.json();
			const saved = await authenticated("/api/research/notes/create/execute", {
				method: "POST",
				body: JSON.stringify({ ...researchNote, grant }),
			});
			expect(saved.status).toBe(200);
			const savedBody = (await saved.json()) as { note: { id: string; revision: number; contentHash: string } };
			expect(savedBody.note.revision).toBe(1);
			expect(await (await authenticated("/api/research/notes?namespace=default")).json()).toMatchObject({
				notes: [{ id: savedBody.note.id, title: "Web research note", folderId: folderCreated.folder.id }],
			});
			const syncedNotes = await authenticated("/api/research/notes/sync", {
				method: "POST",
				body: JSON.stringify({ namespace: "default" }),
			});
			expect(syncedNotes.status).toBe(200);
			expect(await syncedNotes.json()).toMatchObject({
				namespace: "default",
				result: { createdNotes: 0, updatedNotes: 0, deletedNotes: 0 },
			});
			expect(await (await authenticated("/api/research/note-index?namespace=default")).json()).toMatchObject({
				byPaperId: { "paper-web": [{ id: savedBody.note.id }] },
			});
			const templateBody = (await (await authenticated("/api/research/templates?namespace=default")).json()) as {
				templates: Array<{ id: string }>;
			};
			expect(templateBody.templates.map((template) => template.id)).toEqual([
				"blank",
				"comparison-matrix",
				"deep-reading",
				"skim",
			]);
			const updated = await authenticated(`/api/research/notes/${encodeURIComponent(savedBody.note.id)}`, {
				method: "PATCH",
				body: JSON.stringify({
					namespace: "default",
					title: "Updated research note",
					markdown: "updated",
					expectedRevision: savedBody.note.revision,
					expectedContentHash: savedBody.note.contentHash,
				}),
			});
			expect(updated.status).toBe(200);
			const deletePreparedResponse = await authenticated("/api/research/notes/delete/prepare", {
				method: "POST",
				body: JSON.stringify({ noteId: savedBody.note.id, namespace: "default", author: "tester" }),
			});
			expect(deletePreparedResponse.status).toBe(200);
			const deletePrepared = (await deletePreparedResponse.json()) as {
				operationId: string;
				manifestFingerprint: string;
			};
			const deleteGrant = await (
				await authenticated("/api/operations/confirm", {
					method: "POST",
					body: JSON.stringify(deletePrepared),
				})
			).json();
			const deleted = await authenticated("/api/research/notes/delete/execute", {
				method: "POST",
				body: JSON.stringify({
					noteId: savedBody.note.id,
					namespace: "default",
					author: "tester",
					grant: deleteGrant,
				}),
			});
			expect(deleted.status).toBe(200);
			const afterResearchDelete = (await (await authenticated("/api/research/notes?namespace=default")).json()) as {
				notes: unknown[];
			};
			expect(afterResearchDelete.notes).toEqual([]);
			const folderDeletePrepared = (await (
				await authenticated("/api/research/folders/delete/prepare", {
					method: "POST",
					body: JSON.stringify({ namespace: "default", folderId: folderCreated.folder.id }),
				})
			).json()) as { operationId: string; manifestFingerprint: string };
			const folderDeleteGrant = await (
				await authenticated("/api/operations/confirm", {
					method: "POST",
					body: JSON.stringify(folderDeletePrepared),
				})
			).json();
			const folderDeleted = await authenticated("/api/research/folders/delete/execute", {
				method: "POST",
				body: JSON.stringify({
					namespace: "default",
					folderId: folderCreated.folder.id,
					grant: folderDeleteGrant,
				}),
			});
			expect(folderDeleted.status).toBe(200);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("refuses non-loopback listeners", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-host-"));
		temporaryPaths.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		await expect(startLocalWebServer(application, { host: "0.0.0.0", staticRoot: root })).rejects.toThrow("loopback");
		await application.close();
	});

	it("forwards team search filters and cursor pagination through the local API", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-team-search-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent</title>");
		const teamServer = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("team-search-token"), roles: ["admin"] }],
		});
		await new Promise<void>((resolve) => teamServer.listen(0, "127.0.0.1", resolve));
		const address = teamServer.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		const teamUrl = `http://127.0.0.1:${address.port}`;
		await saveTeamAccess(root, {
			serverUrl: teamUrl,
			namespace: "security",
			token: "team-search-token",
			identity: "admin",
		});
		const record = (id: string, year: number): PaperRecord => ({
			id,
			title: `Stateful Web Search ${year}`,
			authors: ["Web Researcher"],
			year,
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "web-team-search", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		});
		const seeded = await fetch(`${teamUrl}/v1/namespaces/security/proposals`, {
			method: "POST",
			headers: { authorization: "Bearer team-search-token", "content-type": "application/json" },
			body: JSON.stringify({ records: [record("web-team-2024", 2024), record("web-team-2025", 2025)] }),
		});
		expect(seeded.status).toBe(200);
		// Readers only see approved records, so approve the seeds before asserting on search results.
		const preview = await fetch(`${teamUrl}/v1/namespaces/security/reviews/preview`, {
			method: "POST",
			headers: { authorization: "Bearer team-search-token", "content-type": "application/json" },
			body: JSON.stringify({ resource: "papers", ids: ["web-team-2024", "web-team-2025"] }),
		});
		expect(preview.status).toBe(200);
		const snapshots = (await preview.json()) as { entries: Array<{ id: string; version: string }> };
		const approved = await fetch(`${teamUrl}/v1/namespaces/security/reviews`, {
			method: "POST",
			headers: { authorization: "Bearer team-search-token", "content-type": "application/json" },
			body: JSON.stringify({
				paperIds: ["web-team-2024", "web-team-2025"],
				decision: "team-approved",
				expectedVersions: Object.fromEntries(snapshots.entries.map((entry) => [entry.id, entry.version])),
			}),
		});
		expect(approved.status).toBe(200);
		const application = new PaperAgentApplication({ projectRoot: root });
		const local = await startLocalWebServer(application, { staticRoot });
		try {
			const authenticated = (path: string) => fetch(`${local.url}${path}`);
			const first = await authenticated("/api/team/search?q=stateful&yearFrom=2024&yearTo=2025&limit=1");
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as {
				namespace: string;
				hits: Array<{ record: PaperRecord }>;
				nextCursor?: string;
			};
			expect(firstBody).toMatchObject({
				namespace: "security",
				hits: [{ record: { id: "web-team-2024" } }],
				nextCursor: "1",
			});
			const second = await authenticated(
				`/api/team/search?q=stateful&yearFrom=2024&yearTo=2025&limit=1&cursor=${firstBody.nextCursor}`,
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toMatchObject({ hits: [{ record: { id: "web-team-2025" } }] });
		} finally {
			await local.close();
			await application.close();
			await new Promise<void>((resolve) => teamServer.close(() => resolve()));
		}
	});
});
