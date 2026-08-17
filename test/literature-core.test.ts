import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deduplicatePaperRecords,
	findPossibleDuplicates,
	normalizeArxivId,
	normalizeDoi,
	paperRecordId,
	titleSimilarity,
} from "../src/literature-identifiers.ts";
import { derivedCacheKey, LiteratureStore } from "../src/literature-store.ts";
import { buildPaperMaterialPackage } from "../src/tools/paper-package-tools.ts";
import type { ArtifactManifest, PaperRecord, PaperVersion, SearchRun } from "../src/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
	const record: PaperRecord = {
		id: "",
		title: "A Study of Stateful Fuzzing",
		authors: ["Ada Example"],
		year: 2025,
		identifiers: { doi: "10.1000/Example.1" },
		links: [{ url: "https://doi.org/10.1000/example.1", kind: "doi" }],
		provenance: [{ provider: "crossref", query: "stateful fuzzing", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		...overrides,
	};
	record.id = paperRecordId(record);
	return record;
}

describe("literature identifiers and corpus", () => {
	it("rejects backup destinations at or below the corpus root without confusing path prefixes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-backup-path-"));
		temporaryPaths.push(root);
		const corpusRoot = join(root, "corpus");
		const store = new LiteratureStore(corpusRoot, "team", "default");
		await store.initialize();
		await expect(store.backupTo(corpusRoot)).rejects.toThrow("must not be inside");
		await expect(store.backupTo(join(corpusRoot, "nested"))).rejects.toThrow("must not be inside");
		await expect(store.backupTo(join(root, "corpus-backups"))).resolves.toContain("corpus-backups");
	});

	it("normalizes identifiers and merges exact DOI duplicates with provenance", () => {
		expect(normalizeDoi("https://doi.org/10.1000/Example.1).")).toBe("10.1000/example.1");
		expect(normalizeArxivId("https://arxiv.org/pdf/2501.01234v2.pdf")).toBe("2501.01234");

		const first = paper();
		const second = paper({
			title: "A Study of Stateful Fuzzing ",
			identifiers: { doi: "doi:10.1000/example.1" },
			provenance: [{ provider: "openalex", query: "protocol fuzzing", retrievedAt: "2026-01-02T00:00:00.000Z" }],
		});
		const merged = deduplicatePaperRecords([first, second]);

		expect(merged).toHaveLength(1);
		expect(merged[0].identifiers.doi).toBe("10.1000/example.1");
		expect(merged[0].provenance.map((item) => item.provider).sort()).toEqual(["crossref", "openalex"]);
		expect(titleSimilarity("Stateful protocol fuzzing", "Protocol fuzzing for stateful systems")).toBeGreaterThan(
			0.6,
		);

		const preprint = paper({
			identifiers: { arxivId: "2501.01234" },
			provenance: [{ provider: "arxiv", query: "fuzzing", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		});
		preprint.id = paperRecordId(preprint);
		const versionMerged = deduplicatePaperRecords([preprint, first]);
		expect(versionMerged).toHaveLength(2);
		expect(findPossibleDuplicates(versionMerged)).toHaveLength(1);

		const sharedHash = "f".repeat(64);
		const localOne = paper({
			title: "Local filename metadata one",
			identifiers: {},
			materialHashes: [sharedHash],
		});
		localOne.id = paperRecordId(localOne);
		const localTwo = paper({
			title: "Different local PDF title metadata",
			identifiers: {},
			materialHashes: [sharedHash],
		});
		localTwo.id = paperRecordId(localTwo);
		expect(deduplicatePaperRecords([localOne, localTwo])).toHaveLength(1);

		const metadataOnlyOne = paper({
			identifiers: {},
			links: [],
			provenance: [
				{
					provider: "crossref",
					query: "same metadata",
					retrievedAt: "2026-01-01T00:00:00Z",
					providerRecordId: "one",
				},
			],
		});
		const metadataOnlyTwo = paper({
			identifiers: {},
			links: [],
			provenance: [
				{
					provider: "openalex",
					query: "same metadata",
					retrievedAt: "2026-01-01T00:00:00Z",
					providerRecordId: "two",
				},
			],
		});
		expect(deduplicatePaperRecords([metadataOnlyOne, metadataOnlyTwo])).toHaveLength(2);
		expect(findPossibleDuplicates([metadataOnlyOne, metadataOnlyTwo])).toHaveLength(1);

		const possible = paper({
			title: "A Study of Stateful Protocol Fuzzing",
			identifiers: { doi: "10.1000/example.2" },
		});
		possible.id = paperRecordId(possible);
		expect(findPossibleDuplicates([first, possible])).toMatchObject([
			{ leftId: first.id, rightId: possible.id, reason: "similar-title" },
		]);
	});

	it("persists, audits, exports, promotes, and reuses deterministic derived keys", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-corpus-"));
		temporaryPaths.push(root);
		const personal = new LiteratureStore(join(root, "personal"), "personal", "alice");
		const team = new LiteratureStore(join(root, "team"), "team", "shared");
		const record = paper();
		const run: SearchRun = {
			id: "search-test",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:01:00.000Z",
			queries: ["stateful fuzzing"],
			filters: {},
			providers: ["crossref"],
			pagesPerProvider: 1,
			maxResultsPerProvider: 10,
			results: [record],
			failures: [],
			sourceCounts: { crossref: 1 },
			deduplicatedCount: 0,
			scope: "personal",
			mode: "persistent",
			namespace: "alice",
		};
		expect(await personal.persistSearchRun(run)).toEqual({ created: 1, updated: 0, unchanged: 0 });
		expect(await personal.getSearchRun(run.id)).toMatchObject({ id: run.id, results: [expect.objectContaining({ id: record.id })] });
		expect((await personal.listSearchRuns()).map((item) => item.id)).toEqual([run.id]);
		expect((await personal.audit()).manifest.recordCount).toBe(1);
		await personal.annotatePaper(record.id, {
			author: "alice",
			tags: ["fuzzing", "stateful"],
			note: "Read the evaluation assumptions before inclusion.",
			screeningStatus: "maybe",
			readingStatus: "queued",
			readingNote: "Need full methods pass.",
		});
		const corpusHits = await personal.searchPapers({ query: "evaluation assumptions", tags: ["fuzzing"] });
		expect(corpusHits).toHaveLength(1);
		expect(corpusHits[0].matchedFields).toContain("user-notes");
		const exportPath = await personal.export("csv", "review.csv");
		expect(await readFile(exportPath, "utf8")).toContain("10.1000/example.1");
		const jsonPath = await personal.export("json", "review.json");
		expect(JSON.parse(await readFile(jsonPath, "utf8")).records).toHaveLength(1);
		expect(await personal.promoteTo(team, [record.id], "alice")).toEqual({ promoted: 1, missing: [] });
		expect((await team.listPapers()).map((item) => item.id)).toEqual([record.id]);
		expect((await team.getPaper(record.id))?.curation?.teamReview).toMatchObject({
			status: "team-proposed",
			proposedBy: "alice",
		});
		expect((await team.getPaper(record.id))?.curation?.userNotes).toEqual([]);
		expect((await team.getPaper(record.id))?.curation?.screening).toBeUndefined();
		await team.reviewTeamPaper(record.id, "team-approved", "bob", "Relevant and traceable");
		expect((await team.getPaper(record.id))?.curation?.teamReview).toMatchObject({
			status: "team-approved",
			reviewedBy: "bob",
		});
		await personal.promoteTo(team, [record.id], "alice");
		expect((await team.getPaper(record.id))?.curation?.teamReview).toMatchObject({
			status: "team-approved",
			reviewedBy: "bob",
		});

		const firstKey = derivedCacheKey({
			inputHashes: ["b", "a"],
			operation: "skim",
			pipelineVersion: "1",
			normalizedConfig: { pages: "all" },
		});
		const secondKey = derivedCacheKey({
			inputHashes: ["a", "b"],
			operation: "skim",
			pipelineVersion: "1",
			normalizedConfig: { pages: "all" },
		});
		expect(firstKey).toBe(secondKey);
		expect(
			await personal.putDerived({
				key: firstKey,
				paperId: record.id,
				operation: "skim",
				inputHashes: ["a", "b"],
				pipelineVersion: "1",
				normalizedConfig: { pages: "all" },
				createdAt: "2026-01-01T00:02:00.000Z",
				createdBy: "agent:test",
				result: { decision: "read" },
			}),
		).toBe("created");
		expect(await personal.listDerived({ paperId: record.id, operation: "skim" })).toHaveLength(1);
	});

	it("builds a paper material package from metadata, PDF versions, and artifact manifest", async () => {
		const record = paper({
			links: [
				{ url: "https://example.org/paper.pdf", kind: "pdf", openAccess: true },
				{ url: "https://github.com/example/artifact", kind: "artifact" },
			],
			discoveryPaths: [
				{
					kind: "keyword-search",
					provider: "crossref",
					query: "stateful fuzzing",
					discoveredAt: "2026-01-01T00:00:00.000Z",
				},
			],
			curation: {
				tags: [],
				userNotes: [],
				screening: {
					status: "include",
					reason: "matches scope",
					updatedBy: "alice",
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
				reading: {
					status: "skimmed",
					note: "abstract and method",
					updatedBy: "alice",
					updatedAt: "2026-01-03T00:00:00.000Z",
				},
			},
		});
		const version: PaperVersion = {
			paperId: record.id,
			sourceUrl: "https://example.org/paper.pdf",
			finalUrl: "https://cdn.example.org/paper.pdf",
			retrievedAt: "2026-01-04T00:00:00.000Z",
			sha256: "a".repeat(64),
			bytes: 1234,
			blobPath: "/corpus/blobs/aa/" + "a".repeat(64),
			contentType: "application/pdf",
			versionKind: "published",
			versionLabel: "official",
			isPreferred: true,
		};
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: "paper.pdf",
			pdfSha256: "b".repeat(64),
			discoveredAt: "2026-01-05T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-code",
					url: "https://github.com/example/artifact",
					kind: "repository",
					host: "github.com",
					confidence: "high",
					sources: [{ method: "pdftotext", page: 2, context: "Code is available" }],
				},
			],
			acquisitions: [
				{
					candidateId: "artifact-code",
					sourceUrl: "https://github.com/example/artifact",
					status: "cloned",
					localPath: "/workspace/artifacts/artifact-code",
					retrievedAt: "2026-01-06T00:00:00.000Z",
					commit: "c".repeat(40),
					remote: "https://github.com/example/artifact.git",
				},
			],
		};

		const materialPackage = buildPaperMaterialPackage(record, [version], [manifest]);

		expect(materialPackage.missing).toEqual([]);
		expect(materialPackage.tableRow).toMatchObject({
			paperId: record.id,
			version: expect.stringContaining("published"),
			pdf: expect.stringContaining("/corpus/blobs/aa/"),
			artifact: expect.stringContaining("commit=" + "c".repeat(40)),
			discoverySource: expect.stringContaining("keyword-search"),
			screeningStatus: "include: matches scope",
			readingStatus: "skimmed: abstract and method",
			updatedAt: "2026-01-06T00:00:00.000Z",
		});
	});

	it("serializes concurrent corpus updates without losing records", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-concurrent-corpus-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(root, "personal", "alice");
		const records = Array.from({ length: 8 }, (_value, index) => {
			const record = paper({
				title: `Concurrent Paper ${index}`,
				identifiers: { doi: `10.2000/concurrent.${index}` },
			});
			record.id = paperRecordId(record);
			return record;
		});

		await Promise.all(records.map((record) => store.upsertPaper(record)));
		expect((await store.listPapers()).map((record) => record.id).sort()).toEqual(
			records.map((record) => record.id).sort(),
		);
	});
});
