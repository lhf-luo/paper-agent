import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/canvas/domain/canvas-document.ts";
import { canvasPaperBatch, loadCanvasCollectionPapers } from "../web/src/canvas-paper-batch.ts";

const paper = (id: string) => ({ id, title: `Paper ${id}` });
const node = (id: string, kind: CanvasNode["kind"] = "text"): CanvasNode => ({
	id,
	kind,
	title: id,
	x: 0,
	y: 0,
	width: 260,
	height: 145,
});

describe("canvas paper batch", () => {
	it("loads every page of a folder independently of the current search", async () => {
		const urls: URL[] = [];
		const result = await loadCanvasCollectionPapers("folder-id", async (path) => {
			const url = new URL(path, "http://localhost");
			urls.push(url);
			const offset = Number(url.searchParams.get("offset"));
			return {
				total: 305,
				hits: Array.from({ length: offset === 0 ? 300 : 5 }, (_, index) => ({
					record: {
						...paper(String(offset + index)),
						authors: [],
						identifiers: {},
						links: [],
						provenance: [],
						mergedFrom: [],
					},
				})),
			};
		});
		expect(result).toHaveLength(305);
		expect(urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "300"]);
		expect(
			urls.every((url) => url.searchParams.get("collection") === "folder-id" && !url.searchParams.has("q")),
		).toBe(true);
	});

	it("distinguishes all papers from uncategorized and refuses an incomplete folder load", async () => {
		for (const collectionId of ["all", "__uncategorized__"]) {
			await loadCanvasCollectionPapers(collectionId, async (path) => {
				expect(new URL(path, "http://localhost").searchParams.get("collection")).toBe(
					collectionId === "all" ? null : collectionId,
				);
				return { total: 0, hits: [] };
			});
		}
		await expect(loadCanvasCollectionPapers("folder", async () => ({ total: 5, hits: [] }))).rejects.toThrow(
			"完整加载",
		);
		await expect(
			loadCanvasCollectionPapers("folder", async () => {
				throw new Error("network failure");
			}),
		).rejects.toThrow("network failure");
	});
	it("builds one batch without mutating the board or overlapping the new cards", () => {
		const canvas = { nodes: [node("existing")], edges: [] };
		const result = canvasPaperBatch(canvas, [paper("a"), paper("b"), paper("c"), paper("d"), paper("a")], {
			x: 500,
			y: 500,
		});
		expect(result.nodes.map((item) => item.entityId)).toEqual(["a", "b", "c", "d"]);
		expect(new Set(result.nodes.map((item) => item.id)).size).toBe(4);
		expect(result.edges).toEqual([]);
		for (const [index, first] of result.nodes.entries()) {
			for (const second of result.nodes.slice(index + 1)) {
				expect(
					first.x + first.width <= second.x ||
						second.x + second.width <= first.x ||
						first.y + first.height <= second.y ||
						second.y + second.height <= first.y,
				).toBe(true);
			}
		}
		expect(canvas.nodes).toHaveLength(1);
	});

	it("preserves a link origin and team relation for every selected paper", () => {
		const canvas = { nodes: [node("team", "team")], edges: [] };
		const result = canvasPaperBatch(canvas, [paper("a"), paper("b")], { x: 10, y: 20 }, { id: "team", side: "left" });
		expect(result.edges).toMatchObject(
			result.nodes.map((item) => ({ from: "team", to: item.id, fromSide: "left", label: "研究成果" })),
		);
		expect(canvasPaperBatch(canvas, [paper("a")], { x: 0, y: 0 }, { id: "deleted", side: "right" }).edges).toEqual(
			[],
		);
	});

	it("rejects an oversized batch before applying any part of it", () => {
		const nodes = Array.from({ length: 499 }, (_, index) => node(`node-${index}`));
		expect(() => canvasPaperBatch({ nodes, edges: [] }, [paper("a"), paper("b")], { x: 0, y: 0 })).toThrow(
			"还可添加 1 篇",
		);
		expect(nodes).toHaveLength(499);
		const edges = Array.from({ length: 999 }, (_, index) => ({ id: `edge-${index}`, from: "a", to: "b", label: "" }));
		expect(() =>
			canvasPaperBatch(
				{ nodes: [node("from")], edges },
				[paper("a"), paper("b")],
				{ x: 0, y: 0 },
				{ id: "from", side: "right" },
			),
		).toThrow("1000 条");
	});

	it("requires a selection and preserves the chosen world-space center", () => {
		expect(() => canvasPaperBatch({ nodes: [], edges: [] }, [], { x: 0, y: 0 })).toThrow("选择论文");
		const result = canvasPaperBatch({ nodes: [], edges: [] }, [paper("a")], { x: 400, y: 300 });
		expect(result.nodes[0]).toMatchObject({
			x: 270,
			y: 227.5,
			width: 260,
			height: 145,
			kind: "paper",
			entityId: "a",
		});
	});
});
