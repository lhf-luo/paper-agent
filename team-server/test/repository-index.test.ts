import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTeamLiteratureRepository } from "../src/infrastructure/file-team-literature-repository.ts";
import type { PaperRecord } from "../src/protocol/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(id: string, title: string): PaperRecord {
	return {
		id,
		title,
		authors: ["Index Author"],
		year: 2026,
		identifiers: {},
		links: [],
		provenance: [{ provider: "json-import", query: "index-fixture", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		curation: { tags: [], userNotes: [], teamReview: { status: "team-proposed", proposedBy: "alice", proposedAt: "2026-01-01T00:00:00.000Z" } },
	};
}

describe("team literature repository index", () => {
	it("caches records, tracks writes, and reloads after invalidate()", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-index-"));
		temporaryPaths.push(root);
		const repository = new FileTeamLiteratureRepository(join(root, "corpus"), "lab");
		await repository.initialize();

		await repository.proposePapers([record("index-one", "Indexed One")], "alice");
		expect((await repository.listPapers()).map((entry) => entry.id)).toEqual(["index-one"]);

		// The cache answers from memory: a record written behind the repository is not picked up yet.
		await mkdir(join(root, "corpus", "records"), { recursive: true });
		await writeFile(
			join(root, "corpus", "records", "index-external.json"),
			`${JSON.stringify(record("index-external", "Written Externally"))}\n`,
			"utf8",
		);
		expect((await repository.listPapers()).map((entry) => entry.id)).toEqual(["index-one"]);

		repository.invalidate();
		expect((await repository.listPapers()).map((entry) => entry.id).sort()).toEqual(["index-external", "index-one"]);

		// Writes keep the cache coherent without another invalidation.
		await repository.reviewTeamPaper("index-one", "team-approved", "bob", "checked");
		expect((await repository.listPapers()).find((entry) => entry.id === "index-one")?.curation?.teamReview?.status).toBe(
			"team-approved",
		);
		await repository.withdrawPapers(["index-external"], "alice");
		expect((await repository.listPapers()).map((entry) => entry.id)).toEqual(["index-one"]);

		// Callers receive frozen records: an accidental mutation fails loudly instead of corrupting the cache.
		const snapshot = await repository.listPapers();
		expect(() => {
			(snapshot[0] as PaperRecord).title = "mutated by caller";
		}).toThrow();
		expect((await repository.listPapers())[0]?.title).toBe("Indexed One");
	});

	it("answers warm searches from memory far faster than re-reading every record file", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-index-perf-"));
		temporaryPaths.push(root);
		const corpusRoot = join(root, "corpus");
		await mkdir(join(corpusRoot, "records"), { recursive: true });
		const total = 300;
		await Promise.all(
			Array.from({ length: total }, (_, index) =>
				writeFile(
					join(corpusRoot, "records", `paper-${String(index).padStart(4, "0")}.json`),
					`${JSON.stringify({
						...record(`paper-${String(index).padStart(4, "0")}`, `Indexed Paper ${index}`),
						curation: {
							tags: [],
							userNotes: [],
							teamReview: {
								status: "team-approved",
								proposedBy: "alice",
								proposedAt: "2026-01-01T00:00:00.000Z",
							},
						},
					})}\n`,
					"utf8",
				),
			),
		);
		const repository = new FileTeamLiteratureRepository(corpusRoot, "lab");
		await repository.initialize();
		const rounds = 5;

		await repository.listPapers();
		const warmStart = performance.now();
		for (let round = 0; round < rounds; round++) await repository.searchPapers({ query: "indexed", limit: 100 });
		const warm = performance.now() - warmStart;

		// `invalidate()` before every search reproduces the previous per-request behaviour.
		const coldStart = performance.now();
		for (let round = 0; round < rounds; round++) {
			repository.invalidate();
			await repository.searchPapers({ query: "indexed", limit: 100 });
		}
		const cold = performance.now() - coldStart;

		expect(warm).toBeLessThan(cold);
	});
});
