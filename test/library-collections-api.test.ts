import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import type { PaperRecord, PaperVersion, SearchRun } from "../src/literature/domain/literature-types.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function searchRun(id: string, namespace: string, results: PaperRecord[]): SearchRun {
	return {
		id,
		startedAt: "2026-08-01T00:00:00.000Z",
		completedAt: "2026-08-01T00:00:05.000Z",
		queries: [`query-${namespace}`],
		filters: {},
		providers: [],
		pagesPerProvider: 1,
		maxResultsPerProvider: 20,
		results,
		failures: [],
		sourceCounts: {},
		deduplicatedCount: 0,
		scope: "personal",
		mode: "once",
		namespace,
	};
}

describe("library collections API", () => {
	it("creates, lists, assigns, filters, renames, and deletes collections", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-collections-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const executor: CommandExecutor = {
			exec: async () => ({ stdout: "Pages:          2\n", stderr: "", code: 0, killed: false }),
		};
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
			executor,
			doiProviderLookup: async () => undefined,
		});
		const record: PaperRecord = {
			id: "paper-col",
			title: "Stateful fuzzing",
			authors: ["Researcher"],
			identifiers: { doi: "10.1000/coltest.1" },
			links: [{ url: "https://example.org/paper", kind: "landing" }],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore().upsertPaper(record);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const api = (path: string, init: RequestInit = {}) =>
				fetch(`${server.url}${path}`, {
					...init,
					headers: { "content-type": "application/json", ...init.headers },
				});

			// create
			const created = await api("/api/library/collections", {
				method: "POST",
				body: JSON.stringify({ name: "ML Safety" }),
			});
			expect(created.status).toBe(201);
			const collection = (await created.json()) as { id: string; name: string };
			expect(collection.name).toBe("ML Safety");
			expect(collection.id).toMatch(/^col-/);

			// create is idempotent (same name)
			const again = await api("/api/library/collections", {
				method: "POST",
				body: JSON.stringify({ name: "ML Safety" }),
			});
			expect((await again.json()) as { id: string }).toMatchObject({ id: collection.id });

			// list
			const list = await api("/api/library/collections");
			expect(list.status).toBe(200);
			const collections = (await list.json()) as Array<{ id: string; name: string }>;
			expect(collections).toHaveLength(1);
			expect(collections[0].name).toBe("ML Safety");

			// assign paper to collection
			const assign = await api(`/api/papers/${encodeURIComponent(record.id)}/collections`, {
				method: "PATCH",
				body: JSON.stringify({ collectionIds: [collection.id] }),
			});
			expect(assign.status).toBe(200);
			const assigned = (await assign.json()) as { collectionIds: string[] };
			expect(assigned.collectionIds).toEqual([collection.id]);

			// filter library by collection
			const filtered = await api(`/api/library?collection=${encodeURIComponent(collection.id)}`);
			expect(filtered.status).toBe(200);
			const filteredBody = (await filtered.json()) as { hits: Array<{ record: PaperRecord }> };
			expect(filteredBody.hits).toHaveLength(1);
			expect(filteredBody.hits[0].record.id).toBe(record.id);

			// filter uncategorized (should be empty now)
			const uncategorized = await api("/api/library?collection=__uncategorized__");
			const uncatBody = (await uncategorized.json()) as { hits: Array<{ record: PaperRecord }> };
			expect(uncatBody.hits).toHaveLength(0);

			// rename
			const renamed = await api(`/api/library/collections/${encodeURIComponent(collection.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ name: "AI Safety" }),
			});
			expect(renamed.status).toBe(200);
			expect(((await renamed.json()) as { name: string }).name).toBe("AI Safety");

			// delete
			const del = await api(`/api/library/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			const afterDelete = await api("/api/library/collections");
			expect(((await afterDelete.json()) as unknown[]).length).toBe(0);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("moves nested collections, assigns dragged papers, and deletes a subtree", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-collection-tree-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const namespace = "nested";
		const paper: PaperRecord = {
			id: "paper-nested",
			title: "Nested collections",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		const secondPaper = { ...paper, id: "paper-nested-second", title: "Nested collections II" };
		await application.personalStore(namespace).upsertPapers([paper, secondPaper]);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const api = (path: string, init: RequestInit = {}) =>
				fetch(`${server.url}${path}`, {
					...init,
					headers: { "content-type": "application/json", ...init.headers },
				});
			const create = async (name: string, parentId?: string) => {
				const response = await api("/api/library/collections", {
					method: "POST",
					body: JSON.stringify({ name, parentId, namespace }),
				});
				expect(response.status).toBe(201);
				return (await response.json()) as { id: string; parentId?: string };
			};
			const parent = await create("Parent");
			const child = await create("Child", parent.id);
			const grandchild = await create("Grandchild", child.id);
			const foreignParent = await application.createLibraryCollection("Foreign", undefined, "other-namespace");
			const crossNamespace = await api("/api/library/collections", {
				method: "POST",
				body: JSON.stringify({ name: "Invalid child", parentId: foreignParent.id, namespace }),
			});
			expect(crossNamespace.status).toBe(500);
			const moved = await api(`/api/library/collections/${grandchild.id}?namespace=${namespace}`, {
				method: "PATCH",
				body: JSON.stringify({ parentId: parent.id }),
			});
			expect(moved.status).toBe(200);
			expect((await moved.json()) as { parentId: string }).toMatchObject({ parentId: parent.id });

			const cycle = await api(`/api/library/collections/${parent.id}?namespace=${namespace}`, {
				method: "PATCH",
				body: JSON.stringify({ parentId: child.id }),
			});
			expect(cycle.status).toBe(500);
			const assign = await api(`/api/library/collections/${child.id}/papers`, {
				method: "PATCH",
				body: JSON.stringify({ namespace, paperIds: [paper.id, secondPaper.id], mode: "assign" }),
			});
			expect(assign.status).toBe(200);
			expect(await application.personalStore(namespace).getPaper(paper.id)).toMatchObject({
				collectionIds: [child.id],
			});
			expect(await application.personalStore(namespace).getPaper(secondPaper.id)).toMatchObject({
				collectionIds: [child.id],
			});
			const parentView = await api(`/api/library?namespace=${namespace}&collection=${parent.id}`);
			expect(((await parentView.json()) as { hits: unknown[] }).hits).toHaveLength(0);

			const deleted = await api(`/api/library/collections/${parent.id}?namespace=${namespace}`, {
				method: "DELETE",
			});
			expect(deleted.status).toBe(200);
			expect((await deleted.json()) as { deletedCollectionIds: string[] }).toMatchObject({
				deletedCollectionIds: [parent.id, child.id, grandchild.id],
			});
			expect(await application.personalStore(namespace).getPaper(paper.id)).toMatchObject({ id: paper.id });
			expect((await application.personalStore(namespace).getPaper(paper.id))?.collectionIds ?? []).toEqual([]);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("removes a paper from one collection before permanently deleting its final record", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-paper-removal-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const record: PaperRecord = {
			id: "paper-removal",
			title: "Paper removal",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore().upsertPaper(record);
		const first = await application.createLibraryCollection("First", undefined);
		const second = await application.createLibraryCollection("Second", undefined);
		await application.setPaperCollections(record.id, [first.id, second.id]);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const api = (path: string, body: Record<string, unknown>) =>
				fetch(`${server.url}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const confirm = async (prepared: { operationId: string; manifestFingerprint: string }) =>
				(await api("/api/operations/confirm", prepared)).json();

			const removePreparedResponse = await api("/api/library/papers/remove/prepare", {
				paperId: record.id,
				collectionId: first.id,
			});
			expect(removePreparedResponse.status).toBe(200);
			const removePrepared = (await removePreparedResponse.json()) as {
				operationId: string;
				manifestFingerprint: string;
				details: { mode: string };
			};
			expect(removePrepared.details.mode).toBe("remove-from-collection");
			const removed = await api("/api/library/papers/remove/execute", {
				paperId: record.id,
				collectionId: first.id,
				grant: await confirm(removePrepared),
			});
			expect(await removed.json()).toMatchObject({ mode: "remove-from-collection" });
			expect(await application.personalStore().getPaper(record.id)).toMatchObject({ collectionIds: [second.id] });

			const deletePreparedResponse = await api("/api/library/papers/remove/prepare", {
				paperId: record.id,
				collectionId: second.id,
			});
			const deletePrepared = (await deletePreparedResponse.json()) as {
				operationId: string;
				manifestFingerprint: string;
				details: { mode: string };
			};
			expect(deletePrepared.details.mode).toBe("permanent-delete");
			const deleted = await api("/api/library/papers/remove/execute", {
				paperId: record.id,
				collectionId: second.id,
				grant: await confirm(deletePrepared),
			});
			expect(await deleted.json()).toMatchObject({ mode: "permanent-delete", deleted: [record.id] });
			expect(await application.personalStore().getPaper(record.id)).toBeUndefined();
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("permanently deletes multiple selected papers with one confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-batch-removal-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const records: PaperRecord[] = ["batch-paper-one", "batch-paper-two"].map((id, index) => ({
			id,
			title: `Batch paper ${index + 1}`,
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		}));
		for (const record of records) await application.personalStore().upsertPaper(record);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const post = (path: string, body: Record<string, unknown>) =>
				fetch(`${server.url}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const paperIds = records.map((record) => record.id);
			const preparedResponse = await post("/api/library/papers/remove/prepare", { paperIds });
			expect(preparedResponse.status).toBe(200);
			const prepared = (await preparedResponse.json()) as {
				operationId: string;
				manifestFingerprint: string;
				details: { mode: string; paperCount: number; paperIds: string[] };
			};
			expect(prepared.details).toMatchObject({ mode: "permanent-delete", paperCount: 2, paperIds });
			const grant = await (await post("/api/operations/confirm", prepared)).json();
			const executed = await post("/api/library/papers/remove/execute", { paperIds, grant });
			expect(await executed.json()).toMatchObject({
				mode: "permanent-delete",
				deleted: paperIds,
				removedFromCollection: [],
			});
			expect(await application.personalStore().listPapers()).toEqual([]);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("saves a selection into a collection without a confirmation grant", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-save-col-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const executor: CommandExecutor = {
			exec: async () => ({ stdout: "Pages:          2\n", stderr: "", code: 0, killed: false }),
		};
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
			executor,
			doiProviderLookup: async () => undefined,
		});

		// 在个人 SQLite 中建立一条可复用搜索记录。
		const runId = "run-save-col";
		const candidate: PaperRecord = {
			id: "paper-save-col",
			title: "Save collection test paper",
			authors: ["Researcher"],
			year: 2025,
			identifiers: { doi: "10.1000/savecol.1" },
			links: [{ url: "https://example.org/paper", kind: "landing" }],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore().saveSearchRun(searchRun(runId, "default", [candidate]));
		const sidebarResults = join(root, ".paper-agent", "web-agent-memory", "results");
		await mkdir(sidebarResults, { recursive: true });
		await writeFile(
			join(sidebarResults, "save-collection.md"),
			`<!-- paper-agent-sidebar-meta {"rows":[{"paper_id":"${candidate.id}","search_run_id":"${runId}"}]} -->`,
			"utf8",
		);

		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const api = (path: string, init: RequestInit = {}) =>
				fetch(`${server.url}${path}`, {
					...init,
					headers: { "content-type": "application/json", ...init.headers },
				});

			// 建分类。
			const created = await api("/api/library/collections", {
				method: "POST",
				body: JSON.stringify({ name: "Saved" }),
			});
			const collection = (await created.json()) as { id: string };

			// 免确认保存到分类。
			const save = await api("/api/library/import/save", {
				method: "POST",
				body: JSON.stringify({
					sidebarResultUrl: "/api/agent/results/save-collection.md",
					paperIds: [candidate.id],
					collectionId: collection.id,
				}),
			});
			expect(save.status).toBe(202);
			const job = (await save.json()) as { id: string };

			// 等待 job 完成。
			const deadline = Date.now() + 5_000;
			let state = application.jobs.get(job.id);
			while (state && state.status !== "succeeded" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				state = application.jobs.get(job.id);
			}
			expect(state?.status).toBe("succeeded");

			// 论文应带 collectionId。
			const stored = await application.personalStore().getPaper(candidate.id);
			expect(stored?.collectionIds).toContain(collection.id);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("lists and reads SQLite search runs only within the requested namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-runs-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const candidate = (id: string): PaperRecord => ({
			id,
			title: id,
			abstract: `${id} abstract`,
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		});
		await application
			.personalStore("default")
			.saveSearchRun(searchRun("run-default", "default", [candidate("paper-default")]));
		await application
			.personalStore("research")
			.saveSearchRun(searchRun("run-research", "research", [candidate("paper-research")]));
		await expect(
			application.prepareCorpusImport({ searchRunId: "run-research", namespace: "default" }),
		).rejects.toThrow("namespace default");
		await expect(
			application.prepareCorpusImport({ searchRunId: "run-research", namespace: "research" }),
		).resolves.toMatchObject({ kind: "personal-corpus-write" });

		const server = await startLocalWebServer(application, { staticRoot });
		const api = (path: string) => fetch(`${server.url}${path}`);
		try {
			const defaultList = await api("/api/search/runs");
			expect(defaultList.status).toBe(200);
			expect(((await defaultList.json()) as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([
				"run-default",
			]);

			const researchList = await api("/api/search/runs?namespace=research");
			expect(((await researchList.json()) as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([
				"run-research",
			]);

			const detail = await api("/api/search/runs/run-research?namespace=research");
			expect(detail.status).toBe(200);
			expect(((await detail.json()) as { run: SearchRun }).run.results[0]?.id).toBe("paper-research");
			const abstract = await api("/api/search/runs/run-research/papers/paper-research?namespace=research");
			expect(await abstract.json()).toEqual({ paperId: "paper-research", abstract: "paper-research abstract" });
			expect((await api("/api/search/runs/run-research/papers/missing?namespace=research")).status).toBe(404);
			expect((await api("/api/search/runs/run-default?namespace=research")).status).toBe(404);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("indexes complete collection memberships within the requested namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-membership-index-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const namespace = "membership-test";
		const firstCollection = await application.createLibraryCollection("First", undefined, namespace);
		const secondCollection = await application.createLibraryCollection("Second", undefined, namespace);
		const emptyCollection = await application.createLibraryCollection("Empty", undefined, namespace);
		const paper = (id: string, collectionIds?: string[]): PaperRecord => ({
			id,
			title: id,
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
			collectionIds,
		});
		await application
			.personalStore(namespace)
			.upsertPapers([
				paper("paper-first", [firstCollection.id]),
				paper("paper-overlap", [firstCollection.id, secondCollection.id]),
				paper("paper-uncategorized"),
			]);
		await application.personalStore().upsertPaper(paper("paper-default-only"));

		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const response = await fetch(
				`${server.url}/api/library/collection-memberships?namespace=${encodeURIComponent(namespace)}`,
			);
			expect(response.status).toBe(200);
			const index = (await response.json()) as {
				namespace: string;
				allPaperIds: string[];
				uncategorizedPaperIds: string[];
				collectionPaperIds: Record<string, string[]>;
			};
			expect(index.namespace).toBe(namespace);
			expect(index.allPaperIds).toEqual(["paper-first", "paper-overlap", "paper-uncategorized"]);
			expect(index.uncategorizedPaperIds).toEqual(["paper-uncategorized"]);
			expect(index.collectionPaperIds[firstCollection.id]).toEqual(["paper-first", "paper-overlap"]);
			expect(index.collectionPaperIds[secondCollection.id]).toEqual(["paper-overlap"]);
			expect(index.collectionPaperIds[emptyCollection.id]).toEqual([]);
			expect(index.allPaperIds).not.toContain("paper-default-only");

			const wrongMethod = await fetch(`${server.url}/api/papers/paper-first/collections`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ collectionIds: [secondCollection.id], namespace }),
			});
			expect(wrongMethod.status).toBe(404);

			const assignment = await fetch(`${server.url}/api/papers/paper-first/collections`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ collectionIds: [secondCollection.id], namespace }),
			});
			expect(assignment.status, await assignment.text()).toBe(200);
			expect((await application.personalStore(namespace).getPaper("paper-first"))?.collectionIds).toEqual([
				secondCollection.id,
			]);
			expect(await application.personalStore().getPaper("paper-first")).toBeUndefined();
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("deletes one PDF version, reassigns the preferred version, and removes dependent MinerU material", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-version-removal-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const record: PaperRecord = {
			id: "paper-version-removal",
			title: "Version removal",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		const store = application.personalStore();
		await store.upsertPaper(record);
		const saveVersion = async (
			name: string,
			versionKind: NonNullable<PaperVersion["versionKind"]>,
			isPreferred: boolean,
		) => {
			const body = Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`);
			const blob = await store.putBlob(body);
			const version: PaperVersion = {
				paperId: record.id,
				sourceUrl: `https://example.test/${name}.pdf`,
				finalUrl: `https://example.test/${name}.pdf`,
				retrievedAt: `2026-09-1${versionKind === "published" ? "7" : "6"}T00:00:00.000Z`,
				sha256: blob.sha256,
				bytes: body.length,
				blobPath: blob.path,
				contentType: "application/pdf",
				versionKind,
				isPreferred,
			};
			await store.savePaperVersion(version);
			return version;
		};
		const preprint = await saveVersion("preprint", "preprint", false);
		const published = await saveVersion("published", "published", true);
		const materialPath = join(store.personalFilesRoot, record.id, "mineru");
		await mkdir(materialPath, { recursive: true });
		await writeFile(join(materialPath, "content.md"), "parsed");
		await store.savePdfMaterial({
			paperId: record.id,
			sourceSha256: published.sha256,
			relativePath: relative(store.personalDataRoot, materialPath),
			engine: "mineru",
			modelVersion: "vlm",
			packageSha256: "a".repeat(64),
			contentSha256: "b".repeat(64),
			pageCount: 2,
			fileCount: 1,
			bytes: 6,
		});
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const post = (path: string, body: Record<string, unknown>) =>
				fetch(`${server.url}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const payload = { paperId: record.id, sha256: published.sha256 };
			const preparedResponse = await post("/api/library/pdf-versions/remove/prepare", payload);
			expect(preparedResponse.status).toBe(200);
			const prepared = (await preparedResponse.json()) as {
				operationId: string;
				manifestFingerprint: string;
				details: { isPreferred: boolean; deletesMineruMaterial: boolean };
			};
			expect(prepared.details).toMatchObject({ isPreferred: true, deletesMineruMaterial: true });
			const grant = await (await post("/api/operations/confirm", prepared)).json();
			const executed = await post("/api/library/pdf-versions/remove/execute", { ...payload, grant });
			const executedText = await executed.text();
			expect(executed.status, executedText).toBe(200);
			const result = JSON.parse(executedText) as {
				preferredSha256?: string;
				mineruMaterialDeleted: boolean;
			};
			expect(result).toMatchObject({
				preferredSha256: preprint.sha256,
				mineruMaterialDeleted: true,
			});
			expect(await store.listPaperVersions(record.id)).toMatchObject([
				{ sha256: preprint.sha256, isPreferred: true },
			]);
			expect(await store.getPdfMaterial(record.id)).toBeUndefined();
			await expect(stat(published.blobPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(stat(materialPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("uploads a local PDF to the requested namespace and deduplicates identical versions", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-local-pdf-api-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "dist", "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		const namespace = "alternate";
		const record: PaperRecord = {
			id: "paper-local-pdf",
			title: "Local PDF target",
			authors: ["Researcher"],
			identifiers: {},
			links: [{ url: "https://example.org/paper", kind: "landing" }],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore(namespace).upsertPaper(record);
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const upload = (body: BodyInit) =>
				fetch(
					`${server.url}/api/papers/${encodeURIComponent(record.id)}/pdf?namespace=${encodeURIComponent(namespace)}`,
					{
						method: "POST",
						headers: { "content-type": "application/pdf" },
						body,
					},
				);
			const pdf = Buffer.from("%PDF-1.4\nlocal fixture\n%%EOF\n");
			const firstUpload = await upload(pdf);
			expect(firstUpload.status, await firstUpload.text()).toBe(200);
			expect((await upload(pdf)).status).toBe(200);

			const versions = await application.personalStore(namespace).listPaperVersions(record.id);
			expect(versions).toHaveLength(1);
			expect(versions[0]).toMatchObject({ versionKind: "published", isPreferred: true });
			const publicationVersions = await application.personalStore(namespace).listPublicationVersions(record.id);
			expect(publicationVersions).toMatchObject([
				{ id: versions[0].publicationVersionId, kind: "published", isPreferred: true },
			]);
			const pdfUrl = `${server.url}/api/papers/${encodeURIComponent(record.id)}/pdf/${versions[0].sha256}?namespace=${encodeURIComponent(namespace)}`;
			const full = await fetch(pdfUrl);
			expect(full.status).toBe(200);
			expect(full.headers.get("accept-ranges")).toBe("bytes");
			expect(full.headers.get("etag")).toBe(`"${versions[0].sha256}"`);
			expect(full.headers.get("content-disposition")).toContain("inline;");
			expect(Buffer.from(await full.arrayBuffer())).toEqual(pdf);

			const head = await fetch(pdfUrl, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.headers.get("content-length")).toBe(String(pdf.length));
			expect((await head.arrayBuffer()).byteLength).toBe(0);

			const range = await fetch(pdfUrl, { headers: { range: "bytes=5-12" } });
			expect(range.status).toBe(206);
			expect(range.headers.get("content-range")).toBe(`bytes 5-12/${pdf.length}`);
			expect(Buffer.from(await range.arrayBuffer())).toEqual(pdf.subarray(5, 13));

			const suffix = await fetch(pdfUrl, { headers: { range: "bytes=-5" } });
			expect(suffix.status).toBe(206);
			expect(Buffer.from(await suffix.arrayBuffer())).toEqual(pdf.subarray(-5));

			const invalidRange = await fetch(pdfUrl, { headers: { range: `bytes=${pdf.length}-` } });
			expect(invalidRange.status).toBe(416);
			expect(invalidRange.headers.get("content-range")).toBe(`bytes */${pdf.length}`);
			expect((await application.personalStore(namespace).getPaper(record.id))?.materialHashes).toEqual([
				versions[0].sha256,
			]);
			expect(await application.personalStore().getPaper(record.id)).toBeUndefined();
			expect((await upload(Buffer.from("not a pdf"))).status).toBe(400);
		} finally {
			await server.close();
			await application.close();
		}
	});
});
