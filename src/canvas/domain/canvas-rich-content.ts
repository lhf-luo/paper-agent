export interface CanvasRichNode {
	type: string;
	text?: string;
	attrs?: Record<string, unknown>;
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	content?: CanvasRichNode[];
}

export interface CanvasRichContent {
	type: "doc";
	content: CanvasRichNode[];
}

const blockTypes = new Set(["paragraph", "heading", "table", "tableRow", "tableCell", "tableHeader"]);
const inlineTypes = new Set(["text", "hardBreak"]);
const markTypes = new Set(["bold", "italic", "underline", "link"]);

export function validCanvasUrl(value: string): boolean {
	if (value.length > 2048 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			Boolean(url.hostname) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

export function parseCanvasRichContent(value: unknown): CanvasRichContent {
	if (!value || typeof value !== "object" || JSON.stringify(value).length > 250_000)
		throw new Error("Invalid rich text content");
	const root = value as Record<string, unknown>;
	if (root.type !== "doc" || !Array.isArray(root.content)) throw new Error("Invalid rich text document");
	let nodeCount = 0;
	let textLength = 0;
	const parseNode = (raw: unknown, parent: string, depth: number): CanvasRichNode => {
		if (!raw || typeof raw !== "object" || depth > 12 || ++nodeCount > 2000)
			throw new Error("Rich text is too complex");
		const node = raw as Record<string, unknown>;
		const type = node.type;
		if (typeof type !== "string" || (!blockTypes.has(type) && !inlineTypes.has(type)))
			throw new Error("Unsupported rich text element");
		const allowed =
			parent === "doc"
				? ["paragraph", "heading", "table"]
				: parent === "table"
					? ["tableRow"]
					: parent === "tableRow"
						? ["tableCell", "tableHeader"]
						: parent === "tableCell" || parent === "tableHeader"
							? ["paragraph", "heading"]
							: ["text", "hardBreak"];
		if (!allowed.includes(type)) throw new Error("Invalid rich text structure");
		if (type === "text") {
			if (typeof node.text !== "string") throw new Error("Invalid rich text value");
			textLength += node.text.length;
			if (textLength > 21_000) throw new Error("Rich text exceeds 21000 characters");
			const marks = Array.isArray(node.marks)
				? node.marks.map((rawMark) => {
						if (!rawMark || typeof rawMark !== "object") throw new Error("Invalid text mark");
						const mark = rawMark as Record<string, unknown>;
						if (typeof mark.type !== "string" || !markTypes.has(mark.type))
							throw new Error("Unsupported text mark");
						if (mark.type !== "link") return { type: mark.type };
						const href = (mark.attrs as Record<string, unknown> | undefined)?.href;
						if (typeof href !== "string" || !validCanvasUrl(href)) throw new Error("Invalid link URL");
						return { type: "link", attrs: { href } };
					})
				: undefined;
			return { type, text: node.text, ...(marks?.length ? { marks } : {}) };
		}
		if (type === "hardBreak") return { type };
		const children = Array.isArray(node.content)
			? node.content.map((child) => parseNode(child, type, depth + 1))
			: [];
		if (type === "heading") {
			const level = (node.attrs as Record<string, unknown> | undefined)?.level;
			if (![1, 2, 3].includes(level as number)) throw new Error("Invalid heading level");
			return { type, attrs: { level }, content: children };
		}
		if (type === "table") {
			if (children.length < 1 || children.length > 30) throw new Error("Invalid table row count");
			if (
				children.some(
					(row) =>
						!row.content?.length ||
						row.content.reduce((count, cell) => count + Number(cell.attrs?.colspan ?? 1), 0) > 20,
				)
			)
				throw new Error("Invalid table column count");
		}
		if (type === "tableCell" || type === "tableHeader") {
			const attrs = (node.attrs ?? {}) as Record<string, unknown>;
			const colspan = attrs.colspan ?? 1;
			const rowspan = attrs.rowspan ?? 1;
			if (
				!Number.isSafeInteger(colspan) ||
				!Number.isSafeInteger(rowspan) ||
				(colspan as number) < 1 ||
				(colspan as number) > 20 ||
				(rowspan as number) < 1 ||
				(rowspan as number) > 30
			)
				throw new Error("Invalid table cell span");
			const colwidth = attrs.colwidth;
			if (
				colwidth != null &&
				(!Array.isArray(colwidth) ||
					colwidth.length > 20 ||
					colwidth.some((width) => !Number.isSafeInteger(width) || width < 25 || width > 2000))
			)
				throw new Error("Invalid table column width");
			return { type, attrs: { colspan, rowspan, colwidth: colwidth ?? null }, content: children };
		}
		return { type, ...(children.length ? { content: children } : {}) };
	};
	return { type: "doc", content: root.content.map((node) => parseNode(node, "doc", 0)) };
}

export function canvasRichPlainText(document: CanvasRichContent): string {
	const visit = (node: CanvasRichNode): string => {
		if (node.type === "text") return node.text ?? "";
		if (node.type === "hardBreak") return "\n";
		const separator =
			node.type === "table" || node.type === "tableCell" || node.type === "tableHeader"
				? "\n"
				: node.type === "tableRow"
					? "\t"
					: "";
		return (node.content ?? []).map(visit).join(separator);
	};
	return document.content.map(visit).join("\n").trim();
}
