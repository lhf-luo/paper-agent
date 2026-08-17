import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PdfAnnotationStore } from "../src/pdf-annotation-store.ts";
import type { PaperAsset } from "../src/tools/pdf-asset-tools.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function asset(id: string): PaperAsset {
	return {
		id,
		type: "figure",
		identifier: "1",
		page: 2,
		caption: "Figure 1: Result",
		captionBox: { x: 10, y: 70, width: 80, height: 10 },
		candidateRegion: { x: 10, y: 10, width: 80, height: 70 },
		regionConfidence: "medium",
		mentions: [],
	};
}

describe("PDF annotation store", () => {
	it("keeps append-only corrections and applies the latest correction for the exact PDF hash", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-corrections-"));
		temporaryPaths.push(root);
		const store = new PdfAnnotationStore(root);
		const pdfSha256 = "a".repeat(64);
		const input = {
			pdfSha256,
			assetId: "figure-1-p2",
			page: 2,
			originalRegion: { x: 10, y: 10, width: 80, height: 70 },
			correctedRegion: { x: 12, y: 14, width: 74, height: 60 },
			note: "remove surrounding prose",
			author: "alice",
		};
		const [first, second] = await Promise.all([
			store.save(input),
			store.save({ ...input, correctedRegion: { x: 13, y: 15, width: 72, height: 58 }, author: "bob" }),
		]);
		expect(first.id).not.toBe(second.id);
		expect(await store.list(pdfSha256)).toHaveLength(2);
		const applied = await store.apply(pdfSha256, [asset("figure-1-p2"), asset("figure-2-p2")]);
		expect(applied[0]).toMatchObject({
			candidateRegion: { x: 13, y: 15, width: 72, height: 58 },
			regionConfidence: "high",
			manualCorrection: { author: "bob" },
		});
		expect(applied[1].manualCorrection).toBeUndefined();
		expect((await store.apply("b".repeat(64), [asset("figure-1-p2")]))[0].manualCorrection).toBeUndefined();
		expect((await readFile(join(root, "audit.jsonl"), "utf8")).trim().split(/\r?\n/)).toHaveLength(2);
	});
});
