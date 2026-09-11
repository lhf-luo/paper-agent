import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPdfAssetsListTool } from "./pdf-assets-list-tool.ts";
import { registerPdfLayoutTool } from "./pdf-layout-tool.ts";
import { registerPdfRegionTool } from "./pdf-region-tool.ts";
import { registerPdfTableTool } from "./pdf-table-tool.ts";

export {
	attachSubfigureRegions,
	augmentPaperAssetsWithOcr,
	buildTableGrid,
	detectPaperAssets,
	type EmbeddedImage,
	type GrayImage,
	type LayoutWord,
	type PdfLayoutPage,
	parsePdfImagesList,
	parsePdfTsv,
	refinePaperAssetRegions,
	refineRegionFromGrayImage,
	refineSubfigureRegionsFromGrayImage,
} from "../application/pdf-assets.ts";

export function registerPdfAssetTools(pi: ExtensionAPI): void {
	registerPdfLayoutTool(pi);
	registerPdfRegionTool(pi);
	registerPdfTableTool(pi);
	registerPdfAssetsListTool(pi);
}
