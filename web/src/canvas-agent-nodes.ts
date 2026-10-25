import type { CanvasRichContent, CanvasRichNode } from "../../src/canvas/domain/canvas-rich-content.js";
import { getTeamLeaderNames, getTeamMemberNames } from "../../src/canvas/domain/canvas-team.js";
import { canvasTextDocument } from "./canvas-rich-text.js";

export type CanvasAgentNodeKind = "paper" | "note" | "text" | "author" | "team" | "agent" | "search_graph";

export interface CanvasAgentNode {
	id: string;
	kind: CanvasAgentNodeKind;
	title: string;
	alias?: string;
	entityId?: string;
	content?: string;
	richContent?: CanvasRichContent;
	authorDetails?: { researchArea: string; organization: string; profileUrl?: string };
	teamDetails?: {
		institution: string;
		leaderName: string;
		researchAreas: string;
		homepageUrl?: string;
		members?: string[];
	};
}

export interface CanvasAgentNodeCandidate {
	id: string;
	kind: Exclude<CanvasAgentNodeKind, "agent">;
	title: string;
	caption: string;

	available: boolean;
	unavailableReason?: string;
	node: CanvasAgentNode;
	teamLeaders?: string;
	teamMembers?: string[];
}

export const canvasAgentKindLabels: Record<CanvasAgentNodeCandidate["kind"], string> = {
	paper: "论文",
	note: "笔记",
	text: "文本",
	author: "作者",
	team: "团队",
 search_graph: "搜索图谱",
};

export function resolveCanvasAgentSelection(
	selection: Array<{ id: string; title: string }>,
	candidates: CanvasAgentNodeCandidate[],
): CanvasAgentNodeCandidate[] {
	return selection.map((item) => {
		const candidate = candidates.find((entry) => entry.id === item.id);
		if (!candidate) throw new Error(`节点「${item.title}」已删除或与当前 Agent 断开连线，请移除后重试。`);
		if (!candidate.available)
			throw new Error(`节点「${candidate.title}」${candidate.unavailableReason ?? "无法使用"}，请移除后重试。`);
		return candidate;
	});
}

export function connectedCanvasAgentNodes(input: {
	nodes: CanvasAgentNode[];
	edges: Array<{ from: string; to: string; label: string }>;
	sessionId: string;

	papers: ReadonlyMap<string, { title: string }>;
	notes: ReadonlyMap<string, { title: string }>;
}): CanvasAgentNodeCandidate[] {
	const agent = input.nodes.find((node) => node.kind === "agent" && node.entityId === input.sessionId);
	if (!agent) return [];
	const neighborIds = new Set<string>();
	for (const edge of input.edges) {
		if (edge.from === agent.id) neighborIds.add(edge.to);
		if (edge.to === agent.id) neighborIds.add(edge.from);
	}
	return input.nodes.flatMap((node) => {
		if (!neighborIds.has(node.id) || node.kind === "agent") return [];
		const source =
			node.kind === "paper"
				? input.papers.get(node.entityId ?? "")
				: node.kind === "note"
					? input.notes.get(node.entityId ?? "")
					: undefined;
		const needsSource = node.kind === "paper" || node.kind === "note";
		return [
			{
				id: node.id,
				kind: node.kind,
				title: source?.title ?? node.title,
				caption: node.alias?.trim() || canvasAgentKindLabels[node.kind],

				available: !needsSource || Boolean(node.entityId && source),
				...(needsSource && !source ? { unavailableReason: "个人库中已找不到来源记录" } : {}),
				node,
				...(node.kind === "team"
					? {
							teamLeaders: getTeamLeaderNames(input.nodes, input.edges, node.id),
							teamMembers: getTeamMemberNames(
								input.nodes,
								input.edges,
								node.id,
								node.teamDetails?.members ?? [],
								node.teamDetails?.leaderName ?? "",
							),
						}
					: {}),
			},
		];
	});
}

function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_{}[\]<>|])/g, "\\$1").replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(node: CanvasRichNode, html = false): string {
	if (node.type === "hardBreak") return html ? "<br>" : "  \n";
	if (node.type !== "text") return (node.content ?? []).map((child) => inline(child, html)).join("");
	const htmlFormatting = html || Boolean(node.marks?.some((mark) => mark.type === "underline"));
	let result = htmlFormatting ? escapeHtml(node.text ?? "") : escapeMarkdown(node.text ?? "");
	for (const mark of node.marks ?? []) {
		if (mark.type === "bold") result = htmlFormatting ? `<strong>${result}</strong>` : `**${result}**`;
		if (mark.type === "italic") result = htmlFormatting ? `<em>${result}</em>` : `*${result}*`;
		if (mark.type === "underline") result = `<u>${result}</u>`;
		if (mark.type === "link" && typeof mark.attrs?.href === "string") {
			const url = mark.attrs.href;
			result = html
				? `<a href="${escapeHtml(url)}">${result}</a>`
				: `[${result}](<${url.replace(/>/g, "%3E").replace(/</g, "%3C")}>)`;
		}
	}
	return result;
}

function cellText(cell: CanvasRichNode, html = false): string {
	return (cell.content ?? [])
		.map((block) => {
			const value = (block.content ?? []).map((child) => inline(child, html)).join("");
			if (!html) return value;
			return block.type === "heading"
				? `<h${block.attrs?.level ?? 3}>${value}</h${block.attrs?.level ?? 3}>`
				: `<p>${value}</p>`;
		})
		.join(html ? "" : "<br>");
}

function tableMarkdown(table: CanvasRichNode): string {
	const rows = (table.content ?? []).map((row) => row.content ?? []);
	const hasSpan = rows.some((row) =>
		row.some((cell) => Number(cell.attrs?.colspan ?? 1) > 1 || Number(cell.attrs?.rowspan ?? 1) > 1),
	);
	const mixedHeader = rows.some((row) => row.some((cell) => cell.type !== row[0]?.type));
	if (hasSpan || mixedHeader) {
		return `<table>\n${rows
			.map(
				(row) =>
					`<tr>${row
						.map((cell) => {
							const tag = cell.type === "tableHeader" ? "th" : "td";
							const colspan = Number(cell.attrs?.colspan ?? 1);
							const rowspan = Number(cell.attrs?.rowspan ?? 1);
							return `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}>${cellText(cell, true)}</${tag}>`;
						})
						.join("")}</tr>`,
			)
			.join("\n")}\n</table>`;
	}
	const width = Math.max(1, ...rows.map((row) => row.length));
	const lines = rows.map(
		(row) =>
			`| ${Array.from({ length: width }, (_, index) => cellText(row[index] ?? { type: "tableCell" })).join(" | ")} |`,
	);
	lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
	return lines.join("\n");
}

export function canvasTextMarkdown(node: CanvasAgentNode): string {
	const document = canvasTextDocument(node);
	return `${document.content
		.map((block) => {
			if (block.type === "table") return tableMarkdown(block);
			const content = (block.content ?? []).map((child) => inline(child)).join("");
			return block.type === "heading" ? `${"#".repeat(Number(block.attrs?.level ?? 3))} ${content}` : content;
		})
		.join("\n\n")
		.trim()}\n`;
}

export function canvasNodeAttachmentName(nodeId: string): string {
	return `canvas-text-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
}

export function composeCanvasNodeMessage(
	task: string,
	nodes: CanvasAgentNodeCandidate[],
	textAttachments: ReadonlyMap<string, string>,
): string {
	if (!nodes.length) return task;
	const lines = nodes.map((candidate) => {
		const { node, title } = candidate;
		if (node.kind === "paper")
			return `- 个人库论文：${JSON.stringify(title)}；paper_id=${JSON.stringify(node.entityId)}。需要内容时使用 get_personal_library_paper 查询。`;
		if (node.kind === "search_graph")
 return `- 搜索图谱：${JSON.stringify(title)}；search_run_id=${JSON.stringify(node.entityId)}。引用整份搜索结果，不是个人库论文 ID；使用搜索结果工具按需读取。`;
		if (node.kind === "note")
			return `- 个人库笔记：${JSON.stringify(title)}；note_id=${JSON.stringify(node.entityId)}。需要内容时使用 search_research_notes 查询。`;
		if (node.kind === "text")
			return `- 画布文本：${JSON.stringify(title)}；内容见附件 ${JSON.stringify(textAttachments.get(node.id) ?? canvasNodeAttachmentName(node.id))}。`;
		if (node.kind === "author") {
			const details = node.authorDetails;
			return `- 画布作者卡片：姓名=${JSON.stringify(title)}；研究领域=${JSON.stringify(details?.researchArea ?? "")}；所属组织=${JSON.stringify(details?.organization ?? "")}；姓名链接=${JSON.stringify(details?.profileUrl ?? "")}。`;
		}
		const details = node.teamDetails;
		return `- 画布团队卡片：名称=${JSON.stringify(title)}；所属机构=${JSON.stringify(details?.institution ?? "")}；负责人／PI=${JSON.stringify(candidate.teamLeaders || details?.leaderName || "")}；研究方向=${JSON.stringify(details?.researchAreas ?? "")}；团队成员=${JSON.stringify(candidate.teamMembers ?? [])}；团队主页=${JSON.stringify(details?.homepageUrl ?? "")}；简介=${JSON.stringify(node.content ?? "")}。`;
	});
	return `${task.trim()}\n\n[画布节点材料]\n以下材料来自用户选中的画布节点；个人库论文和笔记请按需使用工具读取，卡片文字请按画布记录理解。\n${lines.join("\n")}`;
}
