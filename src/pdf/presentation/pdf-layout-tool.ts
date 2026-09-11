import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractLayouts, formatBox, intersects } from "../application/pdf-assets.ts";
import { getPdfPageCount, parsePageSelection, validatePdfPath } from "../application/pdf-document.ts";
import { type InspectPdfLayoutDetails, regionSchema } from "./pdf-asset-tool-contracts.ts";

export function registerPdfLayoutTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_pdf_layout",
		label: "Inspect PDF layout",
		description:
			"Inspect PDF blocks, lines, or words with exact top-left bounding boxes in PDF points. Use this to locate a figure, caption, table, equation, or legend before cropping. Requires Poppler pdftotext with TSV support.",
		promptSnippet: "Inspect PDF layout objects and bounding boxes",
		promptGuidelines: [
			"Use inspect_pdf_layout to recover coordinates before extracting a visual region; PDF point coordinates start at the top-left.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			pages: Type.Optional(
				Type.String({ description: 'Physical PDF pages, for example "4", "4-6", or "all"; default: "1"' }),
			),
			granularity: Type.Optional(
				Type.Union([Type.Literal("blocks"), Type.Literal("lines"), Type.Literal("words")], {
					description: 'Layout item granularity; default: "lines"',
				}),
			),
			region: Type.Optional(regionSchema),
			max_items: Type.Optional(
				Type.Integer({ minimum: 20, maximum: 2_000, description: "Maximum layout items; default: 300" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const pageCount = await getPdfPageCount(pi, absolutePath, signal);
			const selectedPages = parsePageSelection(params.pages ?? "1", pageCount);
			const layouts = await extractLayouts(pi, absolutePath, selectedPages, signal);
			const granularity = params.granularity ?? "lines";
			const maxItems = params.max_items ?? 300;
			const items = layouts.flatMap((page) => {
				const pageItems =
					granularity === "blocks" ? page.blocks : granularity === "words" ? page.words : page.lines;
				return pageItems
					.filter((item) => !params.region || intersects(item, params.region))
					.map((item) => ({ page, item }));
			});
			const itemTruncated = items.length > maxItems;
			const shown = items.slice(0, maxItems);
			const output = [
				`PDF: ${absolutePath}`,
				"Coordinate system: PDF points (72 points/inch), origin at physical page top-left.",
				`Selected pages: ${selectedPages.join(", ")}`,
				...layouts.map((page) => `PAGE ${page.page}: width=${page.width} height=${page.height}`),
				`Granularity: ${granularity}; matched items: ${items.length}; shown: ${shown.length}`,
				"",
				...shown.map(
					({ page, item }, index) =>
						`${String(index + 1).padStart(4, "0")} p${page.page} [${formatBox(item)}] ${item.text}`,
				),
			].join("\n");
			const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let text = truncation.content;
			if (itemTruncated || truncation.truncated) {
				text += `\n\n[Layout output truncated. Narrow pages/region or granularity; limit was ${maxItems} items and ${formatSize(truncation.maxBytes)}.]`;
			}
			const details: InspectPdfLayoutDetails = {
				path: absolutePath,
				pageCount,
				selectedPages,
				granularity,
				itemCount: items.length,
				truncated: itemTruncated || truncation.truncated,
			};
			return { content: [{ type: "text", text }], details };
		},
	});
}
