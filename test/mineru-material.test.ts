import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMineruPackage } from "../src/extensions/mineru/application/mineru-package.ts";
import { readMineruMaterial } from "../src/extensions/mineru/application/mineru-reader.ts";
import { MineruService } from "../src/extensions/mineru/application/mineru-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord, PaperVersion } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MinerU material", () => {
	it("normalizes the full package and reads physical pages", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-mineru-package-"));
		temporaryPaths.push(root);
		const raw = join(root, "raw", "paper");
		const normalized = join(root, "normalized");
		await mkdir(join(raw, "images"), { recursive: true });
		await writeFile(
			join(raw, "fixture.md"),
			"# Method\n\nFirst page.\n\n## Results\n\nSecond page.\n\n<table><tr><td>Accuracy</td></tr></table>\n\n```ts\nrun()\n```",
		);
		await writeFile(
			join(raw, "paper_content_list.json"),
			JSON.stringify([
				{ type: "text", text: "Method", text_level: 1, page_idx: 0 },
				{ type: "text", text: "First page.", page_idx: 0 },
				{ type: "text", text: "Results", text_level: 2, page_idx: 1 },
				{
					type: "image",
					image_caption: ["Figure 1: Architecture"],
					image_footnote: ["Model flow"],
					img_path: "images/figure.png",
					page_idx: 1,
				},
				{
					type: "table",
					table_caption: ["Table 1: Accuracy"],
					table_footnote: ["Higher is better"],
					table_body: "<table><tr><td>Accuracy</td></tr></table>",
					img_path: "images/table.png",
					page_idx: 1,
				},
				{ type: "chart", chart_caption: ["Figure 2: Trend"], img_path: "images/chart.png", page_idx: 1 },
				{ type: "code", code_caption: ["Listing 1"], code_body: "```ts\nrun()\n```", page_idx: 1 },
				{ type: "text", text: "Second page.", page_idx: 1 },
			]),
		);
		await writeFile(join(raw, "images", "figure.png"), Buffer.from([1, 2, 3]));
		await writeFile(join(raw, "images", "table.png"), Buffer.from([1, 2, 3]));
		await writeFile(join(raw, "images", "chart.png"), Buffer.from([1, 2, 3]));
		await writeFile(join(raw, "479220d6_content_list_v2.json"), "[]");
		await writeFile(join(raw, "479220d6_model.json"), "{}");
		await writeFile(join(raw, "479220d6_origin.pdf"), "%PDF-1.7");
		await writeFile(join(raw, "layout.json"), "{}");
		const built = await normalizeMineruPackage({
			rawRoot: join(root, "raw"),
			normalizedRoot: normalized,
			sourceSha256: "a".repeat(64),
			modelVersion: "vlm",
			createdAt: "2026-09-07T00:00:00.000Z",
		});
		expect(built.manifest).toMatchObject({
			schemaVersion: 2,
			pageCount: 2,
			headings: [
				{ level: 1, text: "Method", page: 1 },
				{ level: 2, text: "Results", page: 2 },
			],
		});
		expect(built.manifest.assets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "figure-1-p2", caption: "Figure 1: Architecture", page: 2 }),
				expect.objectContaining({ id: "table-1-p2", caption: "Table 1: Accuracy", page: 2 }),
				expect.objectContaining({ id: "figure-2-p2", type: "chart", page: 2 }),
				expect.objectContaining({ id: "code-p2-1", type: "code", page: 2 }),
			]),
		);
		expect(built.manifest.statistics).toMatchObject({ tables: 1, figures: 1, charts: 1, codeBlocks: 1 });
		expect((await readdir(normalized)).sort()).toEqual([
			"content_list.json",
			"content_list_v2.json",
			"full.md",
			"images",
			"layout.json",
			"manifest.json",
		]);
		expect(built.manifest.files).not.toContain("479220d6_model.json");
		expect(built.manifest.files).not.toContain("479220d6_origin.pdf");
		const read = await readMineruMaterial(
			{
				id: "material-1",
				namespace: "default",
				paperId: "paper-1",
				paperVersionId: "version-1",
				sourceSha256: "a".repeat(64),
				relativePath: "mineru",
				path: normalized,
				engine: "mineru",
				modelVersion: "vlm",
				packageSha256: "b".repeat(64),
				contentSha256: built.contentSha256,
				pageCount: 2,
				fileCount: built.fileCount,
				bytes: built.bytes,
				createdAt: "2026-09-07T00:00:00.000Z",
				updatedAt: "2026-09-07T00:00:00.000Z",
			},
			{ mode: "pages", pages: [2] },
		);
		expect(read.text).toContain("[page 2] [image]");
		expect(read.text).toContain("Figure 1: Architecture");
		expect(read.text).toContain("<table><tr><td>Accuracy</td></tr></table>");
		expect(read.text).toContain("```ts\nrun()\n```");
		expect(read.text).toContain("Second page.");
		expect(read.text).not.toContain("First page.");
		expect(read.text).toContain("truncated: false");
		expect(read.text).toContain("next_cursor: none");

		const overview = await readMineruMaterial(read.material, { mode: "overview" });
		expect(overview.body).toContain("results-p2 | pp.2-2 | Results");
		expect(overview.body).not.toContain("First page.");
		const section = await readMineruMaterial(read.material, {
			mode: "sections",
			sectionIds: ["results-p2"],
		});
		expect(section.body).toContain("## Results");
		expect(section.body).not.toContain("First page.");
		const search = await readMineruMaterial(read.material, {
			mode: "search",
			queries: ["Accuracy", "run()"],
			contextBlocks: 0,
		});
		expect(search.body).toContain("<table><tr><td>Accuracy</td></tr></table>");
		expect(search.body).toContain("```ts\nrun()\n```");
		const assets = await readMineruMaterial(read.material, {
			mode: "assets",
			assetIds: ["figure-1-p2", "table-1-p2", "missing"],
		});
		expect(assets.assetResults).toHaveLength(2);
		expect(assets.body).toContain("Higher is better");
		expect(assets.unknownAssetIds).toEqual(["missing"]);

		await writeFile(
			join(normalized, "manifest.json"),
			JSON.stringify({
				...built.manifest,
				schemaVersion: 1,
				sections: undefined,
				statistics: undefined,
				assets: built.manifest.assets.map(({ type, path, caption, page }) => ({ type, path, caption, page })),
			}),
		);
		const legacy = await readMineruMaterial(read.material, { mode: "overview" });
		expect(legacy.body).toContain("legacy schema-v1 package");
		expect(legacy.body).toContain("figure-1-p2");
	});

	it("traverses full Markdown at block boundaries without gaps or overlap", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-mineru-cursor-"));
		temporaryPaths.push(root);
		const markdown = ["# Paper", "a".repeat(700), "b".repeat(700), "c".repeat(700)].join("\n\n");
		await writeFile(join(root, "full.md"), markdown);
		await writeFile(
			join(root, "content_list.json"),
			JSON.stringify([{ type: "text", text: "Paper", text_level: 1, page_idx: 0 }]),
		);
		await writeFile(
			join(root, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				engine: "mineru",
				sourceSha256: "a".repeat(64),
				modelVersion: "vlm",
				createdAt: "2026-09-07T00:00:00.000Z",
				pageCount: 1,
				headings: [],
				assets: [],
				files: ["full.md", "content_list.json", "manifest.json"],
			}),
		);
		const material = {
			id: "material-cursor",
			namespace: "default",
			paperId: "paper-cursor",
			paperVersionId: "version-1",
			sourceSha256: "a".repeat(64),
			relativePath: "mineru",
			path: root,
			engine: "mineru" as const,
			modelVersion: "vlm" as const,
			packageSha256: "b".repeat(64),
			contentSha256: createHash("sha256").update(markdown).digest("hex"),
			pageCount: 1,
			fileCount: 3,
			bytes: markdown.length,
			createdAt: "2026-09-07T00:00:00.000Z",
			updatedAt: "2026-09-07T00:00:00.000Z",
		};
		const chunks: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await readMineruMaterial(material, {
				mode: "markdown",
				cursor,
				maxCharacters: 1_000,
			});
			chunks.push(result.body);
			cursor = result.nextCursor;
		} while (cursor);
		expect(chunks.join("")).toBe(markdown);
	});

	it("stores only the current material row and cascades it with the paper", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-mineru-store-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const paper: PaperRecord = {
			id: "mineru-paper",
			title: "MinerU Test Paper",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "local-pdf", query: "test", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await store.upsertPaper(paper);
		const pdf = Buffer.from("%PDF-1.7\nfixture\n%%EOF\n", "latin1");
		const blob = await store.putBlob(pdf);
		const version: PaperVersion = {
			paperId: paper.id,
			sourceUrl: "file:///fixture.pdf",
			finalUrl: "file:///fixture.pdf",
			retrievedAt: new Date().toISOString(),
			sha256: blob.sha256,
			bytes: pdf.length,
			blobPath: blob.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		};
		await store.savePaperVersion(version);
		const materialPath = join(store.personalFilesRoot, paper.id, "mineru");
		await mkdir(materialPath, { recursive: true });
		const save = (modelVersion: "pipeline" | "vlm") =>
			store.savePdfMaterial({
				paperId: paper.id,
				sourceSha256: blob.sha256,
				relativePath: relative(store.personalDataRoot, materialPath),
				engine: "mineru",
				modelVersion,
				packageSha256: createHash("sha256").update(modelVersion).digest("hex"),
				contentSha256: createHash("sha256").update("content").digest("hex"),
				pageCount: 2,
				fileCount: 3,
				bytes: 100,
			});
		await save("pipeline");
		await save("vlm");
		expect(await store.getPdfMaterial(paper.id)).toMatchObject({ modelVersion: "vlm", paperId: paper.id });
		const database = new DatabaseSync(store.databasePath);
		try {
			expect(
				(database.prepare("SELECT count(*) AS count FROM pdf_materials").get() as { count: number }).count,
			).toBe(1);
			await store.deletePapers([paper.id]);
			expect(
				(database.prepare("SELECT count(*) AS count FROM pdf_materials").get() as { count: number }).count,
			).toBe(0);
		} finally {
			database.close();
		}
	});

	it("rejects material generated from a non-current preferred PDF", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-mineru-stale-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const paper: PaperRecord = {
			id: "stale-paper",
			title: "Stale material",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "local-pdf", query: "test", retrievedAt: "2026-09-07T00:00:00.000Z" }],
			mergedFrom: [],
		};
		await store.upsertPaper(paper);
		const firstBody = Buffer.from("%PDF-1.4\nfirst");
		const first = await store.putBlob(firstBody);
		await store.savePaperVersion({
			paperId: paper.id,
			sourceUrl: "file:///first.pdf",
			finalUrl: "file:///first.pdf",
			retrievedAt: "2026-09-07T00:00:00.000Z",
			sha256: first.sha256,
			bytes: firstBody.length,
			blobPath: first.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		});
		const materialPath = join(store.personalFilesRoot, paper.id, "mineru");
		await mkdir(materialPath, { recursive: true });
		await writeFile(join(materialPath, "full.md"), "# Paper");
		await writeFile(join(materialPath, "content_list.json"), "[]");
		await writeFile(join(materialPath, "manifest.json"), "{}");
		await store.savePdfMaterial({
			paperId: paper.id,
			sourceSha256: first.sha256,
			relativePath: relative(store.personalDataRoot, materialPath),
			engine: "mineru",
			modelVersion: "vlm",
			packageSha256: "a".repeat(64),
			contentSha256: "b".repeat(64),
			pageCount: 1,
			fileCount: 3,
			bytes: 100,
		});
		const secondBody = Buffer.from("%PDF-1.4\nsecond");
		const second = await store.putBlob(secondBody);
		await store.savePaperVersion({
			paperId: paper.id,
			sourceUrl: "file:///second.pdf",
			finalUrl: "file:///second.pdf",
			retrievedAt: "2026-09-08T00:00:00.000Z",
			sha256: second.sha256,
			bytes: secondBody.length,
			blobPath: second.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		});
		const service = new MineruService({
			projectRoot: root,
			defaultNamespace: "default",
			executor: {} as never,
			consent: {} as never,
			store: () => store,
		});
		await expect(service.read(paper.id, "default", { mode: "overview" })).rejects.toThrow(/stale/);
	});
});
