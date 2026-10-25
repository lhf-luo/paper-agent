import { describe, expect, it } from "vitest";
import { SearchRunGraphs } from "../src/canvas/application/search-run-graphs.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import type { PaperRecord, SearchRun } from "../src/literature/domain/literature-types.ts";
import { fingerprintSearchRun, saveFilterResult } from "../src/literature/application/literature-filter-result.ts";
import { collectRegisteredTools } from "../src/shared/presentation/agent-tool-catalog.ts";
import { registerCanvasSearchTools } from "../src/canvas/presentation/canvas-search-tools.ts";
import { researchFixture, paperNode } from "./canvas-research-fixture.ts";
import { dirname } from "node:path";
const now = "2026-10-22T00:00:00.000Z";
const paper = (id = "candidate-a"): PaperRecord => ({
	id,
	title: `Candidate ${id}`,
	authors: ["Author 0"],
	abstract: "Saved candidate abstract",
	year: 2025,
	identifiers: { arxivId: id === "candidate-a" ? "2601.00001" : `2601.${id}` },
	links: [],
	mergedFrom: [],
	provenance: [{ provider: "openalex", query: "seed", retrievedAt: now }],
	discoveryPaths: [{ kind: "reference-expansion", seedPaperId: "p0", provider: "openalex", discoveredAt: now }],
});
const run = (results = [paper()], id = "graph-run"): SearchRun => ({
	id,
	startedAt: now,
	completedAt: now,
	queries: ["seed"],
	filters: {},
	providers: ["openalex"],
	results: [{ ...paper("p0"), discoveryPaths: [] }, ...results],
	failures: [],
	sourceCounts: { openalex: results.length },
	deduplicatedCount: results.length + 1,
	pagesPerProvider: 1,
	maxResultsPerProvider: 100,
	runKind: "citation-expansion",
	seedPaperIds: ["p0"],
	scope: "personal",
	mode: "once",
});

describe("independent Search Run graphs", () => {
	it("opens through the canvas tool without changing canvas, analyses or library", async () => {
		const f = await researchFixture(),
			before = f.service.board(),
			value = run();
		await f.library.saveSearchRun(value);
		const tools = collectRegisteredTools((pi) => registerCanvasSearchTools(pi, f.service));
		expect(tools.map((t) => t.name)).toEqual(["show_search_run_graph"]);
		const result = await tools[0].execute("show", { search_run_id: value.id }, undefined, undefined, {} as never);
		expect(result.details).toMatchObject({ searchRunId: value.id, resultCount: 2, displayedCount: 2, seedCount: 1 });
		const graphs = new SearchRunGraphs(f.library, before.id);
		const graph = await graphs.graph(value.id);
		expect(graph.nodes).toHaveLength(2);
		expect(graph.nodes![0]).toMatchObject({ id: "p0", isSeed: true });
		expect(graph.nodes![0]).not.toHaveProperty("abstract");
		expect(graph.edges).toMatchObject([{ from: "p0", to: "candidate-a", kind: "citation" }]);
		expect((await graphs.graph(value.id, "candidate-a")).paper?.abstract).toBe("Saved candidate abstract");
		expect(f.service.board()).toEqual(before);
		expect(await f.library.listPapers()).toHaveLength(3);
		expect(f.service.records.list("analysis")).toHaveLength(0);
		await expect(
			f.service.preview({
				reason: "No candidates",
				operations: [
					{ id: "inject", kind: "add_node", node: { ...paperNode("p0"), id: "new-node", candidateId: "fake" } },
				],
			}),
		).rejects.toThrow("Unsupported canvas node property");
		await graphs.show(value.id, "user");
		expect(graphs.views.list()).toHaveLength(1);
	});
	it("saves independent view state, rejects stale/invalid saves, and preserves state on reopen/copy", async () => {
		const f = await researchFixture(),
			b = f.service.board(),
			graphs = new SearchRunGraphs(f.library, b.id);
		await f.library.saveSearchRun(run());
		await f.library.saveSearchRun(run([], "empty"));
		await graphs.show("graph-run", "user");
		await graphs.show("empty", "user");
		const old = graphs.views.get("graph-run")!;
		const state = {
			...old.state,
			positions: { "candidate-a": { x: 12, y: 34 } },
			viewport: { x: 5, y: 8, scale: 1.5 },
			filters: { query: "Candidate", year: "", batch: "", status: "" },
		};
		expect(graphs.saveState("graph-run", state).revision).toBe(1);
		expect(() => graphs.saveState("graph-run", state)).toThrow("已更新");
		expect(() => graphs.saveState("graph-run", { ...state, viewport: {} as never })).toThrow("格式");
		graphs.views.save({ ...old, closed: true }); // stale close must not overwrite positions
		await graphs.show("graph-run", "user");
		expect(graphs.views.get("graph-run")?.state.positions).toEqual(state.positions);
		expect((await graphs.graph("empty")).nodes).toMatchObject([{ id: "p0", isSeed: true }]);
		expect(f.service.board().revision).toBe(b.revision);
		const copied = f.service.canvases.duplicate(b.id, b.revision)!;
		const copy = new SearchRunGraphs(f.library, copied.id);
		expect(copy.views.list()).toHaveLength(2);
		expect(copy.views.get("graph-run")?.state.filters).toEqual(state.filters);
		f.service.canvases.delete(b.id, b.revision);
		expect(() => graphs.views.list()).toThrow("画布不存在");
		expect(copy.views.list()).toHaveLength(2);
		expect(await f.library.getSearchRun("graph-run")).toBeDefined();
	});
	it("resolves library status by identity and validates optional filter ownership/fingerprint", async () => {
		const f = await researchFixture(),
			graphs = new SearchRunGraphs(f.library, f.service.canvasId);
		const value = run([paper(), { ...f.papers[0], id: "external-id" }]);
		value.results[0] = { ...f.papers[0] };
		await f.library.saveSearchRun(value);
		const filter = await saveFilterResult(dirname(dirname(dirname(f.library.root))), "session-a", {
			version: 2,
			searchRunId: value.id,
			runFingerprint: fingerprintSearchRun(value),
			corpusRoot: f.library.root,
			rules: [],
			sourceCount: 2,
			rootTotal: 2,
			entries: [{ paperId: "external-id", title: "Saved", status: "matched" }],
		});
		await expect(graphs.show(value.id, "other-session", filter)).rejects.toThrow("session");
		await graphs.show(value.id, "session-a", filter);
		expect((await graphs.graph(value.id)).nodes).toMatchObject([{ id: "p0", isSeed: true, libraryPaperId: "p0" }]);
		await f.library.saveSearchRun({ ...value, results: [paper()] });
		await expect(graphs.graph(value.id)).rejects.toThrow("过期");
		await expect(graphs.show("missing", "user")).rejects.toThrow("不存在");
	});
	it("exposes HTTP graph APIs and rejects old candidate/plan writes", async () => {
		const f = await researchFixture(),
			b = f.service.board();
		await f.library.saveSearchRun(run());
		const server = await startLocalWebServer(f.app, { staticRoot: "dist/web" });
		const base = `${server.url}/api/canvases/${b.id}`;
		const post = (path: string, body: unknown) =>
			fetch(`${base}/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		try {
			expect((await post("search-graphs", { searchRunId: "graph-run" })).status).toBe(200);
			expect((await (await fetch(`${base}/search-graphs`)).json()).graphs).toHaveLength(1);
			expect((await (await fetch(`${base}/search-graphs/graph-run/papers/candidate-a`)).json()).paper.abstract).toBe(
				"Saved candidate abstract",
			);
			expect((await fetch(`${base}/search-graphs/graph-run/wrong`)).status).toBe(400);
            const graph = await (await fetch(`${base}/search-graphs/graph-run`)).json();
            expect(graph.edges[0]).not.toHaveProperty("evidence");
            const evidence = await (await fetch(`${base}/search-graphs/graph-run/evidence?edgeId=${encodeURIComponent(graph.edges[0].id)}`)).json();
            expect(evidence).toMatchObject({from:"p0",to:"candidate-a",kind:"citation"});
            expect(evidence.evidence.sources).toContain("openalex");
			expect((await post("graph/proposals", {})).status).toBe(404);
			expect((await post("research/searches", {})).status).toBe(404);
			const r = await fetch(base, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					expectedRevision: b.revision,
					document: { ...b, nodes: [paperNode("candidate-a")] },
				}),
			});
			expect(r.status).toBe(400);
			expect((await post("search-graphs/graph-run/close", {})).status).toBe(200);
			expect((await (await fetch(`${base}/search-graphs`)).json()).graphs[0].closed).toBe(true);
			const graphs = new SearchRunGraphs(f.library, b.id);
			const beforeView = graphs.views.get("graph-run")!;
			const rename = await fetch(`${base}/search-graphs/graph-run`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "My saved graph" }),
			});
			expect(rename.status).toBe(200);
			expect((await post("search-graphs/graph-run/open", {})).status).toBe(200);
			expect(graphs.views.get("graph-run")).toMatchObject({
				title: "My saved graph",
				closed: false,
				state: beforeView.state,
			});
			await graphs.show("graph-run", "user");
			expect(graphs.views.get("graph-run")?.title).toBe("My saved graph");
			const graphNode = { ...paperNode("graph-run"), id: "graph-node", kind: "search_graph" };
			const save = async (entityId: string) =>
				fetch(base, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						expectedRevision: b.revision,
						document: { ...b, nodes: [{ ...graphNode, entityId }], edges: [] },
					}),
				});
			expect((await save("not-owned")).status).toBe(400);
			const added = await save("graph-run");
			expect(added.status).toBe(200);
			const saved = (await added.json()).canvas;
			expect(saved.nodes).toMatchObject([{ id: "graph-node", kind: "search_graph", entityId: "graph-run" }]);
			const copy = f.service.canvases.duplicate(b.id, saved.revision)!;
			expect(copy.nodes[0].entityId).toBe("graph-run");
			expect(new SearchRunGraphs(f.library, copy.id).views.get("graph-run")?.title).toBe("My saved graph");
			expect(await f.library.listPapers()).toHaveLength(3);
		} finally {
			await server.close();
		}
	});
});
