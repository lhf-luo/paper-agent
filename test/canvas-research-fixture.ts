import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import type { CanvasMethodCard } from "../src/canvas/domain/canvas-research.ts";
import type { CanvasNode } from "../src/canvas/domain/research-canvas.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
export const paperNode = (id: string, index = 0): CanvasNode => ({
	id: `node-${id}`,
	kind: "paper",
	entityId: id,
	title: `Research paper ${id}`,
	x: index * 300,
	y: 0,
	width: 260,
	height: 145,
});
export async function researchFixture(count = 3) {
	const root = await mkdtemp(join(tmpdir(), "canvas-research-"));
	const app = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, "data") });
	cleanups.push(async () => {
		await app.close();
		await rm(root, { recursive: true, force: true });
	});
	const library = app.personalStore("research");
	await library.initialize();
	const service = new CanvasResearchService(library, "research", "placeholder", "session-a");
	const board = service.canvases.create("研究方式");
	const papers: PaperRecord[] = Array.from({ length: count }, (_, i) => ({
		id: `p${i}`,
		title: `Unique mechanism ${i} in domain ${i}`,
		abstract: i === 1 ? undefined : `Method family ${i % 2}`,
		authors: [`Author ${i}`],
		year: 2020 + (i % 6),
		identifiers: { doi: `10.1234/research-${i}` },
		links: [],
		provenance: [],
		mergedFrom: [],
	}));
	await library.upsertPapers(papers);
	const nodes = papers.map((p, i) => ({ ...paperNode(p.id, i), title: p.title }));
	const agent: CanvasNode = {
		id: "agent-a",
		kind: "agent",
		entityId: "session-a",
		title: "研究助手",
		x: 0,
		y: 300,
		width: 260,
		height: 145,
	};
	service.canvases.update(board.id, board.revision, { ...board, nodes: [...nodes, agent], edges: [] });
	return {
		app,
		root,
		library,
		papers,
		nodes,
		agent,
		service: new CanvasResearchService(library, "research", board.id, "session-a"),
	};
}
export function abstractCard(paperId: string): CanvasMethodCard {
	return {
		paperId,
		family: "形式化规则",
		fields: { 中间表示: "状态机" },
		coverage: "abstract",
		evidence: [{ paperId, level: "abstract" }],
		unknowns: ["验证条件"],
		pagesRead: [],
		sectionsRead: [],
	};
}
export async function methodCard(
	f: Awaited<ReturnType<typeof researchFixture>>,
	paperId: string,
): Promise<CanvasMethodCard> {
	const note = await f.library.createResearchNote({
		title: `Reading ${paperId}`,
		markdown: "Method verified against body",
		paperIds: [paperId],
	});
	return {
		...abstractCard(paperId),
		coverage: "method",
		evidence: [{ paperId, level: "text", noteId: note.id, noteRevision: note.revision }],
		sectionsRead: ["Method"],
	};
}
