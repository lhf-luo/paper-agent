import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { DEFAULT_PAPER_DETAIL_FIELDS, updatePaperDetailFields } from "../src/literature/domain/paper-detail-fields.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-export-"));
	roots.push(root);
	return root;
}

const savedAt = "2026-10-07T02:03:04.000Z";
const fixedFields = (value = "") =>
	DEFAULT_PAPER_DETAIL_FIELDS.map(({ id, label }, index) => ({
		id,
		label,
		type: "multiline" as const,
		value: index === 0 ? value : "",
	}));
const paper = (id: string): PaperRecord => ({
	id,
	title: id,
	authors: ["Researcher"],
	identifiers: {},
	links: [],
	provenance: [],
	mergedFrom: [],
});
const curatedPaper = (value: string): PaperRecord => ({
	...paper("paper-filled"),
	curation: {
		tags: [],
		userNotes: [],
		detailFields: updatePaperDetailFields(
			undefined,
			[
				...fixedFields(value),
				{ id: "custom-one", label: "不导出的自定义字段", type: "text", value: "private custom content" },
			],
			savedAt,
		),
	},
});

describe("literature research field exports", () => {
	it("appends fixed CSV columns, preserves multiline quoting, and leaves legacy fields empty", async () => {
		const store = new LiteratureStore(join(await temporaryRoot(), "corpus"), "personal");
		const record = curatedPaper('中文, "quoted"\r\n第二行\n第三行');
		await store.upsertPapers([record, paper("paper-legacy")]);
		const bytes = await readFile(await store.export("csv", "fields.csv"));
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const header = [
			"id",
			"title",
			"authors",
			"year",
			"venue",
			"doi",
			"arxiv_id",
			"url",
			"sources",
			...DEFAULT_PAPER_DETAIL_FIELDS.map((field) => field.label),
			"最后一次修改时间",
		].join(",");
		const filledRow = [
			"paper-filled",
			"paper-filled",
			"Researcher",
			...Array<string>(6).fill(""),
			'"中文, ""quoted""\r\n第二行\n第三行"',
			...Array<string>(7).fill(""),
			savedAt,
		].join(",");
		const emptyRow = ["paper-legacy", "paper-legacy", "Researcher", ...Array<string>(15).fill("")].join(",");
		expect(bytes.toString("utf8")).toBe(`\uFEFF${header}\n${filledRow}\n${emptyRow}\n`);
		expect(bytes.toString("utf8")).not.toContain("private custom content");
	});

	it("renders every fixed Markdown field per paper without truncating long saved content", async () => {
		const store = new LiteratureStore(join(await temporaryRoot(), "corpus"), "personal");
		const longText = `第一段\n\n${"完整研究内容".repeat(1500)}\n最后一段`;
		const record = curatedPaper(longText);
		const other = curatedPaper("另一篇论文的问题");
		other.id = "paper-other";
		other.title = "paper-other";
		await store.upsertPapers([record, other, paper("paper-legacy")]);
		const markdown = await readFile(await store.export("markdown", "fields.md"), "utf8");
		const sections = markdown.split(/^## /m).slice(1);
		expect(sections).toHaveLength(3);
		for (const section of sections) {
			expect(section).toContain("### 阅读与研究记录");
			for (const field of DEFAULT_PAPER_DETAIL_FIELDS) expect(section).toContain(`#### ${field.label}\n`);
		}
		const filledSection = sections.find((section) => section.startsWith("paper-filled\n"));
		const otherSection = sections.find((section) => section.startsWith("paper-other\n"));
		const legacySection = sections.find((section) => section.startsWith("paper-legacy\n"));
		expect(filledSection).toContain(longText);
		expect(filledSection).toContain(`最后一次修改时间：${savedAt}`);
		expect(filledSection).not.toContain("另一篇论文的问题");
		expect(otherSection).toContain("另一篇论文的问题");
		expect(otherSection).not.toContain(longText);
		expect(legacySection).toContain("#### 研究问题\n\n未填写\n");
		expect(legacySection).toContain("最后一次修改时间：尚未保存");
		expect(markdown).not.toContain("private custom content");
		expect(markdown).not.toContain("不导出的自定义字段");
	});

	it("keeps JSON complete and BibTeX limited to citation metadata", async () => {
		const store = new LiteratureStore(join(await temporaryRoot(), "corpus"), "personal");
		const record = curatedPaper("已经保存的研究问题");
		await store.upsertPaper(record);
		const json = JSON.parse(await readFile(await store.export("json", "fields.json"), "utf8"));
		expect(json.schemaVersion).toBe(1);
		expect(json.records[0].curation.detailFields).toEqual(record.curation?.detailFields);
		const bibtex = await readFile(await store.export("bibtex", "fields.bib"), "utf8");
		expect(bibtex).toContain("title = {paper-filled}");
		expect(bibtex).not.toContain("已经保存的研究问题");
		expect(bibtex).not.toContain("private custom content");
	});

	it("exports persisted fields through HTTP and rejects a confirmation after the card changes", async () => {
		const root = await temporaryRoot();
		const staticRoot = join(root, "web");
		await mkdir(staticRoot);
		await writeFile(join(staticRoot, "index.html"), "<html></html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		await application.personalStore().upsertPaper(curatedPaper("保存前的问题"));
		const server = await startLocalWebServer(application, { staticRoot });
		const post = (path: string, body: unknown) =>
			fetch(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const input = { paperIds: ["paper-filled"], format: "csv", filename: "saved.csv" };
		try {
			const previewResponse = await post("/api/library/export/prepare", input);
			expect(previewResponse.status).toBe(200);
			const preview = await previewResponse.json();
			const oldGrant = await (await post("/api/operations/confirm", preview)).json();
			const unsavedDraft = fixedFields("尚未保存的草稿");
			const unchanged = await readFile(await application.personalStore().export("markdown", "before.md"), "utf8");
			expect(unchanged).toContain("保存前的问题");
			expect(unchanged).not.toContain(unsavedDraft[0].value);
			const change = await application.preparePersonalPaperDetailFields({
				paperId: "paper-filled",
				expectedRevision: 1,
				fields: fixedFields("保存后的问题"),
			});
			if (!change.prepared) throw new Error("Missing card preparation");
			const saveGrant = await application.confirmOperation(
				change.prepared.operationId,
				change.prepared.manifestFingerprint,
			);
			await application.savePersonalPaperDetailFields({ paperId: "paper-filled" }, saveGrant);
			const staleResponse = await post("/api/library/export/execute", { ...input, grant: oldGrant });
			expect(staleResponse.ok).toBe(false);
			expect(await staleResponse.json()).toMatchObject({ error: expect.stringContaining("manifest") });
			await expect(stat(join(application.personalStore().root, "exports", input.filename))).rejects.toMatchObject({
				code: "ENOENT",
			});
			const refreshed = await (await post("/api/library/export/prepare", input)).json();
			const newGrant = await (await post("/api/operations/confirm", refreshed)).json();
			const result = await post("/api/library/export/execute", { ...input, grant: newGrant });
			expect(result.status).toBe(200);
			const downloaded = await fetch(`${server.url}/api/library/exports/saved.csv`);
			expect(downloaded.status).toBe(200);
			const bytes = Buffer.from(await downloaded.arrayBuffer());
			expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			expect(bytes.toString("utf8")).toContain("保存后的问题");
			expect(bytes.toString("utf8")).not.toContain("保存前的问题");
			expect(bytes.toString("utf8")).not.toContain(unsavedDraft[0].value);
		} finally {
			await server.close();
			await application.close();
		}
	});
});
