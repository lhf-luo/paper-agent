import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	enrichImportedPdfRecord,
	extractMetadataFromPdfText,
	preparePdfImport,
} from "../src/literature/application/literature-import-metadata.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { parseBibtex, parseJsonExport, registerLiteratureImportTool } from "../src/literature/presentation/literature-import-tools.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("literature corpus import", () => {
	it("extracts a multiline title, authors, year, venue, and official URL from PDF text", () => {
		const metadata = extractMetadataFromPdfText(
			[
				"ValScope: Value-Semantics-Aware Metamorphic",
				"Testing for Detecting Logical Bugs in DBMSs",
				"Li Lin, Liehang Chen, and Rongxin Wu, Xiamen University",
				"https://www.usenix.org/conference/osdi26/presentation/lin-li",
				"This paper is included in the Proceedings of the 20th USENIX",
				"Symposium on Operating Systems Design and Implementation.",
				"July 13-15, 2026 - Seattle, WA, USA",
				"Abstract",
			].join("\n"),
		);

		expect(metadata).toMatchObject({
			title: "ValScope: Value-Semantics-Aware Metamorphic Testing for Detecting Logical Bugs in DBMSs",
			authors: ["Li Lin", "Liehang Chen", "Rongxin Wu"],
			year: 2026,
			venue: "Proceedings of the 20th USENIX Symposium on Operating Systems Design and Implementation.",
		});
		expect(metadata.urls).toContain("https://www.usenix.org/conference/osdi26/presentation/lin-li");
	});

	it("cleans PDF affiliation markers and does not use a body year as the publication year", () => {
		const metadata = extractMetadataFromPdfText(
			[
				"F REE W ILL: Automatically Diagnosing Use-after-free Bugs via",
				"Reference Miscounting Detection on Binaries",
				"Liang He1∗           Hong Hu2∗        Purui Su1,3,4     Yan Cai3      Zhenkai Liang5",
				"1 Institute of Software, Chinese Academy of Sciences",
				"Abstract",
				"A mechanism introduced in 2006 remained in use through 2021.",
			].join("\n"),
			{ year: 2022 },
		);

		expect(metadata).toMatchObject({
			title:
				"F REE W ILL: Automatically Diagnosing Use-after-free Bugs via Reference Miscounting Detection on Binaries",
			authors: ["Liang He", "Hong Hu", "Purui Su", "Yan Cai", "Zhenkai Liang"],
			year: 2022,
		});
	});

	it("extracts a wrapped Chinese title and all Chinese authors", () => {
		const metadata = extractMetadataFromPdfText(
			[
				"软件学报 ISSN 1000-9825",
				"[doi: 10.13328/j.cnki.jos.007635]",
				"",
				"ToxiHeap: LLM 制导和毒性标记的 JavaScript 引擎模糊测试",
				"*",
				"框架",
				"沙乐天, 龙章伯, 丁加宇, 黄海平, 肖 甫",
				"摘要: 现有浏览器 JavaScript 引擎模糊测试工具仍存在局限。",
			].join("\n"),
		);

		expect(metadata).toMatchObject({
			title: "ToxiHeap: LLM 制导和毒性标记的 JavaScript 引擎模糊测试框架",
			authors: ["沙乐天", "龙章伯", "丁加宇", "黄海平", "肖甫"],
			doi: "10.13328/j.cnki.jos.007635",
		});
	});

	it("finds a text title when only embedded authors are usable", () => {
		const metadata = extractMetadataFromPdfText(
			"A Title Missing From Embedded Metadata\nAda Researcher and Bob Scientist\nAbstract\n",
			{ authors: ["Ada Researcher", "Bob Scientist"] },
		);

		expect(metadata.title).toBe("A Title Missing From Embedded Metadata");
		expect(metadata.authors).toEqual(["Ada Researcher", "Bob Scientist"]);
	});

	it("ignores publisher placeholders and scans PDF text for real metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-cnki-"));
		temporaryPaths.push(root);
		const path = join(root, "paper.pdf");
		await writeFile(path, "%PDF-1.7\nfixture", "utf8");
		const pi = {
			exec: vi.fn(async (command: string) => {
				if (command === "pdfinfo") {
					return { code: 0, stdout: "Author: CNKI\nPages: 27\n", stderr: "", killed: false };
				}
				if (command === "pdftotext") {
					return {
						code: 0,
						stdout: [
							"ToxiHeap: LLM 制导和毒性标记的 JavaScript 引擎模糊测试",
							"*",
							"框架",
							"沙乐天, 龙章伯, 丁加宇, 黄海平, 肖 甫",
							"摘要: 正文",
						].join("\n"),
						stderr: "",
						killed: false,
					};
				}
				throw new Error(`Unexpected command: ${command}`);
			}),
		} as unknown as ExtensionAPI;

		const result = await preparePdfImport(path, pi, process.cwd(), undefined, { enrich: false });

		expect(result.record).toMatchObject({
			title: "ToxiHeap: LLM 制导和毒性标记的 JavaScript 引擎模糊测试框架",
			authors: ["沙乐天", "龙章伯", "丁加宇", "黄海平", "肖甫"],
		});
		expect(pi.exec).not.toHaveBeenCalledWith("tesseract", expect.anything(), expect.anything());
	});

	it("pauses a PDF when title and authors remain unavailable instead of using its filename", async () => {
		const pi = {
			exec: vi.fn(async (command: string) =>
				command === "pdfinfo"
					? { code: 0, stdout: "Pages: 1\n", stderr: "", killed: false }
					: { code: 1, stdout: "", stderr: "tool unavailable", killed: false },
			),
		} as unknown as ExtensionAPI;
		const result = await preparePdfImport("misleading-filename.pdf", pi, process.cwd(), undefined, { enrich: false });

		expect(result.record).toBeUndefined();
		expect(result.needsMetadata).toMatchObject({
			reason: "needs_metadata",
			missingFields: ["title", "authors"],
		});
	});

	it("continues with text extraction when pdfinfo fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-pdfinfo-fallback-"));
		temporaryPaths.push(root);
		const path = join(root, "paper.pdf");
		await writeFile(path, "%PDF-1.7\nfixture", "utf8");
		const pi = {
			exec: vi.fn(async (command: string) => {
				if (command === "pdfinfo") throw new Error("pdfinfo unavailable");
				if (command === "pdftotext") {
					return {
						code: 0,
						stdout: "A Reliable Paper Title\nAda Researcher and Bob Scientist\nAbstract\n",
						stderr: "",
						killed: false,
					};
				}
				throw new Error(`Unexpected command: ${command}`);
			}),
		} as unknown as ExtensionAPI;

		const result = await preparePdfImport(path, pi, process.cwd(), undefined, { enrich: false });

		expect(result.record).toMatchObject({ title: "A Reliable Paper Title", authors: ["Ada Researcher", "Bob Scientist"] });
		expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "pdfinfo" })]));
	});

	it("uses an exact PDF DOI to recover required metadata when local extraction is incomplete", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-doi-recovery-"));
		temporaryPaths.push(root);
		const path = join(root, "paper.pdf");
		await writeFile(path, "%PDF-1.7\nfixture", "utf8");
		const pi = {
			exec: vi.fn(async (command: string) => {
				if (command === "pdfinfo") return { code: 0, stdout: "Pages: 1\n", stderr: "", killed: false };
				if (command === "pdftotext") {
					return { code: 0, stdout: "doi: 10.5555/exact.paper\n", stderr: "", killed: false };
				}
				return { code: 1, stdout: "", stderr: "OCR unavailable", killed: false };
			}),
		} as unknown as ExtensionAPI;
		const providerRecord = {
			id: "doi-record",
			title: "Metadata Recovered by DOI",
			authors: ["Ada Researcher", "Bob Scientist"],
			abstract: "Complete metadata",
			year: 2026,
			venue: "TestConf",
			publicationType: "journal-article",
			identifiers: { doi: "10.5555/exact.paper" },
			links: [{ url: "https://doi.org/10.5555/exact.paper", kind: "doi" as const, openAccess: true }],
			citationCount: 1,
			provenance: [{ provider: "crossref" as const, query: "10.5555/exact.paper", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		};
		const doiLookup = vi.fn(async () => providerRecord);
		const searcher = vi.fn(async (provider, request) => ({
			provider,
			query: request.query,
			records: [],
			requestUrl: "https://provider.example/search",
		}));

		const result = await preparePdfImport(path, pi, process.cwd(), undefined, { doiLookup, searcher });

		expect(result.record).toMatchObject({
			title: "Metadata Recovered by DOI",
			authors: ["Ada Researcher", "Bob Scientist"],
			identifiers: { doi: "10.5555/exact.paper" },
		});
		expect(result.metadataSource).toBe("doi");
		expect(doiLookup).toHaveBeenCalledWith("crossref", "10.5555/exact.paper", expect.any(Object));
	});

	it("keeps local title and authors when every configured provider fails", async () => {
		const local = {
			id: "material-local",
			title: "Reliable Local Metadata",
			authors: ["Ada Researcher"],
			identifiers: {},
			links: [],
			materialHashes: ["a".repeat(64)],
			provenance: [{ provider: "local-pdf" as const, query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		};
		const result = await enrichImportedPdfRecord(local, process.cwd(), undefined, async (provider) => {
			throw new Error(`${provider} unavailable`);
		});

		expect(result.record.title).toBe(local.title);
		expect(result.record.authors).toEqual(local.authors);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("only accepts strict provider matches and never replaces local title or authors", async () => {
		const local = {
			id: "material-local",
			title: "Reliable Local Metadata",
			authors: ["Li Lin"],
			identifiers: {},
			links: [],
			materialHashes: ["b".repeat(64)],
			provenance: [{ provider: "local-pdf" as const, query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		};
		const rejected = await enrichImportedPdfRecord(local, process.cwd(), undefined, async (provider, request) => ({
			provider,
			query: request.query,
			records: [
				{
					...local,
					id: "provider-wrong-author",
					authors: ["Li Zhang"],
					year: 2025,
					identifiers: { semanticScholarId: "wrong" },
				},
			],
			requestUrl: "https://provider.example/search",
		}));
		expect(rejected.record.year).toBeUndefined();
		expect(rejected.matchedProviders).toEqual([]);

		const accepted = await enrichImportedPdfRecord(local, process.cwd(), undefined, async (provider, request) => ({
			provider,
			query: request.query,
			records: [
				{
					...local,
					id: "provider-exact-author",
					title: "Reliable Local Metadata",
					authors: ["Li Lin"],
					year: 2026,
					venue: "TestConf",
					identifiers: { semanticScholarId: "exact" },
				},
			],
			requestUrl: "https://provider.example/search",
		}));
		expect(accepted.record).toMatchObject({
			title: local.title,
			authors: local.authors,
			year: 2026,
			venue: "TestConf",
		});
		expect(accepted.matchedProviders.length).toBeGreaterThan(0);
	});

	it("atomically stores a local PDF version and creates its requested collection", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-atomic-"));
		temporaryPaths.push(root);
		const body = new TextEncoder().encode("%PDF-1.7\nlocal fixture");
		const sha256 = createHash("sha256").update(body).digest("hex");
		const sourcePath = join(root, "paper.pdf");
		await writeFile(sourcePath, body);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const record = {
			id: `material-${sha256.slice(0, 20)}`,
			title: "Atomic Local Import",
			authors: ["Ada Researcher"],
			identifiers: {},
			links: [{ url: new URL(`file:///${sourcePath.replaceAll("\\", "/")}`).href, kind: "other" as const }],
			materialHashes: [sha256],
			provenance: [
				{ provider: "local-pdf" as const, query: "local-pdf-import", retrievedAt: "2026-01-01T00:00:00Z", rawUrl: sourcePath },
			],
			mergedFrom: [],
		};

		const result = await store.importLocalPapersAtomically([{ record, body, sourcePath }], {
			collectionName: "Compiler Testing",
			reportId: "import-atomic",
			report: { imported: 1 },
		});

		expect(result.collection?.name).toBe("Compiler Testing");
		expect((await store.getPaper(record.id))?.collectionIds).toEqual([result.collection?.id]);
		expect(await store.listPaperVersions(record.id)).toMatchObject([{ sha256, bytes: body.length }]);
		expect(JSON.parse(await readFile(join(store.root, "imports", "import-atomic.json"), "utf8"))).toEqual({ imported: 1 });
	});

	it("attaches a layout-spaced local PDF title to the existing clean catalog record", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-layout-spaced-title-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const cleanTitle =
			"FreeWill: Automatically Diagnosing Use-after-free Bugs via Reference Miscounting Detection on Binaries";
		await store.upsertPaper({
			id: "paper-freewill-catalog",
			title: cleanTitle,
			authors: ["Liang He", "Hong Hu", "Purui Su", "Yan Cai", "Zhenkai Liang"],
			year: 2022,
			identifiers: { semanticScholarId: "freewill-catalog" },
			links: [{ url: "https://www.semanticscholar.org/paper/freewill-catalog", kind: "landing" }],
			provenance: [
				{
					provider: "semanticscholar",
					query: "FreeWill",
					retrievedAt: "2026-01-01T00:00:00Z",
					providerRecordId: "freewill-catalog",
				},
			],
			mergedFrom: [],
		});
		const body = new TextEncoder().encode("%PDF-1.7\nlayout-spaced title fixture");
		const sha256 = createHash("sha256").update(body).digest("hex");
		const sourcePath = join(root, "freewill.pdf");
		await writeFile(sourcePath, body);
		const localRecord = {
			id: `material-${sha256.slice(0, 20)}`,
			title:
				"F REE W ILL: Automatically Diagnosing Use-after-free Bugs via Reference Miscounting Detection on Binaries",
			authors: ["Liang He", "Hong Hu", "Purui Su", "Yan Cai", "Zhenkai Liang"],
			year: 2022,
			identifiers: {},
			links: [{ url: new URL(`file:///${sourcePath.replaceAll("\\", "/")}`).href, kind: "other" as const }],
			materialHashes: [sha256],
			provenance: [{ provider: "local-pdf" as const, query: "local-pdf-import", retrievedAt: "2026-01-02T00:00:00Z" }],
			mergedFrom: [],
		};

		await store.importLocalPapersAtomically([{ record: localRecord, body, sourcePath }], {
			reportId: "layout-spaced-title",
			report: { imported: 1 },
		});

		const papers = await store.listPapers();
		expect(papers).toHaveLength(1);
		expect(papers[0].title).toBe(cleanTitle);
		expect(papers[0].identifiers.semanticScholarId).toBe("freewill-catalog");
		expect(await store.listPaperVersions(papers[0].id)).toMatchObject([{ sha256 }]);
	});

	it("rolls back an atomic import when confirmed PDF bytes do not match", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-rollback-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const record = {
			id: "material-mismatch",
			title: "Mismatched PDF",
			authors: ["Ada Researcher"],
			identifiers: {},
			links: [],
			materialHashes: ["a".repeat(64)],
			provenance: [{ provider: "local-pdf" as const, query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		};

		await expect(
			store.importLocalPapersAtomically(
				[{ record, body: new TextEncoder().encode("different"), sourcePath: join(root, "paper.pdf") }],
				{ collectionName: "Must Roll Back", reportId: "rollback", report: {} },
			),
		).rejects.toThrow("changed after confirmation");
		expect(await store.getPaper(record.id)).toBeUndefined();
		expect(await store.listCollections()).toEqual([]);
		await expect(stat(join(store.root, "imports", "rollback.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not merge similar titles without an exact identifier or PDF hash", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-no-fuzzy-merge-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "alice"), "personal", "alice");
		const base = {
			authors: ["Ada Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "local-pdf" as const, query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
			mergedFrom: [],
		};
		await store.upsertPaper({ ...base, id: "material-one", title: "Testing Compilers at Scale", materialHashes: ["1".repeat(64)] });

		await store.importLocalPapersAtomically(
			[{ record: { ...base, id: "material-two", title: "Testing Compiler at Scale", materialHashes: ["2".repeat(64)] } }],
			{ reportId: "no-fuzzy", report: { imported: 1 } },
		);

		expect(await store.listPapers()).toHaveLength(2);
	});

	it("imports valid BibTeX entries and records incomplete entries as rejections", () => {
		const result = parseBibtex(
			[
				"@inproceedings{good2025,",
				"  title = {Stateful Fuzzing at Scale},",
				"  author = {Ada Example and Bob Researcher},",
				"  year = {2025},",
				"  doi = {10.5555/IMPORT.TEST},",
				"  booktitle = {TestConf}",
				"}",
				"@article{bad2024,",
				"  year = {2024}",
				"}",
			].join("\n"),
			"library.bib",
		);

		expect(result.accepted).toHaveLength(1);
		expect(result.accepted[0]).toMatchObject({
			title: "Stateful Fuzzing at Scale",
			authors: ["Ada Example", "Bob Researcher"],
			year: 2025,
			identifiers: { doi: "10.5555/import.test" },
		});
		expect(result.rejected).toMatchObject([{ source: "library.bib#bad2024", reason: "missing_required_field" }]);
	});

	it("imports paper-agent JSON while preserving source provenance and curation", () => {
		const result = parseJsonExport(
			{
				records: [
					{
						id: "old-id",
						title: "Imported Paper",
						authors: ["Researcher One"],
						year: 2024,
						identifiers: { doi: "https://doi.org/10.4444/IMPORTED" },
						links: [],
						provenance: [],
						mergedFrom: [],
						curation: { tags: ["imported"], userNotes: [] },
						untrustedExtraField: "must not be persisted",
					},
				],
			},
			"library.json",
		);

		expect(result.rejected).toEqual([]);
		expect(result.accepted[0]).toMatchObject({
			title: "Imported Paper",
			identifiers: { doi: "10.4444/imported" },
			curation: { tags: ["imported"] },
		});
		expect(result.accepted[0].provenance.at(-1)).toMatchObject({ provider: "json-import" });
		expect(result.accepted[0]).not.toHaveProperty("untrustedExtraField");
	});

	it("rejects malformed nested fields while importing valid records from the same batch", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-"));
		temporaryPaths.push(root);
		const inputPath = join(root, "library.json");
		await writeFile(
			inputPath,
			JSON.stringify({
				records: [
					{
						title: "Valid record",
						authors: ["Ada Example"],
						identifiers: { doi: "10.5555/import-write" },
						links: [],
						provenance: [],
						mergedFrom: [],
						curation: { tags: [], userNotes: [] },
					},
					{
						title: "Valid record",
						authors: ["Ada Example"],
						identifiers: { doi: "10.5555/import-write" },
						links: [],
						provenance: [],
						mergedFrom: [],
						curation: { tags: [], userNotes: null },
					},
					{
						title: "Malformed links",
						authors: ["Ada Example"],
						links: [{ kind: "pdf", url: 42 }],
					},
					{
						title: "Malformed review",
						authors: ["Ada Example"],
						curation: { tags: [], userNotes: [], teamReview: { status: "team-approved", reviewedBy: 42 } },
					},
					{
						title: " ",
						authors: [],
					},
				],
			}),
			"utf8",
		);

		let importTool: any;
		registerLiteratureImportTool({
			registerTool(tool: unknown) {
				importTool = tool;
			},
		} as unknown as ExtensionAPI);
		const result = await importTool.execute(
			"import-test",
			{ input_path: inputPath, namespace: "alice", corpus_root: join(root, "corpus") },
			undefined,
			undefined,
			{ cwd: root, hasUI: true, ui: { confirm: vi.fn(async () => true) } },
		);

		expect(result.details).toMatchObject({
			parsed: 1,
			imported: 1,
			counts: { created: 1, updated: 0, unchanged: 0 },
		});
		expect(result.details.rejected).toHaveLength(4);
		expect(result.details.rejected).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "parse_error", detail: expect.stringContaining("curation") }),
				expect.objectContaining({ reason: "parse_error", detail: expect.stringContaining("links") }),
			]),
		);
		const rejectionLog = JSON.parse(await readFile(result.details.rejectionPath, "utf8"));
		expect(rejectionLog).toMatchObject({ parsed: 1, imported: 1 });
		expect(rejectionLog.rejected).toHaveLength(4);
	});

	it("auto-authorizes non-interactive imports under the default Agent policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-import-consent-"));
		temporaryPaths.push(root);
		const inputPath = join(root, "library.bib");
		const corpusRoot = join(root, "blocked-corpus");
		await writeFile(inputPath, "@article{paper, title={Consent Gate}, author={Ada Example}, year={2026}}\n", "utf8");
		let importTool: any;
		registerLiteratureImportTool({
			registerTool(tool: unknown) {
				importTool = tool;
			},
		} as unknown as ExtensionAPI);

		const result = await importTool.execute(
			"import-automatic",
			{ input_path: inputPath, namespace: "alice", corpus_root: corpusRoot },
			undefined,
			undefined,
			{ cwd: root, hasUI: false, ui: { confirm: vi.fn() } },
		);
		expect(result.details).toMatchObject({ imported: 1, counts: { created: 1 } });
		await expect(stat(corpusRoot)).resolves.toBeDefined();
	});
});
