import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { mergePaperRecords } from "../src/literature/domain/literature-identifiers.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import {
	DEFAULT_PAPER_DETAIL_FIELDS,
	mergePaperDetailFields,
	updatePaperDetailFields,
	validatePaperDetailFields,
} from "../src/literature/domain/paper-detail-fields.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const defaults = () =>
	DEFAULT_PAPER_DETAIL_FIELDS.map(({ id, label }) => ({ id, label, type: "multiline" as const, value: "" }));
const paper = (id: string): PaperRecord => ({
	id,
	title: "A study of kernels",
	authors: ["Researcher"],
	identifiers: { doi: "10.1000/kernel" },
	links: [],
	provenance: [],
	mergedFrom: [],
});

describe("personal paper research fields", () => {
	it("validates defaults, custom names, dates and limits", () => {
		expect(validatePaperDetailFields(defaults())).toHaveLength(10);
		expect(() =>
			validatePaperDetailFields([...defaults(), { id: "custom-one", label: "研究问题", type: "text", value: "x" }]),
		).toThrow(/name/i);
		expect(() =>
			validatePaperDetailFields([
				...defaults(),
				{ id: "custom-one", label: "日期", type: "date", value: "2026-02-30" },
			]),
		).toThrow(/date/i);
		expect(() =>
			validatePaperDetailFields([
				...defaults(),
				{ id: "custom-one", label: "超长", type: "text", value: "x".repeat(20_001) },
			]),
		).toThrow(/long/i);
		expect(() => validatePaperDetailFields(defaults().reverse())).toThrow(/order/i);
	});

	it("saves through consent, rejects stale drafts, and keeps metadata read-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-fields-"));
		roots.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			await application.personalStore().upsertPaper(paper("paper-one"));
			await application.personalStore("other").upsertPaper({ ...paper("paper-one"), identifiers: {} });
			const fields = defaults();
			fields[0].value = "How can we detect defects?";
			const custom = [
				{ id: "custom-one", label: "复核日期", type: "date" as const, value: "2026-09-29" },
				{ id: "custom-two", label: "一句总结", type: "text" as const, value: "Useful" },
				{ id: "custom-three", label: "实验日志", type: "multiline" as const, value: "First line\nSecond line" },
			];
			const prepared = await application.preparePersonalPaperDetailFields({
				paperId: "paper-one",
				expectedRevision: 0,
				fields: [...fields, ...custom],
			});
			expect(prepared.status).toBe("ready");
			if (!prepared.prepared) throw new Error("Missing preparation");
			const grant = await application.confirmOperation(
				prepared.prepared.operationId,
				prepared.prepared.manifestFingerprint,
			);
			const saved = await application.savePersonalPaperDetailFields({ paperId: "paper-one" }, grant);
			expect(saved.revision).toBe(1);
			expect(saved.paper.title).toBe("A study of kernels");
			expect(saved.paper.curation?.detailFields?.entries.find((field) => field.id === "custom-one")?.value).toBe(
				"2026-09-29",
			);
			expect(
				(await application.personalStore("other").getPaper("paper-one"))?.curation?.detailFields,
			).toBeUndefined();
			await expect(
				application.preparePersonalPaperDetailFields({ paperId: "paper-one", expectedRevision: 0, fields }),
			).rejects.toThrow(/changed/i);
			const removal = await application.preparePersonalPaperDetailFields({
				paperId: "paper-one",
				expectedRevision: 1,
				fields: [...fields, { ...custom[1], label: "简短总结" }],
			});
			if (!removal.prepared) throw new Error("Missing removal preparation");
			const removalGrant = await application.confirmOperation(
				removal.prepared.operationId,
				removal.prepared.manifestFingerprint,
			);
			const removed = await application.savePersonalPaperDetailFields({ paperId: "paper-one" }, removalGrant);
			expect(removed.paper.curation?.detailFields?.entries.find((field) => field.id === "custom-two")?.label).toBe(
				"简短总结",
			);
			expect(
				removed.paper.curation?.detailFields?.entries.find((field) => field.id === "custom-one")?.deletedAt,
			).toBeTruthy();
			expect(
				removed.paper.curation?.detailFields?.entries.find((field) => field.id === "custom-three")?.deletedAt,
			).toBeTruthy();
			const refreshed = { ...removed.paper, year: 2026 };
			await application.personalStore().replacePaperMetadata(refreshed);
			expect((await application.personalStore().getPaper("paper-one"))?.curation?.detailFields?.revision).toBe(2);
		} finally {
			await application.close();
		}
	});

	it("keeps deletions through a paper merge", () => {
		const now = "2026-09-29T00:00:00.000Z";
		const older = updatePaperDetailFields(
			undefined,
			[...defaults(), { id: "custom-one", label: "旧字段", type: "text", value: "old" }],
			"2026-09-28T00:00:00.000Z",
		);
		const newer = updatePaperDetailFields(older, defaults(), now);
		const merged = mergePaperDetailFields(older, newer);
		expect(merged?.entries.find((field) => field.id === "custom-one")?.deletedAt).toBe(now);
		const left = { ...paper("paper-one"), curation: { tags: [], userNotes: [], detailFields: newer } };
		const right = { ...paper("paper-two"), curation: { tags: [], userNotes: [], detailFields: older } };
		expect(
			mergePaperRecords(left, right).curation?.detailFields?.entries.find((field) => field.id === "custom-one")
				?.deletedAt,
		).toBe(now);
	});

	it("accepts only research fields through the HTTP prepare/execute contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-fields-api-"));
		roots.push(root);
		const staticRoot = join(root, "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html></html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		await application.personalStore().upsertPaper(paper("paper-http"));
		const server = await startLocalWebServer(application, { staticRoot });
		const post = (path: string, body: object) =>
			fetch(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		try {
			const fields = defaults();
			fields[1].value = "Existing tools lack evidence.";
			const preparedResponse = await post("/api/library/detail-fields/prepare", {
				paperId: "paper-http",
				expectedRevision: 0,
				fields,
				title: "Injected replacement",
			});
			expect(preparedResponse.status).toBe(200);
			const prepared = (await preparedResponse.json()) as {
				status: string;
				prepared: { operationId: string; manifestFingerprint: string };
			};
			const grantResponse = await post("/api/operations/confirm", prepared.prepared);
			const grant = await grantResponse.json();
			const savedResponse = await post("/api/library/detail-fields/execute", {
				paperId: "paper-http",
				grant,
				title: "Injected replacement",
			});
			expect(savedResponse.status).toBe(200);
			expect((await savedResponse.json()) as unknown).toMatchObject({
				revision: 1,
				paper: { title: "A study of kernels" },
			});
			const stale = await post("/api/library/detail-fields/prepare", {
				paperId: "paper-http",
				expectedRevision: 0,
				fields,
			});
			expect(stale.status).toBe(409);
			const invalid = await post("/api/library/detail-fields/prepare", {
				paperId: "paper-http",
				expectedRevision: 1,
				fields: [...fields, { id: "custom-x", label: "研究缺口", type: "text", value: "x" }],
			});
			expect(invalid.status).toBe(400);
		} finally {
			await server.close();
			await application.close();
		}
	});
});
