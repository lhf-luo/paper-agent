import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseSidebarResultMetadata,
	resolveSidebarSelection,
} from "../src/literature/application/literature-sidebar.ts";
import {
	editLiteratureSidebar,
	type SidebarEditOperation,
} from "../src/literature/application/literature-sidebar-editor.ts";
import { renderSidebarTable, type SidebarField } from "../src/literature/application/literature-sidebar-fields.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function paper(id: string, title: string, doi?: string): PaperRecord {
	return {
		id,
		title,
		authors: ["First Author", "Second Author"],
		year: 2025,
		venue: "NDSS",
		publicationType: "conference-paper",
		venueRank: "A",
		citationCount: 12,
		identifiers: doi ? { doi } : {},
		links: doi ? [{ url: `https://doi.org/${doi}`, kind: "doi" }] : [],
		provenance: [],
		mergedFrom: [],
	};
}

function run(id: string, results: PaperRecord[]): SearchRun {
	return {
		id,
		startedAt: "2026-09-05T00:00:00.000Z",
		completedAt: "2026-09-05T00:00:01.000Z",
		queries: ["exact title First Author"],
		filters: {},
		providers: ["openalex", "crossref"],
		pagesPerProvider: 1,
		maxResultsPerProvider: 5,
		results,
		failures: [],
		sourceCounts: { openalex: results.length },
		deduplicatedCount: results.length,
		scope: "personal",
		mode: "once",
		namespace: "default",
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-sidebar-edit-"));
	tempDirs.push(root);
	const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
	const resultsDir = join(root, ".paper-agent", "web-agent-memory", "results");
	await mkdir(resultsDir, { recursive: true });
	const filename = "session-1-list.md";
	const path = join(resultsDir, filename);
	const resultUrl = `/api/agent/results/${filename}`;
	const fields: SidebarField[] = ["title", "year_venue", "identifier", "focus"];
	const oldRow = {
		title: "Statically Discover Cross-Entry Use-After-Free Vulnerabilities in the Linux Kernel",
		paper_id: "paper-old",
		search_run_id: "run-old",
		namespace: "default",
		curated: "search",
		authors: "First Author, Second Author",
		year: "2025",
		venue: "NDSS",
		publication_type: "conference-paper",
		citationCount: 12,
		ccf: "A",
		identifier: "paper-old",
		focus: "UAF detection",
		relevance: "high",
		topic: "Linux kernel",
	};
	const content = `${renderSidebarTable(fields, [oldRow])}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify({ revision: 1, fields, rows: [oldRow] })} -->\n`;
	await writeFile(path, content, "utf8");
	await store.saveSearchRun(run("run-old", [paper("paper-old", oldRow.title)]));
	return { root, store, path, resultUrl, content };
}

describe("editLiteratureSidebar", () => {
	it("replaces a row from a persisted search result without changing the URL", async () => {
		const test = await fixture();
		const savedOriginal = paper(
			"paper-old",
			"Statically Discover Cross-Entry Use-After-Free Vulnerabilities in the Linux Kernel",
		);
		await test.store.upsertPapers([savedOriginal]);
		const replacement = paper(
			"paper-correct",
			"Statically Discover Complex Cross-Entry Use-After-Free Vulnerabilities in the Linux Kernel",
			"10.14722/ndss.2025.240559",
		);
		await test.store.saveSearchRun(run("run-doi", [replacement]));

		const result = await editLiteratureSidebar(
			test.store,
			test.root,
			test.resultUrl,
			1,
			[
				{
					action: "replace-from-search",
					targetPaperId: "paper-old",
					searchRunId: "run-doi",
					paperId: "paper-correct",
				},
			],
			"session-1",
		);

		expect(result).toMatchObject({
			resultUrl: test.resultUrl,
			revision: 2,
			rowCount: 1,
			changed: 1,
			addedPaperIds: ["paper-correct"],
			removedPaperIds: ["paper-old"],
			updatedPaperIds: [],
		});
		const updated = await readFile(test.path, "utf8");
		const metadata = parseSidebarResultMetadata(updated);
		expect(metadata.fields).toEqual(["title", "year_venue", "identifier", "focus"]);
		expect(metadata.rows?.[0]).toMatchObject({
			title: replacement.title,
			paper_id: "paper-correct",
			search_run_id: "run-doi",
			doi: "10.14722/ndss.2025.240559",
			focus: "UAF detection",
			relevance: "high",
			topic: "Linux kernel",
		});
		expect(updated).toContain("Statically Discover Complex Cross-Entry");
		expect(updated).toContain("doi:10.14722/ndss.2025.240559");

		const selection = await resolveSidebarSelection(test.store, test.root, test.resultUrl);
		expect(selection.records.map((entry) => entry.record.id)).toEqual(["paper-correct"]);
		expect((await test.store.getPaper("paper-old"))?.title).toBe(savedOriginal.title);
		expect(await test.store.getPaper("paper-correct")).toBeUndefined();
	});

	it("adds, removes, and reorders fields while preserving hidden annotation values", async () => {
		const test = await fixture();
		const first = await editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, [
			{
				action: "set-fields",
				fields: [
					"title",
					"authors",
					"year",
					"venue",
					"publication_type",
					"citation_count",
					"ccf",
					"focus",
					"relevance",
					"topic",
				],
			},
		]);
		expect(first).toMatchObject({ revision: 2, changed: 1 });
		let content = await readFile(test.path, "utf8");
		expect(content).toContain(
			"| title | authors | year | venue | publication_type | citation_count | ccf | focus | relevance | topic |",
		);
		expect(content).toContain("| Statically Discover Cross-Entry");
		expect(content).toContain("| First Author, Second Author | 2025 | NDSS |");

		await editLiteratureSidebar(test.store, test.root, test.resultUrl, 2, [
			{ action: "set-fields", fields: ["title", "year"] },
		]);
		const third = await editLiteratureSidebar(test.store, test.root, test.resultUrl, 3, [
			{ action: "set-fields", fields: ["title", "topic", "focus", "relevance"] },
		]);
		expect(third).toMatchObject({ revision: 4, changed: 1 });
		content = await readFile(test.path, "utf8");
		expect(content).toContain("| title | topic | focus | relevance |");
		expect(content).toContain("| Linux kernel | UAF detection | high |");
	});

	it("supports adding, patching, and removing rows in one atomic edit", async () => {
		const test = await fixture();
		await test.store.saveSearchRun(run("run-new", [paper("paper-new", "A New Search Paper", "10.1/new")]));
		const operations: SidebarEditOperation[] = [
			{ action: "patch", targetPaperId: "paper-old", focus: "updated", relevance: "medium" },
			{ action: "add-from-search", searchRunId: "run-new", paperId: "paper-new", focus: "new" },
			{ action: "add-model-supplement", title: "Memory-only Paper", focus: "lead" },
			{ action: "remove", targetPaperId: "paper-old" },
		];

		const result = await editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, operations);

		expect(result).toMatchObject({
			revision: 2,
			rowCount: 2,
			changed: 4,
			addedPaperIds: ["paper-new"],
			removedPaperIds: ["paper-old"],
		});
		const metadata = parseSidebarResultMetadata(await readFile(test.path, "utf8"));
		expect(metadata.rows).toEqual([
			expect.objectContaining({ paper_id: "paper-new", search_run_id: "run-new", focus: "new" }),
			expect.objectContaining({ title: "Memory-only Paper", curated: "llm", focus: "lead" }),
		]);
	});

	it("treats duplicate additions as a warning without advancing the revision", async () => {
		const test = await fixture();
		const result = await editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, [
			{ action: "add-from-search", searchRunId: "run-old", paperId: "paper-old" },
		]);

		expect(result).toMatchObject({ revision: 1, rowCount: 1, changed: 0 });
		expect(result.warnings[0]).toContain("Skipped duplicate");
		expect(await readFile(test.path, "utf8")).toBe(test.content);
	});

	it("rejects stale revisions, another session, and legacy documents", async () => {
		const test = await fixture();
		await expect(
			editLiteratureSidebar(test.store, test.root, test.resultUrl, 2, [
				{ action: "remove", targetPaperId: "paper-old" },
			]),
		).rejects.toThrow("revision conflict");
		await expect(
			editLiteratureSidebar(
				test.store,
				test.root,
				test.resultUrl,
				1,
				[{ action: "remove", targetPaperId: "paper-old" }],
				"another-session",
			),
		).rejects.toThrow("does not belong to the current session");

		await writeFile(
			test.path,
			'| title | focus |\n| --- | --- |\n| Legacy | old |\n<!-- paper-agent-sidebar-meta {"revision":1,"rows":[{"title":"Legacy"}]} -->\n',
			"utf8",
		);
		await expect(
			editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, [{ action: "set-fields", fields: ["title"] }]),
		).rejects.toThrow("unsupported legacy column format");
	});

	it("leaves the original file untouched when any operation fails", async () => {
		const test = await fixture();
		await test.store.saveSearchRun(run("run-new", [paper("paper-new", "A New Search Paper")]));
		await expect(
			editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, [
				{ action: "add-from-search", searchRunId: "run-new", paperId: "paper-new" },
				{ action: "remove", targetPaperId: "missing" },
			]),
		).rejects.toThrow("was not found");
		expect(await readFile(test.path, "utf8")).toBe(test.content);
	});

	it("uses an exact normalized title fallback and rejects ambiguous matches", async () => {
		const test = await fixture();
		await editLiteratureSidebar(test.store, test.root, test.resultUrl, 1, [
			{
				action: "patch",
				targetTitle: "Statically Discover Cross Entry Use After Free Vulnerabilities in the Linux Kernel",
				focus: "matched by title",
			},
		]);
		const onceEdited = await readFile(test.path, "utf8");
		expect(parseSidebarResultMetadata(onceEdited).rows?.[0]?.focus).toBe("matched by title");

		const metadata = parseSidebarResultMetadata(onceEdited);
		const duplicatedRows = [
			...(metadata.rows ?? []),
			{ ...(metadata.rows?.[0] ?? {}), paper_id: "paper-duplicate", focus: "duplicate" },
		];
		await writeFile(
			test.path,
			`${renderSidebarTable(metadata.fields ?? ["title"], duplicatedRows)}\n<!-- paper-agent-sidebar-meta ${JSON.stringify({ revision: 2, fields: metadata.fields, rows: duplicatedRows })} -->\n`,
			"utf8",
		);
		await expect(
			editLiteratureSidebar(test.store, test.root, test.resultUrl, 2, [
				{
					action: "remove",
					targetTitle: "Statically Discover Cross Entry Use After Free Vulnerabilities in the Linux Kernel",
				},
			]),
		).rejects.toThrow("matched more than one row");
	});
});
