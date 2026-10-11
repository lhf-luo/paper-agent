import { describe, expect, it } from "vitest";
import { canvasRichPlainText, parseCanvasRichContent } from "../src/canvas/domain/canvas-rich-content.ts";
import { validateCanvasDocument } from "../src/canvas/domain/research-canvas.ts";

const textNode = {
	id: "text-1",
	kind: "text",
	x: 0,
	y: 0,
	width: 280,
	height: 170,
	title: "旧文字",
	content: "旧正文",
};
const board = (node: unknown) => ({
	title: "测试画布",
	nodes: [node],
	edges: [],
	viewport: { x: 0, y: 0, scale: 1 },
});

describe("canvas rich text", () => {
	it("keeps legacy plain text unchanged and accepts formatted content with tables", () => {
		expect(validateCanvasDocument(board(textNode)).nodes[0]).toEqual(textNode);
		const richContent = parseCanvasRichContent({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "text", text: "研究想法", marks: [{ type: "bold" }] }],
				},
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "论文",
							marks: [{ type: "link", attrs: { href: "https://example.org/paper" } }],
						},
						{ type: "text", text: "很有用", marks: [{ type: "italic" }, { type: "underline" }] },
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
									attrs: { colspan: 1, rowspan: 1, colwidth: null },
									content: [{ type: "paragraph", content: [{ type: "text", text: "方法" }] }],
								},
								{
									type: "tableCell",
									attrs: { colspan: 1, rowspan: 1, colwidth: null },
									content: [{ type: "paragraph", content: [{ type: "text", text: "证据" }] }],
								},
							],
						},
					],
				},
			],
		});
		expect(validateCanvasDocument(board({ ...textNode, richContent })).nodes[0]?.richContent).toEqual(richContent);
		expect(canvasRichPlainText(richContent)).toContain("研究想法\n论文很有用\n方法\t证据");
	});

	it("rejects unsafe links and unsupported or oversized content", () => {
		const content = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
					],
				},
			],
		};
		expect(() => validateCanvasDocument(board({ ...textNode, richContent: content }))).toThrow("Invalid link URL");
		expect(() => parseCanvasRichContent({ type: "doc", content: [{ type: "script", text: "bad" }] })).toThrow();
		expect(() =>
			parseCanvasRichContent({
				type: "doc",
				content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(21_001) }] }],
			}),
		).toThrow("21000");
	});

	it("accepts an author profile link and rejects dangerous protocols", () => {
		const author = {
			...textNode,
			kind: "author",
			authorDetails: {
				researchArea: "程序分析",
				organization: "大学",
				profileUrl: "https://example.org/author",
			},
		};
		expect(validateCanvasDocument(board(author)).nodes[0]?.authorDetails?.profileUrl).toBe(
			author.authorDetails.profileUrl,
		);
		expect(() =>
			validateCanvasDocument(
				board({
					...author,
					authorDetails: {
						...author.authorDetails,
						profileUrl: "data:text/html,test",
					},
				}),
			),
		).toThrow("Invalid author details");
	});
});
