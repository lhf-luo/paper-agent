import { fetchGraphCitationPage } from "../src/canvas/infrastructure/search-graph-provider.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { expect, it, vi, afterEach } from "vitest";
import * as graphProvider from "../src/canvas/infrastructure/search-graph-provider.ts";
afterEach(() => vi.restoreAllMocks());
import { researchFixture } from "./canvas-research-fixture.ts";
import { SearchRunGraphs } from "../src/canvas/application/search-run-graphs.ts";
import { enrichSearchGraph } from "../src/canvas/application/search-graph-enrichment.ts";
import type { Fetcher } from "../src/shared/infrastructure/network-security.ts";
import type { BackgroundJobContext } from "../src/shared/domain/background-job.ts";
async function fixture(count = 2) {
	const f = await researchFixture(count),
		graphs = new SearchRunGraphs(f.library, f.service.canvasId),
		now = new Date().toISOString();
	await f.library.saveSearchRun({
		id: "run",
		results: f.papers.map((p, i) => ({ ...p, identifiers: { openAlexId: `W${i + 1}` } })),
		queries: [],
		providers: [],
		failures: [],
		sourceCounts: {},
		deduplicatedCount: count,
		startedAt: now,
		completedAt: now,
		filters: {},
		pagesPerProvider: 1,
		maxResultsPerProvider: 100,
		scope: "personal",
		mode: "once",
	});
	await graphs.show("run", "user");
	return { ...f, graphs };
}
function context(controller = new AbortController()) {
	let checkpoint: unknown;
	return {
		jobId: "test",
		signal: controller.signal,
		report: () => {},
		saveCheckpoint: (v: unknown) => {
			checkpoint = v;
		},
		checkpoint: <T>() => checkpoint as T | undefined,
	} satisfies BackgroundJobContext;
}
it("visits first pages before continuations, persists cache and never adds outside evidence as papers", async () => {
	const f = await fixture(),
		calls: string[] = [];
	const fetcher: Fetcher = async (url) => {
		const u = new URL(String(url));
		calls.push(`${u.pathname}:${u.searchParams.get("cursor")}`);
		return Response.json(
			u.pathname.endsWith("W1") || u.pathname.endsWith("W2")
				? { referenced_works: ["W500", "W501"] }
				: {
						results: [{ id: "W600" }],
						meta: { next_cursor: u.searchParams.get("cursor") === "*" ? "next" : undefined },
					},
		);
	};
	const research = await f.graphs.research("run"),
		input = { canvasId: f.service.canvasId, runId: "run", budget: 5, fingerprint: research.fingerprint };
	const result = await enrichSearchGraph(f.graphs, input, context(), { fetcher, spacingMs: 0 });
	expect(result.attempts).toBe(5);
	expect(result.budgetExhausted).toBe(true);
	expect(calls.slice(0, 4)).toEqual(["/works/W1:null", "/works:*", "/works/W2:null", "/works:*"]);
	expect((await f.graphs.graph("run")).nodes).toHaveLength(2);
	expect((await f.library.getSearchRun("run"))?.results[0].referencedWorks).toBeUndefined();
	const updated = await f.graphs.research("run");
	const continued = await enrichSearchGraph(f.graphs, { ...input, fingerprint: updated.fingerprint }, context(), {
		fetcher,
		spacingMs: 0,
	});
	expect(continued.attempts).toBe(1);
	expect(continued.complete).toBe(4);
});
it("counts retries as attempts and saves cancellation checkpoints", async () => {
	const f = await fixture(1),
		r = await f.graphs.research("run");
	let requests = 0;
	const result = await enrichSearchGraph(
		f.graphs,
		{ canvasId: f.service.canvasId, runId: "run", budget: 3, fingerprint: r.fingerprint },
		context(),
		{
			spacingMs: 0,
			fetcher: async () => {
				requests++;
				return new Response("failure", { status: 503 });
			},
		},
	);
	expect(requests).toBe(3);
	expect(result.budgetExhausted).toBe(true);
	const controller = new AbortController(),
		ctx = context(controller),
		next = await f.graphs.research("run");
	await expect(
		enrichSearchGraph(
			f.graphs,
			{ canvasId: f.service.canvasId, runId: "run", budget: 5, fingerprint: next.fingerprint },
			ctx,
			{
				spacingMs: 0,
				fetcher: async () => {
					controller.abort();
					throw new Error("cancelled");
				},
			},
		),
	).rejects.toThrow();
	expect(ctx.checkpoint<{ attempts: number }>()?.attempts).toBe(1);
	expect(f.graphs.views.getResearch("run").attempts).toBe(1);
});
it("respects Retry-After across provider requests and distinguishes missing, complete-empty and capped", async () => {
	const f = await fixture(1),
		r = await f.graphs.research("run");
	let calls = 0;
	const limited = await enrichSearchGraph(
		f.graphs,
		{ canvasId: f.service.canvasId, runId: "run", budget: 10, fingerprint: r.fingerprint },
		context(),
		{
			spacingMs: 0,
			fetcher: async () => {
				calls++;
				return new Response("rate limited", { status: 429, headers: { "Retry-After": "3600" } });
			},
		},
	);
	expect(calls).toBe(1);
	expect(limited.rateLimited).toBe(2);
	const features = f.graphs.views.getResearch("run").features;
	for (const s of Object.values(features).flatMap((f) => [f.references, f.citations])) s.retryAfter = undefined;
	f.graphs.views.saveResearch("run", { features });
	const next = await f.graphs.research("run");
	const done = await enrichSearchGraph(
		f.graphs,
		{ canvasId: f.service.canvasId, runId: "run", budget: 10, fingerprint: next.fingerprint },
		context(),
		{
			spacingMs: 0,
			fetcher: async (url) =>
				Response.json(
					String(url).includes("/W1")
						? { referenced_works: Array.from({ length: 501 }, (_, i) => `W${i + 100}`) }
						: { results: [], meta: {} },
				),
		},
	);
	expect(done.empty).toBe(1);
	expect(f.graphs.views.getResearch("run").features.p0.references).toMatchObject({ status: "partial", capped: true });
	expect(f.graphs.views.getResearch("run").features.p0.references.ids).toHaveLength(500);
});
it("keeps prior layouts restorable, copies research snapshots and leaves runs on canvas deletion", async () => {
	const f = await fixture(),
		r = await f.graphs.research("run"),
		old = f.graphs.views.get("run")!;
	f.graphs.saveState("run", {
		...old.state,
		positions: { p0: { x: 25, y: 30 }, p1: { x: 90, y: 90 } },
		manualPins: ["p0"],
		viewport: { x: 5, y: 10, scale: 2 },
	});
	f.graphs.applyLayout("run");
	expect(f.graphs.views.get("run")?.state.positions).toEqual({ p0: { x: 25, y: 30 } });
	f.graphs.applyLayout("run", true);
	expect(f.graphs.views.get("run")?.state.positions).toHaveProperty("p1");
	const board = f.service.board(),
		copy = f.service.canvases.duplicate(board.id, board.revision)!;
	expect(new SearchRunGraphs(f.library, copy.id).views.getResearch("run").fingerprint).toBe(r.fingerprint);
	f.service.canvases.delete(board.id, board.revision);
	expect(await f.library.getSearchRun("run")).toBeDefined();
});

it("parses Semantic Scholar direction and offset without discovering extra visible papers", async () => {
	const f = await fixture(1),
		seen: string[] = [];
	const fetcher: Fetcher = async (url) => {
		seen.push(String(url));
		return Response.json({
			data: [{ citedPaper: { paperId: "a".repeat(40) }, citingPaper: { paperId: "b".repeat(40) } }],
			next: 100,
		});
	};
	const set = { ids: [], status: "missing" as const, provider: "semanticscholar" };
	const refs = await fetchGraphCitationPage(f.papers[0], "references", set, new AbortController().signal, fetcher);
	expect(refs.ids).toEqual([`s2:${"a".repeat(40)}`]);
	expect(refs.cursor).toBe("100");
	const citing = await fetchGraphCitationPage(
		f.papers[0],
		"citations",
		{ ...set, cursor: "100" },
		new AbortController().signal,
		fetcher,
	);
	expect(citing.ids).toEqual([`s2:${"b".repeat(40)}`]);
	expect(new URL(seen[1]).searchParams.get("offset")).toBe("100");
});
it("previews offline, validates the HTTP budget and deduplicates concurrent starts", async () => {
	const f = await fixture(1),
		server = await startLocalWebServer(f.app, { staticRoot: "dist/web" });
	vi.spyOn(graphProvider, "fetchGraphCitationPage").mockImplementation(
		async (_paper, _channel, _set, signal) =>
			new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
			),
	);
	const base = `${server.url}/api/canvases/${f.service.canvasId}/search-graphs/run`,
		post = (body: unknown) =>
			fetch(`${base}/enrich`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
	try {
		expect((await fetch(`${base}/enrich`)).status).toBe(200);
		expect(f.app.jobs.list({ limit: 100 })).toHaveLength(0);
		expect((await post({ budget: 101 })).status).toBe(400);
		const [a, b] = await Promise.all([
			post({ budget: 1 }).then((r) => r.json()),
			post({ budget: 1 }).then((r) => r.json()),
		]);
		expect(a, JSON.stringify([a, b])).toHaveProperty("id");
		expect(a.id).toBe(b.id);
		expect((await fetch(`${server.url}/api/jobs/${a.id}/cancel`, { method: "POST" })).status).toBe(200);
	} finally {
		await server.close();
	}
});
