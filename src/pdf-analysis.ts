import { dirname } from "node:path";
import type { CommandExecutor } from "./command-executor.ts";
import {
	augmentPaperAssetsWithOcr,
	detectPaperAssets,
	type PaperAsset,
	parsePdfTsv,
	refinePaperAssetRegions,
} from "./tools/pdf-asset-tools.ts";
import { getPdfPageCount, validatePdfPath } from "./tools/pdf-tools.ts";

export interface PdfAnalysisResult {
	pdfPath: string;
	pageCount: number;
	pages: Array<{ page: number; width: number; height: number; wordCount: number }>;
	assets: PaperAsset[];
	warnings: string[];
}

export async function analyzePdfForLibrary(
	executor: CommandExecutor,
	inputPath: string,
	cwd: string,
	options: { refine?: boolean; ocr?: boolean; signal?: AbortSignal } = {},
): Promise<PdfAnalysisResult> {
	const pdfPath = await validatePdfPath(inputPath, cwd);
	const pageCount = await getPdfPageCount(executor, pdfPath, options.signal);
	const layout = await executor.exec("pdftotext", ["-tsv", "-r", "72", "-enc", "UTF-8", pdfPath, "-"], {
		cwd: dirname(pdfPath),
		signal: options.signal,
		timeout: 180_000,
	});
	if (layout.code !== 0 || layout.killed || options.signal?.aborted) {
		const reason = options.signal?.aborted
			? "operation aborted"
			: layout.killed
				? "pdftotext timed out"
				: layout.stderr.trim() || "pdftotext -tsv failed";
		throw new Error(`Could not analyze PDF layout: ${reason}`);
	}
	const layouts = parsePdfTsv(layout.stdout);
	let assets = detectPaperAssets(layouts);
	const warnings: string[] = [];
	if (options.refine !== false) {
		try {
			assets = await refinePaperAssetRegions(executor, pdfPath, layouts, assets, options.signal);
		} catch (error) {
			warnings.push(`Raster refinement unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (options.ocr) {
		try {
			assets = await augmentPaperAssetsWithOcr(executor, pdfPath, layouts, assets, { signal: options.signal });
		} catch (error) {
			warnings.push(`OCR augmentation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		pdfPath,
		pageCount,
		pages: layouts.map((page) => ({
			page: page.page,
			width: page.width,
			height: page.height,
			wordCount: page.words.length,
		})),
		assets,
		warnings,
	};
}
