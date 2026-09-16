import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sha256File } from "../../artifacts/application/artifact-discovery.ts";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import {
	augmentPaperAssetsWithOcr,
	detectPaperAssets,
	extractLayouts,
	formatBox,
	listEmbeddedImages,
	refinePaperAssetRegions,
} from "../application/pdf-assets.ts";
import { getPdfPageCount, parsePageSelection, validatePdfPath } from "../application/pdf-document.ts";
import { PdfAnnotationStore } from "../infrastructure/pdf-annotation-store.ts";
import type { ListPaperAssetsDetails } from "./pdf-asset-tool-contracts.ts";

export function registerPdfAssetsListTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_paper_assets",
		label: "List paper assets",
		description:
			"Index captioned figures, tables, algorithms, and listings; estimate layout-aware crop regions; associate body mentions with physical pages, sections, bounding boxes, and context; and report the embedded raster-image inventory.",
		promptSnippet: "Index paper assets, crop regions, body mentions, and embedded images",
		promptGuidelines: [
			"Call list_paper_assets before deep evaluation analysis, then extract every figure/table that carries a core claim.",
			"Treat candidate regions as navigation hints even when confidence is high; verify complete edges with render_pdf_page and pass asset_id to extraction tools.",
			"Use mentions to connect prose claims to an asset, but disclose ambiguous mappings and inspect the cited page context.",
			"Saved manual crop corrections take precedence over automatic estimates for the exact PDF SHA-256.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			pages: Type.Optional(
				Type.String({ description: 'Physical PDF pages, for example "1-8" or "all"; default: "all"' }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const pageCount = await getPdfPageCount(pi, absolutePath, signal);
			const selectedPages = parsePageSelection(params.pages ?? "all", pageCount);
			const [layouts, embeddedImages] = await Promise.all([
				extractLayouts(pi, absolutePath, selectedPages, signal),
				listEmbeddedImages(pi, absolutePath, selectedPages, signal),
			]);
			const textAssets = detectPaperAssets(layouts);
			const automaticAssets = await refinePaperAssetRegions(
				pi,
				absolutePath,
				layouts,
				await augmentPaperAssetsWithOcr(pi, absolutePath, layouts, textAssets, { signal }),
				signal,
			);
			const [config, pdfSha256] = await Promise.all([loadPaperAgentConfig(ctx.cwd), sha256File(absolutePath)]);
			const annotations = new PdfAnnotationStore(
				join(config.storage.dataRoot ?? join(ctx.cwd, ".paper-agent"), "pdf-annotations"),
			);
			const assets = await annotations.apply(pdfSha256, automaticAssets);
			const output = [
				`PDF: ${absolutePath}`,
				`Pages indexed: ${selectedPages.join(", ")}`,
				`Captioned assets: ${assets.length}`,
				"",
				"Caption index (layout-aware candidate regions still require visual verification):",
				...(assets.length === 0
					? ["- No caption patterns detected in the PDF text layer."]
					: assets.map((asset) =>
							[
								`- asset_id=${asset.id}: ${asset.caption}`,
								`  page=${asset.page}; caption_box=[${formatBox(asset.captionBox)}]`,
								`  candidate_region=[${formatBox(asset.candidateRegion)}]; confidence=${asset.regionConfidence}`,
								...(asset.manualCorrection
									? [
											"  manual_correction=" +
												asset.manualCorrection.id +
												"; author=" +
												asset.manualCorrection.author +
												"; created_at=" +
												asset.manualCorrection.createdAt,
										]
									: []),
								...(asset.continuationRegions ?? []).map(
									(continuation) =>
										`  continuation_page=${continuation.page}; region=[${formatBox(continuation.region)}]; confidence=${continuation.confidence}`,
								),
								`  body_mentions=${asset.mentions.length}`,
								...asset.mentions
									.slice(0, 20)
									.map(
										(mention) =>
											"    - page=" +
											mention.page +
											"; section=" +
											(mention.section ?? "unknown") +
											"; confidence=" +
											mention.confidence +
											"; line_box=[" +
											formatBox(mention.lineBox) +
											"]; text=" +
											mention.matchedText +
											"; context=" +
											mention.context,
									),
								asset.mentions.length > 20 ? "    [mentions truncated to 20 for this asset]" : "",
							].join("\n"),
						)),
				"",
				`Embedded raster/mask entries reported by pdfimages: ${embeddedImages.length}`,
				...(embeddedImages.length === 0
					? ["- None reported."]
					: embeddedImages.map(
							(image) =>
								`- p${image.page} image#${image.index} ${image.type} ${image.width}x${image.height} ${image.encoding} object=${image.objectId} ppi=${image.xPpi}x${image.yPpi} size=${image.size}`,
						)),
				"",
				"[Evidence warning] Embedded-image entries are not semantic figures. Vector diagrams, text labels, masks, and multi-object composites may be absent or split across entries.",
			].join("\n");
			const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Asset index truncated at ${formatSize(truncation.maxBytes)} or ${truncation.maxLines} lines. Re-run on a smaller page range.]`;
			}
			const details: ListPaperAssetsDetails = {
				path: absolutePath,
				pageCount,
				selectedPages,
				assets,
				embeddedImages,
				truncated: truncation.truncated,
			};
			return { content: [{ type: "text", text }], details };
		},
	});
}
