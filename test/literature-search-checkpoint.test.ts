import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectLiterature } from "../src/tools/collection-tools.ts";
import { LiteratureProviderHttpError } from "../src/literature-providers.ts";
import { LiteratureSearchCheckpoint } from "../src/literature-search-checkpoint.ts";
import type { PaperRecord, ProviderPage } from "../src/literature-types.ts";

function paper(id: string, title: string): PaperRecord {
	return {
		id,
		title,
		authors: ["Fixture Author"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "dblp", query: "fuzzing", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
	};
}

describe("literature search checkpoint", () => {
	it("replays partial provider/query progress and removes completed state", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-checkpoint-"));
		const path = join(root, "job.json");
		const first = await LiteratureSearchCheckpoint.open(path, "fingerprint-a");
		expect(first.resumed).toBe(false);
		await first.update({
			provider: "dblp",
			query: "fuzzing",
			records: [],
			cursor: "10",
			pagesCompleted: 1,
			done: false,
		});
		expect(await readFile(path, "utf8")).toContain('"cursor":"10"');

		const resumed = await LiteratureSearchCheckpoint.open(path, "fingerprint-a");
		expect(resumed.resumed).toBe(true);
		expect(resumed.get("dblp", "fuzzing")).toMatchObject({ cursor: "10", pagesCompleted: 1 });
		await resumed.complete();
		const fresh = await LiteratureSearchCheckpoint.open(path, "fingerprint-a");
		expect(fresh.resumed).toBe(false);
	});

	it("keeps retryable progress, resumes from the saved cursor, and removes the checkpoint after success", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-search-resume-"));
		const checkpointPath = join(root, "search.json");
		const firstCursors: Array<string | undefined> = [];
		let firstCalls = 0;
		const firstSearch = async (_provider: "dblp", options: { cursor?: string }): Promise<ProviderPage> => {
			firstCursors.push(options.cursor);
			firstCalls++;
			if (firstCalls === 1) {
				return {
					provider: "dblp",
					query: "fuzzing",
					records: [paper("dblp:first", "First page")],
					nextCursor: "page-2",
					requestUrl: "https://dblp.example/page-1",
				};
			}
			throw new LiteratureProviderHttpError(
				"DBLP",
				new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }),
			);
		};
		const base = {
			queries: ["fuzzing"],
			providers: ["dblp" as const],
			filters: {},
			pagesPerProvider: 2,
			maxResultsPerProvider: 2,
			scope: "personal" as const,
			mode: "once" as const,
			namespace: "default",
			cwd: root,
			reuseCorpus: false,
			checkpointPath,
		};
		const partial = await collectLiterature({ ...base, providerPageSearch: firstSearch as never });

		expect(firstCursors).toEqual([undefined, "page-2"]);
		expect(partial.run.failures).toMatchObject([
			{ provider: "dblp", statusCode: 429, rateLimited: true, retryable: true, retryAfter: expect.any(String) },
		]);
		expect(await readFile(checkpointPath, "utf8")).toContain('"cursor":"page-2"');

		const resumedCursors: Array<string | undefined> = [];
		const resumed = await collectLiterature({
			...base,
			providerPageSearch: (async (_provider: "dblp", options: { cursor?: string }) => {
				resumedCursors.push(options.cursor);
				return {
					provider: "dblp",
					query: "fuzzing",
					records: [paper("dblp:second", "Second page")],
					requestUrl: "https://dblp.example/page-2",
				};
			}) as never,
		});

		expect(resumedCursors).toEqual(["page-2"]);
		expect(resumed.run.resumedFromCheckpoint).toBe(true);
		expect(resumed.run.failures).toEqual([]);
		expect(resumed.run.results.map((record) => record.title).sort()).toEqual(["First page", "Second page"]);
		await expect(access(checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
