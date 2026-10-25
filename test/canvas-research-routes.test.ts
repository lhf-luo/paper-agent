import { describe, expect, it } from "vitest";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { abstractCard, researchFixture } from "./canvas-research-fixture.ts";

describe("canvas research HTTP endpoints", () => {
	it("shares settings, pages analyses, applies previews, streams revisions and closes SSE on shutdown", async () => {
		const f = await researchFixture(),
			s = f.service;
		const server = await startLocalWebServer(f.app, { staticRoot: "dist/web" });
		const base = `${server.url}/api/canvases/${s.canvasId}/research`;
		const request = async (path: string, method = "GET", body?: unknown) => {
			const r = await fetch(`${base}/${path}`, {
				method,
				...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
			return { status: r.status, data: (await r.json()) as Record<string, any> };
		};
		try {
			expect((await request("settings")).data.revision).toBe(-1);
			expect(
				(await request("settings", "PATCH", { settings: { question: "Research" }, expectedRevision: -1 })).status,
			).toBe(200);
			expect((await request("settings", "PATCH", { settings: {}, expectedRevision: -1 })).status).toBe(409);
			const analysis = (
				await request("analyses", "POST", {
					content: { cards: f.papers.map((p) => abstractCard(p.id)), status: "completed" },
				})
			).data;
			const projection = (await request(`analyses?id=${analysis.id}&limit=1`)).data;
			expect(projection.totalCards).toBe(3);
			expect(projection.coverage).toEqual({ unread: 0, abstract: 3, method: 0, full: 0 });
			expect(projection.value.cards).toHaveLength(1);
			expect(projection.nextOffset).toBe(1);
			const p = (
				await request("proposals", "POST", { reason: "Layout", analysisId: analysis.id, layout: "methods" })
			).data;
			const result = await request(`proposals/${p.id}/apply`, "POST", {
				selectedIds: p.value.operations.map((op: { id: string }) => op.id),
				expectedRevision: s.board().revision,
			});
			expect(result.status).toBe(200);
			expect(result.data.canvas.groups).toHaveLength(1);
			expect((await request("proposals")).data.proposals[0].value.before).toBeUndefined();
			const wrongNamespace = await fetch(`${base}/settings`);
			expect(wrongNamespace.status).toBe(200);
			const abort = new AbortController();
			const events = await fetch(`${base}/events`, { signal: abort.signal });
			const reader = events.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(s.canvasId);
			await request("settings", "PATCH", { settings: { question: "Changed" }, expectedRevision: 0 });
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(s.canvasId);
			await server.close();
			await reader.cancel();
			abort.abort();
		} finally {
			await server.close();
		}
	});
});
