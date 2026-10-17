import { createHash } from "node:crypto";
import { readMineruMaterial } from "../../extensions/mineru/application/mineru-reader.ts";
import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import type { CanvasEvidence, CanvasResearchContext } from "../domain/canvas-research.ts";
import type { ResearchCanvas } from "../domain/research-canvas.ts";

export const researchHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function scopedNodes(board: ResearchCanvas, scope: CanvasResearchContext, sessionId?: string) {
	if (scope.scope === "canvas") return board.nodes;
	if (scope.scope === "selected") {
		for (const id of scope.selectedNodeIds)
			if (!board.nodes.some((n) => n.id === id)) throw new Error(`选中节点已删除：${id}`);
		if (!scope.selectedNodeIds.length) throw new Error("请选择研究节点");
		return board.nodes.filter((n) => scope.selectedNodeIds.includes(n.id));
	}
	const anchor = board.nodes.find(
		(n) => n.id === scope.agentNodeId && n.kind === "agent" && (!sessionId || n.entityId === sessionId),
	);
	if (!anchor) throw new Error("请从当前会话的 Agent 卡片选择直接邻居范围");
	const ids = new Set(
		board.edges.flatMap((e) => (e.from === anchor.id ? [e.to] : e.to === anchor.id ? [e.from] : [])),
	);
	return board.nodes.filter((n) => ids.has(n.id));
}
export async function paperSource(store: LiteratureStore, paperId: string) {
	const [paper, versions, material, notes] = await Promise.all([
		store.getPaper(paperId),
		store.listPaperVersions(paperId),
		store.getPdfMaterial(paperId),
		store.listResearchNotes(undefined, paperId),
	]);
	const preferred = versions.find((v) => v.isPreferred) ?? versions[0];
	const currentMaterial = material && preferred?.sha256 === material.sourceSha256 ? material : undefined;
	const hash = researchHash([
		paper
			? [
					paper.id,
					paper.title,
					paper.abstract,
					paper.authors,
					paper.year,
					paper.identifiers,
					paper.curation?.detailFields,
				]
			: null,
		preferred?.sha256,
		currentMaterial?.contentSha256,
	]);
	return {
		paper,
		preferred,
		material: currentMaterial,
		notes,
		hash,
		staleMaterial: Boolean(material && !currentMaterial),
	};
}
export async function researchSources(store: LiteratureStore, paperIds: string[]) {
	return (await researchPaperIndex(store, paperIds)).hashes;
}
export async function researchPaperIndex(store: LiteratureStore, paperIds: string[]) {
	const sources: Record<string, string> = {};
	const canonicalIds: Record<string, string> = {};
	// Bound concurrent I/O and avoid reading any PDF or material body during inventory.
	for (let i = 0; i < paperIds.length; i += 8) {
		const batch = await Promise.all(
			paperIds.slice(i, i + 8).map(async (id) => [id, await paperSource(store, id)] as const),
		);
		for (const [id, source] of batch) {
			sources[id] = source.hash;
			canonicalIds[id] = source.paper?.id ?? id;
		}
	}
	return { hashes: sources, canonicalIds };
}
export async function checkEvidence(
	store: LiteratureStore,
	evidence: CanvasEvidence[],
	paperIds: string[],
	cache = new Map<string, ReturnType<typeof paperSource>>(),
) {
	for (const entry of evidence) {
		if (!paperIds.includes(entry.paperId)) throw new Error("证据论文不在本轮研究范围");
		let sourcePromise = cache.get(entry.paperId);
		if (!sourcePromise) {
			sourcePromise = paperSource(store, entry.paperId);
			cache.set(entry.paperId, sourcePromise);
		}
		const source = await sourcePromise;
		if (!source.paper) throw new Error("证据论文已删除");
		if (entry.sourceSha256 && source.preferred?.sha256 !== entry.sourceSha256)
			throw new Error("证据 PDF 版本已变化，请重新核验");
		if (entry.page && source.material && entry.page > source.material.pageCount)
			throw new Error("证据页码超出论文范围");
		if (entry.noteId && !source.notes.some((n) => n.id === entry.noteId && n.revision === entry.noteRevision))
			throw new Error("证据笔记版本不匹配");
	}
}
export async function searchResearchMaterials(store: LiteratureStore, ids: string[], queries: string[]) {
	const result: Array<Record<string, unknown>> = [];
	for (const paperId of ids) {
		const source = await paperSource(store, paperId);
		const notes = [];
		for (const note of source.notes) {
			const full = await store.getResearchNote(note.id);
			const lines =
				full?.markdown
					.split("\n")
					.flatMap((line, index) =>
						queries.some((q) => line.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
							? [{ line: index + 1, text: line.slice(0, 2000) }]
							: [],
					) ?? [];
			if (lines.length)
				notes.push({
					noteId: note.id,
					revision: note.revision,
					matches: lines.slice(0, 10),
					truncated: lines.length > 10,
				});
		}
		try {
			const material = source.material
				? await readMineruMaterial(source.material, {
						mode: "search",
						queries,
						maxMatches: 10,
						maxCharacters: 6000,
					})
				: undefined;
			result.push({
				paperId,
				title: source.paper?.title,
				sourceSha256: source.preferred?.sha256,
				notes,
				material: material
					? {
							text: material.body,
							pages: material.selectedPages,
							truncated: material.truncated,
							nextCursor: material.nextCursor,
						}
					: undefined,
				unavailable: material ? undefined : source.staleMaterial ? "MinerU 材料过期" : "无当前 MinerU 正文",
				abstract: !material ? source.paper?.abstract : undefined,
			});
		} catch (error) {
			result.push({ paperId, notes, unavailable: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
export function paperMetadata(paper?: PaperRecord) {
	return paper
		? {
				id: paper.id,
				title: paper.title,
				abstract: paper.abstract,
				authors: paper.authors,
				year: paper.year,
				identifiers: paper.identifiers,
			}
		: undefined;
}
