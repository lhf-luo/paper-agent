import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBibtex, parseJsonExport, registerLiteratureImportTool } from "../src/literature-import.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("literature corpus import", () => {
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

	it("refuses non-interactive imports before creating a corpus", async () => {
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

		await expect(
			importTool.execute(
				"import-blocked",
				{ input_path: inputPath, namespace: "alice", corpus_root: corpusRoot },
				undefined,
				undefined,
				{ cwd: root, hasUI: false, ui: { confirm: vi.fn() } },
			),
		).rejects.toThrow("interactive confirmation");
		await expect(stat(corpusRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
