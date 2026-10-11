import { describe, expect, it } from "vitest";
import {
	type CanvasAgentNode,
	canvasTextMarkdown,
	composeCanvasNodeMessage,
	connectedCanvasAgentNodes,
	resolveCanvasAgentSelection,
} from "../web/src/canvas-agent-nodes.ts";

const agent: CanvasAgentNode = { id: "agent", kind: "agent", title: "会话", entityId: "session-1" };
const paper: CanvasAgentNode = { id: "paper", kind: "paper", title: "旧标题", alias: "AnyPoC", entityId: "paper-1" };
const note: CanvasAgentNode = { id: "note", kind: "note", title: "笔记", entityId: "note-1" };
const author: CanvasAgentNode = {
	id: "author",
	kind: "author",
	title: "Alice",
	authorDetails: { researchArea: "静态分析", organization: "UIUC" },
};
const team: CanvasAgentNode = {
	id: "team",
	kind: "team",
	title: "软件工程团队",
	teamDetails: {
		institution: "UIUC",
		leaderName: "",
		researchAreas: "程序分析",
		members: ["Bob"],
	},
};

describe("canvas Agent node material", () => {
	it("only offers unique direct neighbors in either edge direction and marks missing sources", () => {
		const candidates = connectedCanvasAgentNodes({
			nodes: [agent, paper, note, author, team, { id: "remote", kind: "text", title: "间接文本" }],
			edges: [
				{ from: "agent", to: "paper", label: "" },
				{ from: "paper", to: "agent", label: "" },
				{ from: "note", to: "agent", label: "" },
				{ from: "agent", to: "team", label: "" },
				{ from: "author", to: "team", label: "负责人" },
				{ from: "team", to: "remote", label: "" },
			],
			sessionId: "session-1",
			namespace: "lab",
			papers: new Map([["paper-1", { title: "AnyPoC 论文" }]]),
			notes: new Map(),
		});
		expect(candidates.map((item) => item.id)).toEqual(["paper", "note", "team"]);
		expect(candidates[0]).toMatchObject({ title: "AnyPoC 论文", caption: "AnyPoC", available: true });
		expect(candidates[1]?.available).toBe(false);
		expect(candidates[2]?.teamLeaders).toBe("Alice");
		expect(candidates[2]?.teamMembers).toEqual(["Alice", "Bob"]);
		expect(() => resolveCanvasAgentSelection([{ id: "note", title: "笔记" }], candidates)).toThrow("找不到来源记录");
		expect(() => resolveCanvasAgentSelection([{ id: "remote", title: "间接文本" }], candidates)).toThrow("断开连线");
		expect(resolveCanvasAgentSelection([{ id: "paper", title: "旧标题" }], candidates)).toEqual([candidates[0]]);
	});

	it("builds exact personal-library references and current card values without uploading their content", () => {
		const candidates = connectedCanvasAgentNodes({
			nodes: [agent, paper, note, author, team],
			edges: [
				{ from: "agent", to: "paper", label: "" },
				{ from: "agent", to: "note", label: "" },
				{ from: "agent", to: "author", label: "" },
				{ from: "agent", to: "team", label: "" },
				{ from: "author", to: "team", label: "负责人" },
			],
			sessionId: "session-1",
			namespace: "lab",
			papers: new Map([["paper-1", { title: "AnyPoC 论文" }]]),
			notes: new Map([["note-1", { title: "阅读笔记" }]]),
		});
		const message = composeCanvasNodeMessage("比较这些材料", candidates, new Map());
		expect(message).toContain('paper_id="paper-1"');
		expect(message).toContain('note_id="note-1"');
		expect(message).toContain('namespace="lab"');
		expect(message).toContain('姓名="Alice"');
		expect(message).toContain('负责人／PI="Alice"');
		expect(message).toContain('团队成员=["Alice","Bob"]');
		expect(message).not.toContain("旧标题");
	});

	it("serializes rich text formatting and merged tables for Markdown attachments", () => {
		const markdown = canvasTextMarkdown({
			id: "text",
			kind: "text",
			title: "旧标题",
			richContent: {
				type: "doc",
				content: [
					{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "方法" }] },
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "关键", marks: [{ type: "bold" }, { type: "underline" }] },
							{
								type: "text",
								text: "证据",
								marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.org/paper" } }],
							},
						],
					},
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{
										type: "tableHeader",
										attrs: { colspan: 2, rowspan: 1 },
										content: [{ type: "paragraph", content: [{ type: "text", text: "结果" }] }],
									},
								],
							},
						],
					},
				],
			},
		});
		expect(markdown).toContain("## 方法");
		expect(markdown).toContain("<u><strong>关键</strong></u>");
		expect(markdown).toContain("[*证据*](<https://example.org/paper>)");
		expect(markdown).toContain('<th colspan="2">');
		expect(markdown).not.toContain("旧标题");
	});

	it("upgrades legacy text into Markdown without losing its body", () => {
		expect(canvasTextMarkdown({ id: "text", kind: "text", title: "旧标题", content: "第一行\n第二行" })).toBe(
			"### 旧标题\n\n第一行\n\n第二行\n",
		);
	});
});
