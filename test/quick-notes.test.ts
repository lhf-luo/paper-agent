import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import type { CreateQuickNoteInput, QuickNote } from "../src/quick-notes/domain/quick-note.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function paper(id: string): PaperRecord {
	return {
		id,
		title: `论文 ${id}`,
		authors: ["Author"],
		year: 2026,
		identifiers: {},
		links: [],
		provenance: [],
		mergedFrom: [],
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-quick-notes-"));
	roots.push(root);
	const app = new PaperAgentApplication({ projectRoot: root });
	const store = app.personalStore();
	await store.upsertPapers([paper("a"), paper("b")]);
	const body = new TextEncoder().encode("%PDF-1.7\nquick note fixture");
	const blob = await store.putBlob(body);
	await store.savePaperVersion({
		paperId: "a",
		sourceUrl: "https://example.test/a.pdf",
		finalUrl: "https://example.test/a.pdf",
		retrievedAt: new Date().toISOString(),
		sha256: blob.sha256,
		bytes: body.length,
		blobPath: blob.path,
		contentType: "application/pdf",
		versionKind: "published",
		versionLabel: "正式版",
	});
	return { app, store, root, sha: blob.sha256, notes: app.quickNotes() };
}

const input = (overrides: Partial<CreateQuickNoteInput> = {}): CreateQuickNoteInput => ({
	content: "作者提出的局限性",
	paperId: "a",
	clientRequestId: randomUUID(),
	...overrides,
});

describe("随手记 persistence and sources", () => {
	it("saves a cross-page excerpt, survives reopening, retries once and allows repeated text", async () => {
		const { app, notes, sha } = await fixture();
		const request = input({ locator: { pdfSha256: sha, pages: [3, 2, 3] } });
		const [first, repeated] = await Promise.all([notes.create(request), notes.create(request)]);
		expect(first.id).toBe(repeated.id);
		expect(first).toMatchObject({
			revision: 1,
			paperAvailable: true,
			locationAvailable: true,
			locator: { pdfSha256: sha, pages: [2, 3], versionLabel: "正式版" },
		});
		await app.quickNotes().create(input());
		expect((await app.quickNotes().list()).total).toBe(2);
		await expect(notes.create({ ...request, content: "different" })).rejects.toMatchObject({ status: 409 });
	});

	it("validates personal papers, version ownership, content and page ranges", async () => {
		const { notes, sha } = await fixture();
		await expect(notes.create(input({ content: "  " }))).rejects.toMatchObject({ status: 400 });
		await expect(notes.create(input({ paperId: "missing" }))).rejects.toMatchObject({ status: 404 });
		await expect(
			notes.create(input({ paperId: "b", locator: { pdfSha256: sha, pages: [1] } })),
		).rejects.toMatchObject({ status: 400 });
		await expect(notes.create(input({ locator: { pdfSha256: sha, pages: [0] } }))).rejects.toMatchObject({
			status: 400,
		});
		await expect(notes.list({ pageSize: 101 })).rejects.toMatchObject({ status: 400 });
	});

	it("keeps source snapshots after deletion and never reattaches to a new paper with the same ID", async () => {
		const { notes, store } = await fixture();
		const created = await notes.create(input());
		await store.upsertPaper({ ...paper("a"), title: "新标题" });
		expect((await notes.list({ query: "新标题" })).notes[0].paper.title).toBe("新标题");
		await store.deletePapers(["a"]);
		const deleted = (await notes.list({ paperId: "a" })).notes[0];
		expect(deleted).toMatchObject({ id: created.id, paperAvailable: false, paper: { title: "论文 a" } });
		await store.upsertPaper({ ...paper("a"), title: "Reimport" });
		expect((await notes.list()).notes[0].paperAvailable).toBe(false);
	});

	it("preserves locator when its PDF is removed, and counts retained notes in deletion confirmation", async () => {
		const { app, notes, store, sha } = await fixture();
		await notes.create(input({ locator: { pdfSha256: sha, pages: [7] } }));
		const prepared = await app.preparePersonalPaperRemoval({ paperIds: ["a"], mode: "permanent-delete" });
		expect(prepared.details).toMatchObject({ retainedQuickNoteCount: 1 });
		await store.deletePaperVersion("a", sha);
		expect((await notes.list()).notes[0]).toMatchObject({
			paperAvailable: true,
			locationAvailable: false,
			locator: { pdfSha256: sha, pages: [7] },
		});
	});

	it("paginates, searches content and titles, and rejects stale edits without replacing content", async () => {
		const { notes } = await fixture();
		const a = await notes.create(input({ content: "limitations" }));
		await notes.create(input({ paperId: "b", content: "different" }));
		expect((await notes.list({ pageSize: 1 })).notes).toHaveLength(1);
		expect((await notes.list({ query: "LIMITATIONS" })).total).toBe(1);
		expect((await notes.list({ query: "论文 b" })).notes[0].paper.id).toBe("b");
		await notes.update(a.id, "edited", 1);
		await expect(notes.update(a.id, "stale", 1)).rejects.toMatchObject({ status: 409 });
		expect((await notes.list({ paperId: "a" })).notes[0].content).toBe("edited");
		await notes.delete(a.id);
		expect((await notes.list()).total).toBe(1);
	});

	it("exposes CRUD over HTTP without Agent approvals, with explicit validation and conflict errors", async () => {
		const { app, root } = await fixture();
		const server = await startLocalWebServer(app, { staticRoot: root });
		const send = (path: string, method = "GET", body?: unknown) =>
			fetch(`${server.url}/api/quick-notes${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
			});
		try {
			const request = input();
			const created = await send("", "POST", request);
			expect(created.status).toBe(201);
			const { note } = (await created.json()) as { note: QuickNote };
			expect((await (await send(`/${note.id}`)).json()).note.id).toBe(note.id);
			expect((await (await send("", "POST", request)).json()).note.id).toBe(note.id);
			expect((await send(`/${note.id}`, "PATCH", { content: "new", expectedRevision: 1 })).status).toBe(200);
			expect((await send(`/${note.id}`, "PATCH", { content: "stale", expectedRevision: 1 })).status).toBe(409);
			expect((await send("?page=0")).status).toBe(400);
			expect((await send("", "POST", { content: "" })).status).toBe(400);
			expect((await (await send("?query=new&paperId=a")).json()).total).toBe(1);
			expect((await send(`/${note.id}`, "DELETE")).status).toBe(200);
			expect((await (await send("")).json()).total).toBe(0);
		} finally {
			await server.close();
			await app.close();
		}
	});
});
