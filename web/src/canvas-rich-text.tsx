import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { renderToReactElement } from "@tiptap/static-renderer/pm/react";
import type { CanvasRichContent, CanvasRichNode } from "../../src/canvas/domain/canvas-rich-content.js";

export const canvasTextExtensions = [
	StarterKit.configure({
		heading: { levels: [1, 2, 3] },
		link: { openOnClick: false, autolink: false, linkOnPaste: false },
		blockquote: false,
		bulletList: false,
		code: false,
		codeBlock: false,
		horizontalRule: false,
		orderedList: false,
		strike: false,
	}),
	TableKit.configure({ table: { renderWrapper: true, resizable: false } }),
];

function paragraph(text: string): CanvasRichNode {
	return { type: "paragraph", content: text ? [{ type: "text", text }] : [] };
}

export function canvasTextDocument(node: {
	title: string;
	content?: string;
	richContent?: CanvasRichContent;
}): CanvasRichContent {
	if (node.richContent) return node.richContent;
	return {
		type: "doc",
		content: [
			...(node.title
				? [{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: node.title }] }]
				: []),
			...(node.content ? node.content.split("\n").map(paragraph) : []),
			...(!node.title && !node.content ? [paragraph("")] : []),
		],
	};
}

export function CanvasTextView({ document }: { document: CanvasRichContent }) {
	return (
		<div
			className="research-canvas-rich-view"
			onPointerDownCapture={(event) => {
				if ((event.target as HTMLElement).closest("a")) event.stopPropagation();
			}}
			onClickCapture={(event) => {
				if ((event.target as HTMLElement).closest("a")) event.stopPropagation();
			}}
			onWheelCapture={(event) => {
				const wrapper = (event.target as HTMLElement).closest<HTMLElement>(".tableWrapper");
				if (!wrapper || wrapper.scrollWidth <= wrapper.clientWidth) return;
				if (event.shiftKey && event.deltaY) {
					wrapper.scrollLeft += event.deltaY;
					event.preventDefault();
				}
				event.stopPropagation();
			}}
		>
			{renderToReactElement({ extensions: canvasTextExtensions, content: document })}
		</div>
	);
}
