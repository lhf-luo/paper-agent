import { afterEach, expect, it, vi } from "vitest";
import { researchFixture } from "./canvas-research-fixture.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import * as providers from "../src/literature/infrastructure/literature-providers.ts";
import * as authors from "../src/literature/infrastructure/provider-author-papers.ts";
import { SearchRunGraphs } from "../src/canvas/application/search-run-graphs.ts";
import type { BackgroundJob } from "../src/shared/domain/background-job.ts";
afterEach(() => vi.restoreAllMocks());
async function setup() {
	const f = await researchFixture(1);
	await f.library.upsertPapers([
		{ ...f.papers[0], identifiers: { doi: "10.1234/seed", openAlexId: "W1" }, referencedWorks: ["W2"] },
	]);
	const server = await startLocalWebServer(f.app, { staticRoot: "dist/web" });
	const url = `${server.url}/api/canvases/${f.service.canvasId}/expansions`;
	const post = (body: Record<string, unknown>) =>
		fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				paperId: "p0",
				kind: "citation",
				direction: "references",
				requestId: "test-request",
				limit: 10,
				...body,
			}),
		});
	return { ...f, server, post };
}
async function finished(f: Awaited<ReturnType<typeof setup>>, id: string) {
	await vi.waitFor(() => expect(["succeeded", "failed", "cancelled"]).toContain(f.app.jobs.get(id)?.status), {
		timeout: 10000,
	});
	return f.app.jobs.get(id)!;
}
it("executes a direct citation job with no Agent service, deduplicates submissions and opens its graph", async () => {
	const f = await setup();
	const neighbor = {
		...f.papers[0],
		id: "neighbor",
		year: 2026,
		title: "Neighbor",
		identifiers: { openAlexId: "W2" },
	};
	const fetch = vi.spyOn(providers, "fetchOpenAlexWorks").mockResolvedValue([neighbor]);
	vi.spyOn(providers, "searchSemanticScholarCitations").mockResolvedValue({ records: [] } as never);
	try {
		const [a, b] = await Promise.all([
			f.post({ yearFrom: 2025 }).then((r) => r.json()),
			f.post({ yearFrom: 2025 }).then((r) => r.json()),
		]);
		expect(a.id).toBeDefined();
		expect(a.id).toBe(b.id);
		const job = await finished(f, a.id);
		expect(job.status).toBe("succeeded");
		expect(fetch).toHaveBeenCalledTimes(1);
		const result = job.result as { searchRunId: string; resultCount: number };
		expect(result.resultCount).toBe(2);
		const graph = await new SearchRunGraphs(f.library, f.service.canvasId).graph(result.searchRunId);
		expect(graph.nodes).toHaveLength(2);
		expect(await f.library.listPapers()).toHaveLength(1);
		expect((await f.post({ yearFrom: 2024 })).status).toBe(400);
		expect((await f.post({ yearFrom: 2025 })).status).toBe(202);
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		await f.server.close();
	}
});
it("shares the existing author API service and preserves partial-source status", async () => {
	const f = await setup();
	const spy = vi.spyOn(authors, "findAuthorSourcePapers").mockImplementation(async (provider, options) => {
		expect(options.yearFrom).toBe(2024);
		expect(options.yearTo).toBe(2026);
		if (provider === "dblp") throw new Error("provider unavailable");
		return {
			provider,
			status: "succeeded",
			authorId: "A1",
			truncated: false,
			records: [
				{ ...f.papers[0], id: "followup", title: "Followup", year: 2025, identifiers: { doi: "10.1234/followup" } },
			],
		};
	});
	try {
		const response = await f.post({ kind: "author", authorName: "Author 0", yearFrom: 2024, yearTo: 2026 });
		expect(response.status).toBe(202);
		const job = await finished(f, ((await response.json()) as BackgroundJob).id);
		expect(job.status).toBe("succeeded");
		expect(spy).toHaveBeenCalledTimes(3);
		const result = job.result as { searchRunId: string };
		const run = await f.library.getSearchRun(result.searchRunId);
		expect(run?.runKind).toBe("author-expansion");
		expect(run?.results).toHaveLength(1);
		expect(run?.failures).toHaveLength(1);
		expect(new SearchRunGraphs(f.library, f.service.canvasId).views.get(result.searchRunId)).toBeDefined();
		expect(await f.library.listPapers()).toHaveLength(1);
	} finally {
		await f.server.close();
	}
});
it("rejects invalid seeds, authors, ranges and budgets before starting any job", async () => {
	const f = await setup();
	try {
		for (const input of [
			{ paperId: "missing" },
			{ kind: "author", authorName: "Unknown" },
			{ yearFrom: 2026, yearTo: 2024 },
			{ limit: 101 },
			{ direction: "wrong" },
			{ requestId: "" },
		])
			expect((await f.post(input)).status).toBe(400);
		expect(f.app.jobs.list({ limit: 100 })).toHaveLength(0);
	} finally {
		await f.server.close();
	}
});
it("cancels provider requests without opening or importing an incomplete run", async () => {
	const f = await setup();
	const provider = vi
		.spyOn(providers, "fetchOpenAlexWorks")
		.mockImplementation(
			async (_ids, options) =>
				new Promise((_resolve, reject) =>
					options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
				),
		);
	try {
		const job = (await (await f.post({})).json()) as BackgroundJob;
		await vi.waitFor(() => expect(provider).toHaveBeenCalled());
		await f.app.jobs.cancel(job.id);
		expect((await finished(f, job.id)).status).toBe("cancelled");
		expect(new SearchRunGraphs(f.library, f.service.canvasId).views.list()).toHaveLength(0);
		expect(await f.library.listPapers()).toHaveLength(1);
	} finally {
		await f.server.close();
	}
});
