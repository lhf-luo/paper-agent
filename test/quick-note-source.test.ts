import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickNote } from "../src/quick-notes/domain/quick-note.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

async function setup() {
	vi.stubGlobal("window", { location: { hash: "" } });
	const fetch = vi.fn().mockResolvedValue(
		new Response(
			JSON.stringify({
				paper: { id: "a", title: "Paper a" },
				versions: [
					{ sha256: "preferred", isPreferred: true, blobPath: "/preferred.pdf" },
					{ sha256: "original", versionKind: "published", blobPath: "/original.pdf" },
				],
			}),
			{ headers: { "content-type": "application/json" } },
		),
	);
	vi.stubGlobal("fetch", fetch);
	const { openQuickNoteSource } = await import("../web/src/quick-notes-api.ts");
	const note: QuickNote = {
		id: "note",
		content: "excerpt",
		paper: { id: "a", title: "Paper a", authors: [] },
		sourceSnapshot: { id: "a", title: "Paper a", authors: [] },
		paperAvailable: true,
		locator: { pdfSha256: "original", pages: [4, 5] },
		locationAvailable: true,
		revision: 1,
		createdAt: "2026-10-23",
		updatedAt: "2026-10-23",
	};
	return { note, fetch, openQuickNoteSource };
}

describe("随手记 source navigation", () => {
	it("opens the captured version and first physical page instead of the preferred version", async () => {
		const { note, openQuickNoteSource } = await setup();
		expect(await openQuickNoteSource(note)).toMatchObject({
			paperId: "a",
			sha256: "original",
			url: "/api/papers/a/pdf/original#page=4",
		});
	});

	it("reports missing original versions without falling back to the same page of another PDF", async () => {
		const { note, openQuickNoteSource } = await setup();
		note.locator!.pdfSha256 = "removed";
		await expect(openQuickNoteSource(note)).rejects.toThrow("原 PDF 版本已不存在");
	});

	it("uses the preferred version for manual records and never navigates deleted sources", async () => {
		const { note, fetch, openQuickNoteSource } = await setup();
		delete note.locator;
		expect((await openQuickNoteSource(note)).sha256).toBe("preferred");
		fetch.mockClear();
		note.paperAvailable = false;
		await expect(openQuickNoteSource(note)).rejects.toThrow("来源论文已删除");
		expect(fetch).not.toHaveBeenCalled();
	});
});
