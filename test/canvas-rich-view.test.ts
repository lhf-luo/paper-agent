import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasTextView, canvasTextDocument } from "../web/src/canvas-rich-text.tsx";

describe("canvas rich text preview", () => {
	it("lazily converts a legacy title and multiline body without changing the record", () => {
		const legacy = { title: "旧标题", content: "第一行\n第二行" };
		const converted = canvasTextDocument(legacy);
		expect(converted.content.map((node) => node.type)).toEqual(["heading", "paragraph", "paragraph"]);
		expect(renderToStaticMarkup(createElement(CanvasTextView, { document: converted }))).toContain("第二行");
		expect(legacy).toEqual({ title: "旧标题", content: "第一行\n第二行" });
	});

	it("renders saved formatting, links and a scrollable table wrapper", () => {
		const html = renderToStaticMarkup(
			createElement(CanvasTextView, {
				document: {
					type: "doc",
					content: [
						{
							type: "heading",
							attrs: { level: 2 },
							content: [{ type: "text", text: "标题", marks: [{ type: "bold" }] }],
						},
						{
							type: "paragraph",
							content: [
								{
									type: "text",
									text: "来源",
									marks: [{ type: "link", attrs: { href: "https://example.org" } }],
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
											type: "tableCell",
											attrs: { colspan: 1, rowspan: 1, colwidth: null },
											content: [{ type: "paragraph", content: [{ type: "text", text: "证据" }] }],
										},
									],
								},
							],
						},
					],
				},
			}),
		);
		expect(html).toContain("<h2><strong>标题</strong></h2>");
		expect(html).toContain('href="https://example.org"');
		expect(html).toContain("tableWrapper");
		expect(html).toContain("<td");
	});
});
