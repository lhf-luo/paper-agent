import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { mergePaperRecords } from "../src/literature/domain/literature-identifiers.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import {
	activePaperDetailFields,
	DEFAULT_PAPER_DETAIL_FIELDS,
	mergePaperDetailFields,
	updatePaperDetailFields,
	validatePaperDetailFields,
} from "../src/literature/domain/paper-detail-fields.ts";
import { ensurePersonalDatabaseSchema } from "../src/literature/infrastructure/personal-database-schema.ts";
import { sqlitePathLayout } from "../src/literature/infrastructure/personal-database-support.ts";

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
		expect(DEFAULT_PAPER_DETAIL_FIELDS.map((field) => field.label)).toEqual([
			"研究问题",
			"研究缺口",
			"核心贡献",
			"方法与系统设计",
			"实验设置",
			"关键结果与证据",
			"局限与适用条件",
			"复现资源与条件",
		]);
		expect(validatePaperDetailFields(defaults())).toHaveLength(8);
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

	it("resets old research cards in every namespace once without changing other paper data", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-fields-migration-"));
		roots.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			const first = application.personalStore();
			const second = application.personalStore("other");
			for (const [store, id] of [
				[first, "paper-one"],
				[second, "paper-two"],
			] as const) {
				await store.upsertPaper({
					...paper(id),
					year: 2025,
					venue: "Test Conference",
					curation: {
						tags: ["keep-tag"],
						userNotes: [{ id: `note-${id}`, text: "keep-note", author: "user", createdAt: "2026-09-01" }],
					},
				});
			}
			const body = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
			const blob = await first.putBlob(body);
			await first.savePaperVersion({
				paperId: "paper-one",
				sourceUrl: "https://example.test/paper.pdf",
				finalUrl: "https://example.test/paper.pdf",
				retrievedAt: "2026-09-01T00:00:00.000Z",
				sha256: blob.sha256,
				bytes: body.length,
				blobPath: blob.path,
				contentType: "application/pdf",
			});
			const legacyFields = {
				revision: 3,
				updatedAt: "2026-09-01T00:00:00.000Z",
				entries: [
					{
						id: "research-question",
						label: "研究问题",
						type: "multiline" as const,
						value: "old answer",
						updatedAt: "2026-09-01T00:00:00.000Z",
					},
					{
						id: "custom-old",
						label: "旧自定义字段",
						type: "text" as const,
						value: "old custom",
						updatedAt: "2026-09-01T00:00:00.000Z",
					},
				],
			};
			const database = new DatabaseSync(sqlitePathLayout(first.root, "default").databasePath);
			try {
				database.exec(
					"DROP TRIGGER papers_detail_fields_insert_guard; DROP TRIGGER papers_detail_fields_update_guard",
				);
				for (const [namespace, id] of [
					["default", "paper-one"],
					["other", "paper-two"],
				]) {
					const row = database
						.prepare("SELECT record_json FROM papers WHERE namespace_id = ? AND paper_id = ?")
						.get(namespace, id) as { record_json: string };
					const record = JSON.parse(row.record_json) as PaperRecord;
					record.curation = { ...record.curation!, detailFields: legacyFields };
					database
						.prepare("UPDATE papers SET record_json = ? WHERE namespace_id = ? AND paper_id = ?")
						.run(JSON.stringify(record), namespace, id);
				}
				database.prepare("DELETE FROM schema_migrations WHERE version IN (10, 11)").run();
			} finally {
				database.close();
			}
			for (const [store, id] of [
				[first, "paper-one"],
				[second, "paper-two"],
			] as const) {
				const saved = await store.getPaper(id);
				expect(saved).toMatchObject({
					id,
					year: 2025,
					venue: "Test Conference",
					identifiers: { doi: "10.1000/kernel" },
					curation: {
						tags: ["keep-tag"],
						userNotes: [{ text: "keep-note" }],
						detailFields: { schemaVersion: 2, revision: 4, entries: [] },
					},
				});
				expect(activePaperDetailFields(saved?.curation?.detailFields)).toEqual(defaults());
				expect((await store.getPaper(id))?.curation?.detailFields?.revision).toBe(4);
				expect(mergePaperDetailFields(legacyFields, saved?.curation?.detailFields)).toEqual(
					saved?.curation?.detailFields,
				);
			}
			expect(await first.listPaperVersions("paper-one")).toHaveLength(1);
			await expect(
				application.preparePersonalPaperDetailFields({
					paperId: "paper-one",
					expectedRevision: 3,
					fields: defaults(),
				}),
			).rejects.toThrow(/changed/i);
			await first.upsertPaper({
				...paper("paper-one"),
				curation: { tags: [], userNotes: [], detailFields: legacyFields },
			});
			expect((await first.getPaper("paper-one"))?.curation?.detailFields?.entries).toEqual([]);
		} finally {
			await application.close();
		}
	});

	it("repairs only cards written back after v10 and rejects an outdated writer", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-detail-fields-repair-"));
		roots.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		try {
			const currentStore = application.personalStore();
			const legacyStore = application.personalStore("other");
			await currentStore.upsertPaper({
				...paper("current"),
				curation: { tags: ["keep-current"], userNotes: [] },
			});
			await legacyStore.upsertPaper({
				...paper("legacy"),
				curation: { tags: ["keep-legacy"], userNotes: [] },
			});
			const filled = [
				...defaults(),
				{ id: "custom-new", label: "复现日志", type: "text" as const, value: "New custom content" },
			];
			filled[0].value = "New schema answer";
			await currentStore.savePaperDetailFields("current", 0, filled);
			const database = new DatabaseSync(sqlitePathLayout(currentStore.root, "default").databasePath);
			try {
				const currentBefore = database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = 'default' AND paper_id = 'current'")
					.get() as { record_json: string };
				const legacyBefore = database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = 'other' AND paper_id = 'legacy'")
					.get() as { record_json: string };
				const oldRecord = JSON.parse(legacyBefore.record_json) as PaperRecord;
				oldRecord.curation!.detailFields = {
					revision: 3,
					updatedAt: "2026-09-01T00:00:00.000Z",
					entries: [
						{
							id: "core-innovation",
							label: "核心创新点",
							type: "multiline",
							value: "Old schema answer",
							updatedAt: "2026-09-01T00:00:00.000Z",
						},
					],
				};
				database.exec(
					"DROP TRIGGER papers_detail_fields_insert_guard; DROP TRIGGER papers_detail_fields_update_guard",
				);
				database
					.prepare("UPDATE papers SET record_json = ? WHERE namespace_id = 'other' AND paper_id = 'legacy'")
					.run(JSON.stringify(oldRecord));
				database.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
				ensurePersonalDatabaseSchema(database);
				const currentAfter = database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = 'default' AND paper_id = 'current'")
					.get() as { record_json: string };
				expect(currentAfter.record_json).toBe(currentBefore.record_json);
				const repaired = JSON.parse(
					(
						database
							.prepare("SELECT record_json FROM papers WHERE namespace_id = 'other' AND paper_id = 'legacy'")
							.get() as { record_json: string }
					).record_json,
				) as PaperRecord;
				expect(repaired.curation?.detailFields).toMatchObject({ schemaVersion: 2, revision: 4, entries: [] });
				expect(repaired.curation?.tags).toEqual(["keep-legacy"]);
				expect(() =>
					database
						.prepare("UPDATE papers SET record_json = ? WHERE namespace_id = 'other' AND paper_id = 'legacy'")
						.run(JSON.stringify(oldRecord)),
				).toThrow(/Outdated research card/);
				const withoutFields = JSON.parse(currentBefore.record_json) as PaperRecord;
				delete withoutFields.curation?.detailFields;
				expect(() =>
					database
						.prepare("UPDATE papers SET record_json = ? WHERE namespace_id = 'default' AND paper_id = 'current'")
						.run(JSON.stringify(withoutFields)),
				).toThrow(/Outdated research card/);
			} finally {
				database.close();
			}
			const staleMetadata = { ...paper("current"), year: 2026 };
			await currentStore.replacePaperMetadata(staleMetadata);
			expect((await currentStore.getPaper("current"))?.curation?.detailFields?.entries[0]?.value).toBe(
				"New schema answer",
			);
			expect((await legacyStore.getPaper("legacy"))?.curation?.detailFields?.entries).toEqual([]);
		} finally {
			await application.close();
		}
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
