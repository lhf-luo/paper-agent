import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import type { PaperAsset, PdfBox } from "../domain/pdf-types.ts";
import { candidateAssetRegion, explicitCaption, normalizedCaptionMatch } from "./pdf-asset-detection.ts";
import { attachAssetMentions } from "./pdf-asset-mentions.ts";
import { parsePgm } from "./pdf-gray-image.ts";
import { type PdfLayoutPage, unionBoxes } from "./pdf-layout.ts";
import { attachSubfigureRegions } from "./pdf-subfigure-layout.ts";
import { attachTableContinuations } from "./pdf-table-continuation.ts";

function parseTesseractCaptionLines(tsv: string, page: PdfLayoutPage, imageWidth: number, imageHeight: number) {
	const lines = new Map<string, Array<{ text: string; box: PdfBox; confidence: number }>>();
	for (const row of tsv.replaceAll("\r\n", "\n").split("\n").slice(1)) {
		const columns = row.split("\t");
		if (columns.length < 12 || columns[0] !== "5" || !columns[11]?.trim()) continue;
		const confidence = Number(columns[10]);
		const left = Number(columns[6]);
		const top = Number(columns[7]);
		const width = Number(columns[8]);
		const height = Number(columns[9]);
		if (![confidence, left, top, width, height].every(Number.isFinite) || confidence < 45) continue;
		const key = columns.slice(1, 5).join(":");
		const words = lines.get(key) ?? [];
		words.push({
			text: columns[11].trim(),
			confidence,
			box: {
				x: (left / imageWidth) * page.width,
				y: (top / imageHeight) * page.height,
				width: (width / imageWidth) * page.width,
				height: (height / imageHeight) * page.height,
			},
		});
		lines.set(key, words);
	}
	return [...lines.values()]
		.map((words) => ({
			text: words.map((word) => word.text).join(" "),
			box: unionBoxes(words.map((word) => word.box)),
		}))
		.filter((line) => explicitCaption(line.text));
}

export async function augmentPaperAssetsWithOcr(
	pi: CommandExecutor,
	pdfPath: string,
	layouts: PdfLayoutPage[],
	assets: PaperAsset[],
	options: { signal?: AbortSignal; pages?: Set<number> } = {},
): Promise<PaperAsset[]> {
	for (const page of layouts) {
		const hasDetectedAsset = assets.some((asset) => asset.page === page.page);
		const sparseTextLayer = page.words.length < 40;
		if (!hasDetectedAsset && !sparseTextLayer && !options.pages?.has(page.page)) continue;
		if (options.pages && !options.pages.has(page.page)) continue;
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-paper-ocr-"));
		try {
			const prefix = join(temporaryDirectory, "page");
			const rendered = await pi.exec(
				"pdftoppm",
				["-f", String(page.page), "-l", String(page.page), "-r", "144", "-gray", "-singlefile", pdfPath, prefix],
				{ cwd: dirname(pdfPath), signal: options.signal, timeout: 60_000 },
			);
			if (rendered.code !== 0 || rendered.killed || options.signal?.aborted) continue;
			const image = parsePgm(await readFile(`${prefix}.pgm`));
			const recognized = await pi.exec("tesseract", [`${prefix}.pgm`, "stdout", "--psm", "6", "tsv"], {
				cwd: temporaryDirectory,
				signal: options.signal,
				timeout: 90_000,
			});
			if (recognized.code !== 0 || recognized.killed || options.signal?.aborted) continue;
			const ocrLines = parseTesseractCaptionLines(recognized.stdout, page, image.width, image.height);
			for (const ocrLine of ocrLines) {
				const match = normalizedCaptionMatch(ocrLine.text);
				if (!match) continue;
				const duplicate = assets.some(
					(asset) =>
						asset.page === page.page &&
						asset.type === match.type &&
						asset.identifier.toLowerCase() === match.identifier.toLowerCase(),
				);
				if (duplicate) continue;
				const siblingCaptions = assets.filter((asset) => asset.page === page.page).map((asset) => asset.captionBox);
				const candidate = candidateAssetRegion(
					match.type,
					ocrLine.box,
					page,
					siblingCaptions,
					assets.filter((asset) => asset.page === page.page).map((asset) => asset.candidateRegion),
				);
				assets.push({
					id: `${match.type}-${match.identifier.toLowerCase()}-p${page.page}`,
					type: match.type,
					identifier: match.identifier,
					page: page.page,
					caption: ocrLine.text,
					captionBox: ocrLine.box,
					candidateRegion: candidate.region,
					regionConfidence: "medium",
					mentions: [],
				});
			}
		} catch {
			// OCR is optional; pdftotext assets remain available when Tesseract is absent or fails.
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
	for (const asset of assets) asset.mentions = [];
	attachTableContinuations(layouts, assets);
	attachSubfigureRegions(assets);
	attachAssetMentions(layouts, assets);
	return assets;
}
