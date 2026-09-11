export { detectPaperAssets } from "./pdf-asset-detection.ts";
export { augmentPaperAssetsWithOcr } from "./pdf-asset-ocr.ts";
export {
	type GrayImage,
	refinePaperAssetRegions,
	refineRegionFromGrayImage,
	refineSubfigureRegionsFromGrayImage,
} from "./pdf-gray-image.ts";
export {
	type EmbeddedImage,
	listEmbeddedImages,
	parsePdfImagesList,
} from "./pdf-image-inventory.ts";
export {
	extractLayouts,
	formatBox,
	intersects,
	type LayoutBlock,
	type LayoutLine,
	type LayoutWord,
	type PdfLayoutPage,
	parsePdfTsv,
	prepareProviderImage,
	renderRegion,
	resolveRegion,
	round,
	textInRegion,
	validateAssetPage,
	wordInside,
} from "./pdf-layout.ts";
export { attachSubfigureRegions } from "./pdf-subfigure-layout.ts";
export {
	buildTableGrid,
	csvTable,
	markdownTable,
	type TableGrid,
} from "./pdf-table.ts";
