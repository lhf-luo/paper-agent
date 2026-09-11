import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildTableGrid,
	csvTable,
	extractLayouts,
	formatBox,
	markdownTable,
	prepareProviderImage,
	renderRegion,
	resolveRegion,
	round,
	validateAssetPage,
	wordInside,
} from "../application/pdf-assets.ts";
import { getPdfPageCount, validatePdfPath } from "../application/pdf-document.ts";
import { coordinateSpaceSchema, type ExtractPdfTableDetails, regionSchema } from "./pdf-asset-tool-contracts.ts";

export function registerPdfTableTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "extract_pdf_table",
		label: "Extract PDF table",
		description:
			"Crop a table region and reconstruct its text layer as Markdown and CSV. Automatic rows/columns are heuristic; the returned image is the ground truth. Supply column_boundaries after visual inspection when automatic columns are wrong.",
		promptSnippet: "Extract a table crop plus Markdown/CSV structure",
		promptGuidelines: [
			"Treat extract_pdf_table structure as a checked transcription only after comparing it with the returned crop.",
			"When using extract_pdf_table for quantitative claims, verify row labels, column headers, units, arrows, boldface, and footnotes against the image.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			page: Type.Integer({ minimum: 1, description: "Physical PDF page number" }),
			asset_id: Type.Optional(
				Type.String({ description: "Asset id from list_paper_assets, when this table verifies an indexed asset" }),
			),
			region: regionSchema,
			coordinate_space: coordinateSpaceSchema,
			column_boundaries: Type.Optional(
				Type.Array(Type.Number({ minimum: 0 }), {
					maxItems: 20,
					description:
						"Internal absolute page x separators, in the selected coordinate space; omit for heuristic inference",
				}),
			),
			dpi: Type.Optional(
				Type.Integer({ minimum: 120, maximum: 300, description: "PNG render resolution; default: 200" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const pageCount = await getPdfPageCount(pi, absolutePath, signal);
			if (params.page > pageCount) throw new Error(`Page must stay within 1-${pageCount}. Received: ${params.page}`);
			validateAssetPage(params.asset_id, params.page);
			const [layout] = await extractLayouts(pi, absolutePath, [params.page], signal);
			if (!layout) throw new Error(`Could not recover layout dimensions for physical PDF page ${params.page}`);
			const coordinateSpace = params.coordinate_space ?? "points";
			const region = resolveRegion(params.region, coordinateSpace, layout);
			const boundaries = params.column_boundaries?.map((boundary) =>
				coordinateSpace === "normalized" ? boundary * layout.width : boundary,
			);
			if (
				boundaries?.some(
					(boundary) => boundary <= region.x || boundary >= region.x + region.width || !Number.isFinite(boundary),
				)
			) {
				throw new Error("Every column_boundary must lie strictly inside the selected table region.");
			}
			const words = layout.words.filter((word) => wordInside(word, region));
			const grid = buildTableGrid(words, region, boundaries);
			const dpi = params.dpi ?? 200;
			const rendered = await renderRegion(pi, absolutePath, params.page, region, dpi, signal);
			const providerImage = await prepareProviderImage(rendered.image);
			const markdown = markdownTable(grid.rows);
			const csv = csvTable(grid.rows);
			const details: ExtractPdfTableDetails = {
				path: absolutePath,
				pageCount,
				page: params.page,
				assetId: params.asset_id,
				dpi,
				pageSize: { width: layout.width, height: layout.height },
				region,
				renderedPath: rendered.renderedPath,
				extractedCharacters: grid.rows.flat().join("").length,
				textTruncated: false,
				returnedImage: {
					mimeType: providerImage.mimeType,
					width: providerImage.width,
					height: providerImage.height,
					wasResized: providerImage.wasResized,
				},
				rowCount: grid.rows.length,
				columnCount: grid.rows[0]?.length ?? 0,
				columnAnchors: grid.columnAnchors,
				usedExplicitBoundaries: grid.usedExplicitBoundaries,
				warnings: grid.warnings,
			};
			const output = [
				`Extracted table from physical PDF page ${params.page}; region: ${formatBox(region)}; asset=${params.asset_id ?? "not specified"}`,
				`Rows: ${details.rowCount}; columns: ${details.columnCount}; column anchors: ${grid.columnAnchors.map(round).join(", ") || "none"}`,
				...grid.warnings.map((warning) => `[Verification warning] ${warning}`),
				"",
				"Markdown:",
				markdown,
				"",
				"CSV:",
				"```csv",
				csv,
				"```",
				providerImage.wasResized
					? `[Provider image resized to ${providerImage.width}x${providerImage.height} and ${providerImage.mimeType}; PDF point coordinates are unchanged.]`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			details.textTruncated = truncation.truncated;
			const text = truncation.truncated
				? `${truncation.content}\n\n[Structured table text truncated at ${formatSize(truncation.maxBytes)} or ${truncation.maxLines} lines; the returned image still covers the complete region.]`
				: truncation.content;
			return {
				content: [
					{ type: "text", text },
					{ type: "image", mimeType: providerImage.mimeType, data: providerImage.data },
				],
				details,
			};
		},
	});
}
