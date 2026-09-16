import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivedCacheKey, LiteratureStore } from "../src/literature/application/literature-store.ts";
import {
	deduplicatePaperRecords,
	findPossibleDuplicates,
	mergePaperRecords,
	normalizeArxivId,
	normalizeDoi,
	normalizeTitle,
	paperPrimaryUrl,
	paperRecordId,
	sameLocalPdfMetadataIdentity,
	titleSimilarity,
	withCanonicalPaperLinks,
} from "../src/literature/domain/literature-identifiers.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";

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
		second.id = "incoming-provider-id";
		const merged = deduplicatePaperRecords([first, second]);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe(first.id);
		expect(merged[0].mergedFrom).toContain(second.id);
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
		expect(versionMerged).toHaveLength(1);
		expect(versionMerged[0].identifiers).toMatchObject({
			doi: "10.1000/example.1",
			arxivId: "2501.01234",
		});

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
		expect(deduplicatePaperRecords([metadataOnlyOne, metadataOnlyTwo])).toHaveLength(1);

		const possible = paper({
			title: "A Study of Stateful Protocol Fuzzing",
			identifiers: { doi: "10.1000/example.2" },
		});
		possible.id = paperRecordId(possible);
		expect(findPossibleDuplicates([first, possible])).toMatchObject([
			{ leftId: first.id, rightId: possible.id, reason: "similar-title" },
		]);
	});

	it("merges exact normalized titles and first authors without using year", () => {
		const catalog = paper({
			title: "KernelGPT: Enhanced Kernel Fuzzing via Large Language Models",
			authors: ["Chenyuan Yang", "Zijie Zhao"],
			year: 2024,
			identifiers: { doi: "10.1000/kernelgpt" },
			links: [{ url: "https://doi.org/10.1000/kernelgpt", kind: "doi" }],
		});
		const preprint = paper({
			title: "kernelgpt — enhanced kernel fuzzing via large-language models",
			authors: ["Yang, Chenyuan", "Zhao, Zijie"],
			year: 2023,
			identifiers: { arxivId: "2401.00563" },
			links: [{ url: "https://arxiv.org/abs/2401.00563", kind: "landing" }],
			provenance: [{ provider: "arxiv", query: "kernel fuzzing", retrievedAt: "2026-01-02T00:00:00Z" }],
		});

		const [merged] = deduplicatePaperRecords([catalog, preprint]);
		expect(deduplicatePaperRecords([catalog, preprint])).toHaveLength(1);
		expect(merged.identifiers).toMatchObject({ doi: "10.1000/kernelgpt", arxivId: "2401.00563" });
		expect(merged.provenance).toHaveLength(2);
	});

	it("does not infer abbreviated or missing first-author identities", () => {
		const fullName = paper({ identifiers: {}, links: [], authors: ["Chenyuan Yang"] });
		const initial = paper({ identifiers: {}, links: [], authors: ["C. Yang"] });
		const different = paper({ identifiers: {}, links: [], authors: ["Zijie Zhao"] });
		const missing = paper({ identifiers: {}, links: [], authors: [] });

		expect(deduplicatePaperRecords([fullName, initial, different, missing])).toHaveLength(4);
	});

	it("keeps exact metadata matches with conflicting primary identifiers for review", () => {
		const first = paper({
			identifiers: { doi: "10.1000/conflict-one", arxivId: "2501.00001" },
			links: [{ url: "https://doi.org/10.1000/conflict-one", kind: "doi" }],
		});
		const conflictingDoi = paper({
			year: 2027,
			identifiers: { doi: "10.1000/conflict-two", arxivId: "2501.00001" },
			links: [{ url: "https://doi.org/10.1000/conflict-two", kind: "doi" }],
		});
		const conflictingArxiv = paper({
			year: 2023,
			identifiers: { doi: "10.1000/conflict-one", arxivId: "2501.00002" },
			links: [{ url: "https://arxiv.org/abs/2501.00002", kind: "landing" }],
		});

		const deduplicated = deduplicatePaperRecords([first, conflictingDoi, conflictingArxiv]);
		expect(deduplicated).toHaveLength(1);

		const doiOnlyOne = { ...first, identifiers: { doi: "10.1000/conflict-one" } };
		const doiOnlyTwo = { ...conflictingDoi, identifiers: { doi: "10.1000/conflict-two" } };
		const arxivOnlyOne = { ...first, identifiers: { arxivId: "2501.00001" } };
		const arxivOnlyTwo = { ...conflictingArxiv, identifiers: { arxivId: "2501.00002" } };
		arxivOnlyOne.id = "arxiv-conflict-one";
		arxivOnlyTwo.id = "arxiv-conflict-two";
		expect(deduplicatePaperRecords([doiOnlyOne, doiOnlyTwo])).toHaveLength(2);
		expect(findPossibleDuplicates([doiOnlyOne, doiOnlyTwo])).toEqual([
			{ leftId: doiOnlyOne.id, rightId: doiOnlyTwo.id, reason: "identity-conflict", titleSimilarity: 1 },
		]);
		expect(deduplicatePaperRecords([arxivOnlyOne, arxivOnlyTwo])).toHaveLength(2);
		expect(findPossibleDuplicates([arxivOnlyOne, arxivOnlyTwo])).toEqual([
			{
				leftId: arxivOnlyOne.id,
				rightId: arxivOnlyTwo.id,
				reason: "identity-conflict",
				titleSimilarity: 1,
			},
		]);
	});

	it("recognizes a PDF layout-spaced title without replacing the clean catalog title", () => {
		const catalog = paper({
			title: "FreeWill: Automatically Diagnosing Use-after-free Bugs via Reference Miscounting Detection on Binaries",
			authors: ["Liang He", "Hong Hu"],
			year: 2022,
			identifiers: { semanticScholarId: "freewill-catalog" },
			links: [{ url: "https://www.semanticscholar.org/paper/freewill-catalog", kind: "landing" }],
		});
		const localPdf = paper({
			title: "F REE W ILL: Automatically Diagnosing Use-after-free Bugs via Reference Miscounting Detection on Binaries",
			authors: ["Liang He", "Hong Hu"],
			year: 2022,
			identifiers: {},
			links: [{ url: "file:///tmp/freewill.pdf", kind: "other" }],
			provenance: [{ provider: "local-pdf", query: "import", retrievedAt: "2026-09-05T00:00:00Z" }],
		});

		expect(normalizeTitle(localPdf.title)).toBe(normalizeTitle(catalog.title));
		expect(sameLocalPdfMetadataIdentity(catalog, localPdf)).toBe(true);
		const merged = deduplicatePaperRecords([catalog, localPdf]);
		expect(merged).toHaveLength(1);
		expect(mergePaperRecords(catalog, localPdf).title).toBe(catalog.title);
		expect(
			sameLocalPdfMetadataIdentity(catalog, {
				...localPdf,
				authors: ["Different Author"],
			}),
		).toBe(false);
		expect(
			sameLocalPdfMetadataIdentity(catalog, {
				...localPdf,
				identifiers: { semanticScholarId: "different-paper" },
			}),
		).toBe(true);
	});

	it("treats an identical PDF URL as exact identity even when extracted metadata differs", () => {
		const providerLanding = "https://openalex.org/W123456789";
		const canonical = paper({
			identifiers: { doi: "https://doi.org/10.1000/Example.1" },
			links: [{ url: providerLanding, kind: "landing" }],
		});
		expect(paperPrimaryUrl(canonical)).toBe("https://doi.org/10.1000/example.1");
		expect(withCanonicalPaperLinks(canonical).links).toEqual([
			{ url: "https://doi.org/10.1000/example.1", kind: "doi" },
			{ url: providerLanding, kind: "landing" },
		]);

		const pdfUrl = "https://dl.acm.org/doi/pdf/10.1145/3180155.3180225";
		const catalogRecord = paper({
			title: "UFO",
			identifiers: { doi: "10.1145/3180155.3180225" },
			links: [{ url: pdfUrl, kind: "pdf", openAccess: true }],
		});
		const browserRecord = paper({
			title: "UFO: Predictive Concurrency Use-After-Free Detection",
			identifiers: { doi: "10.1145/3180155" },
			links: [{ url: pdfUrl, kind: "landing" }],
			provenance: [{ provider: "local-pdf", query: "browser-connector", retrievedAt: "2026-09-02T00:00:00Z" }],
		});

		const merged = deduplicatePaperRecords([catalogRecord, browserRecord]);
		expect(merged).toHaveLength(1);
		expect(merged[0].identifiers.doi).toBe("10.1145/3180155.3180225");
		expect(merged[0].title).toBe("UFO: Predictive Concurrency Use-After-Free Detection");

		const sameLandingPage = "https://example.org/conference";
		expect(
			deduplicatePaperRecords([
				paper({ identifiers: {}, links: [{ url: sameLandingPage, kind: "landing" }] }),
				paper({
					title: "A Different Paper",
					identifiers: {},
					links: [{ url: sameLandingPage, kind: "landing" }],
				}),
			]),
		).toHaveLength(2);
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
		expect((await personal.audit()).manifest.recordCount).toBe(1);
		await personal.annotatePaper(record.id, {
			author: "alice",
			tags: ["fuzzing", "stateful"],
			note: "Read the evaluation assumptions before inclusion.",
			screeningStatus: "maybe",
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
