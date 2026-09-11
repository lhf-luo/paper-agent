import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMineruPackage } from "../src/extensions/mineru/application/mineru-package.ts";
import { readMineruMaterial } from "../src/extensions/mineru/application/mineru-reader.ts";
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
		await writeFile(join(raw, "fixture.md"), "# Method\n\nFirst page.\n\nSecond page.");
		await writeFile(
			join(raw, "paper_content_list.json"),
			JSON.stringify([
				{ type: "text", text: "Method", text_level: 1, page_idx: 0 },
				{ type: "text", text: "First page.", page_idx: 0 },
				{ type: "image", caption: ["Architecture"], img_path: "images/figure.png", page_idx: 1 },
				{ type: "text", text: "Second page.", page_idx: 1 },
			]),
		);
		await writeFile(join(raw, "images", "figure.png"), Buffer.from([1, 2, 3]));
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
			pageCount: 2,
			headings: [{ level: 1, text: "Method", page: 1 }],
			assets: [{ type: "image", path: "images/figure.png", caption: "Architecture", page: 2 }],
		});
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
		expect(read.text).toContain("[page 2] Architecture");
		expect(read.text).toContain("Second page.");
		expect(read.text).not.toContain("First page.");
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
});
