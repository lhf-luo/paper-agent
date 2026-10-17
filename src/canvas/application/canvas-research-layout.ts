import { randomUUID } from "node:crypto";
import type { CanvasChangeOperation, CanvasMethodCard, CanvasResearchAnalysis } from "../domain/canvas-research.ts";
import type { CanvasNode, ResearchCanvas } from "../domain/research-canvas.ts";

export type ResearchLayout = "methods" | "timeline" | "evidence";
type Rect = Pick<CanvasNode, "x" | "y" | "width" | "height">;
interface LayoutContext {
	mode: ResearchLayout;
	analysisId: string;
	cards: Map<string, CanvasMethodCard>;
	years: Map<string, number | undefined>;
	yearList: number[];
	obstacles: Rect[];
}
function overlaps(a: Rect, b: Rect) {
	return (
		a.x < b.x + b.width + 24 && a.x + a.width + 24 > b.x && a.y < b.y + b.height + 24 && a.y + a.height + 24 > b.y
	);
}
function placeMember(
	c: LayoutContext,
	members: CanvasNode[],
	index: number,
	x: number,
	y: number,
	width: number,
	height: number,
): Rect {
	const n = members[index],
		year = c.years.get(n.entityId!) ?? 0;
	const column = c.mode === "timeline" ? c.yearList.indexOf(year) : index % 2;
	const row =
		c.mode === "timeline"
			? members.slice(0, index).filter((m) => (c.years.get(m.entityId!) ?? 0) === year).length
			: Math.floor(index / 2);
	const rect = {
		x: x + 24 + column * (width + 50),
		y: y + (c.mode === "timeline" ? 270 : 210) + row * (height + 50),
		width: n.width,
		height: n.height,
	};
	let attempts = 0;
	while (c.obstacles.some((r) => overlaps(rect, r)) && attempts++ < 500) rect.y += height + 50;
	if (attempts > 500) throw new Error("无法避让固定节点，请先手动调整布局");
	c.obstacles.push(rect);
	return rect;
}
function familySummary(c: LayoutContext, members: CanvasNode[]) {
	return members
		.map((n) => {
			const card = c.cards.get(n.entityId!);
			return `${n.title}\n${
				card
					? Object.entries(card.fields)
							.slice(0, 3)
							.map(([k, v]) => `${k}：${v}`)
							.join("\n")
					: "尚未取证"
			}`;
		})
		.join("\n\n");
}
function placeFamily(c: LayoutContext, family: string, members: CanvasNode[], x: number, y: number) {
	const groupId = randomUUID(),
		groupOpId = randomUUID(),
		placed: Rect[] = [],
		operations: CanvasChangeOperation[] = [];
	const maxWidth = Math.max(300, ...members.map((n) => n.width)),
		maxHeight = Math.max(180, ...members.map((n) => n.height));
	for (let index = 0; index < members.length; index++) {
		const n = members[index];
		if (n.pinned) continue;
		const rect = placeMember(c, members, index, x, y, maxWidth, maxHeight);
		placed.push(rect);
		operations.push({
			id: randomUUID(),
			kind: "move_node",
			nodeId: n.id,
			x: rect.x,
			y: rect.y,
			groupId,
			dependsOn: [groupOpId],
		});
	}
	const summary = summaryNode(family, familySummary(c, members), x + 24, y + 40, c.analysisId);
	summary.node.groupId = groupId;
	summary.dependsOn = [groupOpId];
	if (c.mode === "timeline")
		for (const [i, year] of c.yearList.entries()) {
			const header = summaryNode(
				year ? String(year) : "年份未知",
				"",
				x + 24 + i * (maxWidth + 50),
				y + 210,
				c.analysisId,
			);
			header.node.width = maxWidth;
			header.node.height = 40;
			header.node.groupId = groupId;
			header.dependsOn = [groupOpId];
			operations.push(header);
		}
	const width = Math.max(
		maxWidth * 2 + 100,
		c.mode === "timeline" ? c.yearList.length * (maxWidth + 50) : 0,
		...placed.map((r) => r.x + r.width - x + 24),
	);
	const height = Math.max(440, ...placed.map((r) => r.y + r.height - y + 24));
	operations.push(
		{ id: groupOpId, kind: "upsert_group", group: { id: groupId, title: family, x, y, width, height } },
		summary,
	);
	return { operations, width, height };
}
/** Stable sorting and dimensions determine placement; only operation IDs are random. */
export function researchLayout(
	board: ResearchCanvas,
	analysis: CanvasResearchAnalysis,
	analysisId: string,
	mode: ResearchLayout,
	years: Map<string, number | undefined>,
): CanvasChangeOperation[] {
	const nodes = board.nodes.filter((n) => analysis.nodeIds.includes(n.id) && n.kind === "paper");
	const c: LayoutContext = {
		mode,
		analysisId,
		cards: new Map(analysis.cards.map((card) => [card.paperId, card])),
		years,
		yearList: [...new Set(nodes.map((n) => years.get(n.entityId!) ?? 0))].sort((a, b) => a - b),
		obstacles: board.nodes.filter((n) => n.pinned || !nodes.includes(n)),
	};
	const families = [...new Set(nodes.map((n) => c.cards.get(n.entityId!)?.family ?? "待分类"))].sort();
	const originX = Math.min(0, ...board.nodes.map((n) => n.x)),
		originY =
			Math.max(0, ...board.nodes.map((n) => n.y + n.height), ...(board.groups ?? []).map((g) => g.y + g.height)) +
			100;
	let x = originX + (mode === "evidence" ? 440 : 0),
		y = originY,
		rowHeight = 0;
	const operations: CanvasChangeOperation[] = [];
	if (mode === "evidence")
		operations.push(summaryNode("研究问题", analysis.settings.question, originX, originY, analysisId));
	for (const [index, family] of families.entries()) {
		const members = nodes
			.filter((n) => (c.cards.get(n.entityId!)?.family ?? "待分类") === family)
			.sort(
				(a, b) => (years.get(a.entityId!) ?? 0) - (years.get(b.entityId!) ?? 0) || a.title.localeCompare(b.title),
			);
		const placed = placeFamily(c, family, members, x, y);
		operations.push(...placed.operations);
		rowHeight = Math.max(rowHeight, placed.height);
		if (mode === "methods" && (index + 1) % 4 !== 0) x += placed.width + 80;
		else {
			y += rowHeight + 80;
			rowHeight = 0;
			x = originX + (mode === "evidence" ? 440 : 0);
		}
	}
	if (mode === "evidence") {
		const right = Math.max(
			originX + 1300,
			...operations.flatMap((op) => (op.kind === "upsert_group" ? [op.group.x + op.group.width + 80] : [])),
		);
		operations.push(
			summaryNode(
				"证据与局限",
				analysis.gaps.map((g) => `${g.kind}：${g.description}`).join("\n\n") || analysis.summary,
				right,
				originY,
				analysisId,
			),
		);
	}
	return operations;
}
function summaryNode(
	title: string,
	content: string,
	x: number,
	y: number,
	analysisId: string,
): Extract<CanvasChangeOperation, { kind: "add_node" }> {
	return {
		id: randomUUID(),
		kind: "add_node",
		node: {
			id: randomUUID(),
			kind: "text",
			title: title.slice(0, 300),
			content: content.slice(0, 20000),
			x,
			y,
			width: 360,
			height: 145,
			generatedFrom: { analysisId },
		},
	};
}
