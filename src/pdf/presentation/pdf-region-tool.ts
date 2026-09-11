import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	extractLayouts,
	formatBox,
	prepareProviderImage,
	renderRegion,
	resolveRegion,
	textInRegion,
	validateAssetPage,
} from "../application/pdf-assets.ts";
import { getPdfPageCount, validatePdfPath } from "../application/pdf-document.ts";
import { coordinateSpaceSchema, type ExtractPdfRegionDetails, regionSchema } from "./pdf-asset-tool-contracts.ts";

export function registerPdfRegionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "extract_pdf_region",
		label: "Extract PDF region",
		description:
			"Crop one exact PDF region to PNG and return text-layer content inside it. Use for a complete figure, diagram, equation, legend, or caption after locating coordinates with inspect_pdf_layout or list_paper_assets.",
		promptSnippet: "Crop a precise PDF region as an image with its text layer",
		promptGuidelines: [
			"Use extract_pdf_region on the complete semantic object, including axis labels or legend; inspect the image and retry if any edge is cut off.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			page: Type.Integer({ minimum: 1, description: "Physical PDF page number" }),
			asset_id: Type.Optional(
				Type.String({ description: "Asset id from list_paper_assets, when this crop verifies an indexed asset" }),
			),
			region: regionSchema,
			coordinate_space: coordinateSpaceSchema,
			dpi: Type.Optional(
				Type.Integer({ minimum: 96, maximum: 300, description: "PNG render resolution; default: 180" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const pageCount = await getPdfPageCount(pi, absolutePath, signal);
			if (params.page > pageCount) throw new Error(`Page must stay within 1-${pageCount}. Received: ${params.page}`);
			validateAssetPage(params.asset_id, params.page);
			const [layout] = await extractLayouts(pi, absolutePath, [params.page], signal);
			if (!layout) throw new Error(`Could not recover layout dimensions for physical PDF page ${params.page}`);
			const region = resolveRegion(params.region, params.coordinate_space ?? "points", layout);
			const dpi = params.dpi ?? 180;
			const rendered = await renderRegion(pi, absolutePath, params.page, region, dpi, signal);
			const providerImage = await prepareProviderImage(rendered.image);
			const extractedText = textInRegion(layout, region);
			const details: ExtractPdfRegionDetails = {
				path: absolutePath,
				pageCount,
				page: params.page,
				assetId: params.asset_id,
				dpi,
				pageSize: { width: layout.width, height: layout.height },
				region,
				renderedPath: rendered.renderedPath,
				extractedCharacters: extractedText.length,
				textTruncated: false,
				returnedImage: {
					mimeType: providerImage.mimeType,
					width: providerImage.width,
					height: providerImage.height,
					wasResized: providerImage.wasResized,
				},
			};
			const output = [
				`Extracted physical PDF page ${params.page} region at ${dpi} DPI from ${absolutePath}`,
				`Page size: ${layout.width}x${layout.height} points; region: ${formatBox(region)}`,
				params.asset_id ? `Indexed asset: ${params.asset_id}` : "Indexed asset: not specified",
				"Text layer inside region:",
				extractedText || "(no text-layer content found)",
				providerImage.wasResized
					? `[Provider image resized to ${providerImage.width}x${providerImage.height} and ${providerImage.mimeType}; PDF point coordinates are unchanged.]`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			details.textTruncated = truncation.truncated;
			const text = truncation.truncated
				? `${truncation.content}\n\n[Region text truncated at ${formatSize(truncation.maxBytes)} or ${truncation.maxLines} lines; the returned image still covers the complete region.]`
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
