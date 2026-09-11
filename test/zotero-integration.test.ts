import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ZoteroIntegrationService } from "../src/extensions/zotero/application/zotero-integration.ts";
import {
	collectionKeysWithAncestors,
	descendantKeys,
	matchPersonalPaper,
} from "../src/extensions/zotero/application/zotero-selection.ts";
import { paperRecordFromZotero, paperToZoteroData } from "../src/extensions/zotero/domain/zotero-mapping.ts";
import type { ZoteroApiItem } from "../src/extensions/zotero/domain/zotero-types.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { OperationConsentManager } from "../src/shared/application/operation-consent.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

function item(): ZoteroApiItem {
	return {
		key: "ITEM0001",
		version: 7,
		data: {
			key: "ITEM0001",
			version: 7,
			itemType: "conferencePaper",
			title: "A Compiler Paper",
			creators: [
				{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
				{ creatorType: "editor", name: "Ignored Editor" },
			],
			abstractNote: "Evidence.",
			date: "2026-08",
			conferenceName: "PLDI",
			DOI: "https://doi.org/10.1145/123.456",
			extra: "arXiv: 2601.01234",
			url: "https://example.test/p/paper",
			collections: ["C"],
			tags: [{ tag: "compiler" }],
		},
	};
}

describe("Zotero integration", () => {
	it("preserves complete collection ancestry and bounded descendants", () => {
		const collections = [{ key: "A" }, { key: "B", parentKey: "A" }, { key: "C", parentKey: "B" }];
		expect([...descendantKeys(collections, ["B"])]).toEqual(["B", "C"]);
		expect([...collectionKeysWithAncestors(collections, ["B"])]).toEqual(["B", "A"]);
		expect([...collectionKeysWithAncestors(collections, ["C"])]).toEqual(["C", "B", "A"]);
	});

	it("maps supported metadata and omits internal Paper Agent tags", () => {
		const record = paperRecordFromZotero(item(), "server-one");
		expect(record).toMatchObject({
			title: "A Compiler Paper",
			authors: ["Ada Lovelace"],
			year: 2026,
			venue: "PLDI",
			publicationType: "conference-paper",
			identifiers: { doi: "10.1145/123.456", arxivId: "2601.01234" },
		});
		const exported = paperToZoteroData(
			{ ...record, curation: { tags: ["compiler", "needs-skim-card"], userNotes: [] } },
			{
				key: "",
				version: 0,
				itemType: "conferencePaper",
				collections: ["EXISTING"],
				tags: [{ tag: "local-only" }],
				extra: "Citation Key: lovelace2026",
			},
			["C"],
		);
		expect(exported.tags).toEqual([{ tag: "local-only" }, { tag: "compiler" }]);
		expect(exported.collections).toEqual(["EXISTING", "C"]);
		expect(exported.extra).toBe("Citation Key: lovelace2026\narXiv: 2601.01234");
	});

	it("builds a valid new item from a minimal local API fallback template", () => {
		const record = paperRecordFromZotero(item(), "server-one");
		const exported = paperToZoteroData(record, { itemType: "conferencePaper" }, ["C"]);
		expect(exported).toMatchObject({
			itemType: "conferencePaper",
			title: "A Compiler Paper",
			collections: ["C"],
			creators: [{ creatorType: "author", name: "Ada Lovelace" }],
		});
	});

	it("matches an older personal paper through the PDF version table", async () => {
		const candidate = {
			...paperRecordFromZotero(item(), "personal"),
			id: "personal-paper",
			title: "Different local title",
			identifiers: {},
			materialHashes: undefined,
		};
		const source = item();
		source.data.DOI = undefined;
		source.data.extra = undefined;
		const sha256 = "a".repeat(64);
		const store = {
			listPapers: async () => [candidate],
			listPaperVersions: async () => [
				{
					paperId: candidate.id,
					sourceUrl: "file:///paper.pdf",
					finalUrl: "file:///paper.pdf",
					retrievedAt: "2026-01-01T00:00:00.000Z",
					sha256,
					bytes: 10,
					blobPath: "paper.pdf",
					contentType: "application/pdf",
				},
			],
		} as unknown as LiteratureStore;
		expect((await matchPersonalPaper(store, source, "server-one", [], sha256)).existing?.id).toBe(candidate.id);
	});

	it("atomically creates the full collection path and Zotero mappings", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-zotero-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const record = paperRecordFromZotero(item(), "server-one");
		const result = await store.importLocalPapersAtomically(
			[
				{
					record,
					zotero: {
						serverId: "server-one",
						libraryId: "0",
						itemKey: "ITEM0001",
						itemVersion: 7,
						collectionKeys: ["C"],
					},
				},
			],
			{
				reportId: "zotero-import-test",
				report: { source: "zotero" },
				collectionSpecs: [
					{ externalKey: "A", name: "A", version: 1, path: ["A"] },
					{ externalKey: "B", name: "B", parentExternalKey: "A", version: 2, path: ["A", "B"] },
					{ externalKey: "C", name: "C", parentExternalKey: "B", version: 3, path: ["A", "B", "C"] },
				],
			},
		);
		const collections = await store.listCollections();
		const a = collections.find((value) => value.name === "A")!;
		const b = collections.find((value) => value.name === "B")!;
		const c = collections.find((value) => value.name === "C")!;
		expect(b.parentId).toBe(a.id);
		expect(c.parentId).toBe(b.id);
		expect(result.records[0].collectionIds).toEqual([c.id]);
		expect(await store.listZoteroItemMappings("server-one")).toMatchObject([
			{ paperId: record.id, itemKey: "ITEM0001", itemVersion: 7 },
		]);
		expect((await store.listZoteroCollectionMappings("server-one")).map((value) => value.path)).toEqual([
			["A"],
			["A", "B"],
			["A", "B", "C"],
		]);
		await store.deletePapers([record.id]);
		expect(await store.listZoteroItemMappings("server-one")).toEqual([]);
		await store.deleteCollection(a.id);
		expect(await store.listZoteroCollectionMappings("server-one")).toEqual([]);
		const database = new DatabaseSync(join(root, ".paper-agent", "corpus", "personal.sqlite"));
		expect(database.prepare("SELECT name FROM schema_migrations WHERE version = 4").get()).toMatchObject({
			name: "zotero-local-api-mappings",
		});
		database.close();
	});

	it("continues a multi-paper import when one Zotero item fails revalidation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-zotero-isolation-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const consent = new OperationConsentManager({
			auditPath: join(root, "audit", "operations.jsonl"),
			signingKeyPath: join(root, "runtime", "operation-signing.key"),
		});
		const failing = {
			...item(),
			key: "FAIL0001",
			data: { ...item().data, key: "FAIL0001", title: "Failing paper", DOI: "10.1/fail" },
		};
		const working = {
			...item(),
			key: "GOOD0001",
			data: { ...item().data, key: "GOOD0001", title: "Working paper", DOI: "10.1/good" },
		};
		const client = {
			listCollections: async () => [],
			listItems: async () => [failing, working],
			getChildren: async () => [],
			getItem: async (key: string) => {
				if (key === failing.key) throw new Error("item unavailable");
				return working;
			},
		};
		const service = new ZoteroIntegrationService({
			projectRoot: root,
			consent,
			defaultNamespace: "alice",
			store: () => store,
		});
		Object.defineProperty(service, "client", { value: async () => client });
		service.status = async () => ({
			running: true,
			localApiEnabled: true,
			writeAuthorized: false,
			serverId: "server-one",
			message: "ready",
		});
		const prepared = await service.prepareImport({
			namespace: "alice",
			itemKeys: [failing.key, working.key],
		});
		const grant = await consent.confirm(
			prepared.operation.operationId,
			prepared.operation.manifestFingerprint,
			"test-user",
		);
		const failed = await service.executeImportItem(prepared.operation.operationId, failing.key, grant);
		expect(failed).toMatchObject({
			imported: 0,
			failed: [{ itemKey: "FAIL0001", title: "Failing paper", error: "item unavailable" }],
		});
		expect(await store.listPapers()).toEqual([]);
		const imported = await service.executeImportItem(prepared.operation.operationId, working.key, grant);
		expect(imported).toMatchObject({ imported: 1, failed: [] });
		expect((await store.listPapers()).map((paper) => paper.title)).toEqual(["Working paper"]);
		await expect(service.executeImport(prepared.operation.operationId, grant)).rejects.toThrow("预览已过期");
	});
});
