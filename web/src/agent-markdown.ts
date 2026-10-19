import { fromMarkdown } from "mdast-util-from-markdown";
import type { Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const agentMarkdownRemarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];
export const agentMarkdownRehypePlugins: Options["rehypePlugins"] = [
	[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }],
];

interface MarkdownNode {
	type: string;
	position?: { start: { offset?: number }; end: { offset?: number } };
	children?: MarkdownNode[];
}

function collectCodeRanges(node: MarkdownNode, ranges: Array<[number, number]>): void {
	if (node.type === "code" || node.type === "inlineCode") {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start !== undefined && end !== undefined) ranges.push([start, end]);
		return;
	}
	for (const child of node.children ?? []) collectCodeRanges(child, ranges);
}

function displayMath(source: string, start: number, formula: string): string {
	const linePrefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
	// Continue the current list/quote container instead of ending it at a formula.
	const prefix = /^([ \t]*(?:>[ \t]*)*)(?:(?:[-+*]|\d+[.)])[ \t]+)?/.exec(linePrefix)![0];
	const indent = prefix.replace(/[-+*]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
	return `\n${indent}$$\n${indent}${formula.replace(/\n/g, `\n${indent}`)}\n${indent}$$\n${indent}`;
}

function closingDelimiter(source: string, start: number, delimiter: string): number {
	for (let index = start; index < source.length - 1; index++) {
		if (source[index] !== "\\") continue;
		if (source[index + 1] === delimiter) return index;
		index++;
	}
	return -1;
}

// Models commonly use TeX bracket delimiters. Convert them before Markdown
// consumes the backslashes as escapes, without changing code or stored messages.
export function normalizeAgentMath(source: string): string {
	if (!source.includes("\\(") && !source.includes("\\[")) return source;
	const codeRanges: Array<[number, number]> = [];
	collectCodeRanges(fromMarkdown(source), codeRanges);
	let rangeIndex = 0;
	let result = "";
	let index = 0;
	while (index < source.length) {
		const range = codeRanges[rangeIndex];
		if (range && index === range[0]) {
			result += source.slice(index, range[1]);
			index = range[1];
			rangeIndex++;
			continue;
		}
		if (source[index] === "\\") {
			const opening = source[index + 1];
			const end =
				opening === "(" || opening === "[" ? closingDelimiter(source, index + 2, opening === "(" ? ")" : "]") : -1;
			if (end >= 0 && (!range || end < range[0])) {
				const formula = source.slice(index + 2, end).trim();
				result += opening === "[" ? displayMath(source, index, formula) : `$${formula}$`;
				index = end + 2;
				continue;
			}
			result += source.slice(index, index + 2);
			index += 2;
			continue;
		}
		result += source[index++];
	}
	return result;
}
