import { describe, expect, it } from "vitest";
import { mozillaPdfViewerUrl } from "../web/src/pdfjs-viewer-url.ts";
import { abstractCard, methodCard, researchFixture } from "./canvas-research-fixture.ts";

describe("research evidence versions and shared round budgets", () => {
	it("charges upgrading reused abstract cards to the reading budget and requires the paper's own evidence", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveSettings({ question: "Research", readingBudget: 1 }, -1);
		await s.saveAnalysis({ cards: [abstractCard("p0"), abstractCard("p1")] });
		const c0 = await methodCard(f, "p0"),
			c1 = await methodCard(f, "p1");
		await expect(s.saveAnalysis({ cards: [c0, c1] })).rejects.toThrow("预算");
		await expect(s.saveAnalysis({ cards: [{ ...c0, evidence: c1.evidence }] })).rejects.toThrow("本身");
		const run = await s.saveAnalysis({ cards: [c0] });
		expect(run.value.newlyReadPaperIds).toEqual(["p0"]);
		expect(run.value.reusedPaperIds).toContain("p0");
	});
	it("invalidates PDF evidence when its current version changes", async () => {
		const f = await researchFixture(),
			s = f.service;
		s.saveSettings({ question: "Research" }, -1);
		const body = Buffer.from("%PDF-1.7\nfixture first version"),
			blob = await f.library.putBlob(body);
		await f.library.savePaperVersion({
			paperId: "p0",
			sourceUrl: "fixture",
			finalUrl: "fixture",
			retrievedAt: new Date().toISOString(),
			sha256: blob.sha256,
			blobPath: blob.path,
			bytes: body.length,
			contentType: "application/pdf",
			isPreferred: true,
		});
		const c = await methodCard(f, "p0");
		c.evidence = [{ paperId: "p0", level: "pdf", sourceSha256: blob.sha256, page: 2 }];
		const run = await s.saveAnalysis({ cards: [c] });
		const proposal = await s.layoutProposal("methods", run.id, "Layout");
		await f.library.deletePaperVersion("p0", blob.sha256);
		expect((await s.analysis(run.id)).freshness).toBe("stale");
		await expect(
			s.apply(
				proposal.id,
				proposal.value.operations.map((op) => op.id),
				s.board().revision,
			),
		).rejects.toThrow("证据");
		const next = await s.saveAnalysis({});
		expect(next.value.reusedPaperIds).not.toContain("p0");
	});
	it("keeps unused notes from invalidating cards and charges new analyses to the same active round", async () => {
		const f = await researchFixture(),
			s = f.service;
		const c0 = await methodCard(f, "p0"),
			c1 = await methodCard(f, "p1");
		s.saveSettings({ question: "Research", readingBudget: 1 }, -1);
		s.beginRound();
		const run = await s.saveAnalysis({ cards: [c0] });
		await f.library.createResearchNote({ title: "Unreferenced note", markdown: "New idea", paperIds: ["p0"] });
		expect((await s.analysis(run.id)).freshness).toBe("current");
		await expect(s.saveAnalysis({ cards: [c1] })).rejects.toThrow("预算");
		s.beginRound();
		const next = await s.saveAnalysis({ cards: [c1] });
		expect(next.value.reusedPaperIds).toContain("p0");
		expect(next.value.newlyReadPaperIds).toEqual(["p1"]);
	});
	it("preserves exact PDF page navigation and rejects malformed page fragments", () => {
		const url = mozillaPdfViewerUrl("/api/papers/p/pdf/sha?namespace=n#page=7", "http://localhost");
		expect(url).toContain("#page=7&zoom=page-width");
		expect(url).not.toContain("%23page");
		expect(mozillaPdfViewerUrl("/paper.pdf#page=-2", "http://localhost")).toContain("#page=1");
	});
});
