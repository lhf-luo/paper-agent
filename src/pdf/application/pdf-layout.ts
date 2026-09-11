import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ResizedImage } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import type { PdfBox } from "../domain/pdf-types.ts";

export interface LayoutWord extends PdfBox {
	page: number;
	order: number;
	text: string;
	blockId: string;
	lineId: string;
}

export interface LayoutLine extends PdfBox {
	page: number;
	order: number;
	text: string;
	blockId: string;
	lineId: string;
	words: LayoutWord[];
}

export interface LayoutBlock extends PdfBox {
	page: number;
	order: number;
	text: string;
	blockId: string;
	lines: LayoutLine[];
}

export interface PdfLayoutPage {
	page: number;
	width: number;
	height: number;
	blocks: LayoutBlock[];
	lines: LayoutLine[];
	words: LayoutWord[];
}

function numberField(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function rowBox(columns: string[]): PdfBox | undefined {
	const x = numberField(columns[6]);
	const y = numberField(columns[7]);
	const width = numberField(columns[8]);
	const height = numberField(columns[9]);
	if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
	return { x, y, width, height };
}

function rowKey(page: number, paragraph: string, block: string, line?: string): string {
	return `${page}:${paragraph}:${block}${line === undefined ? "" : `:${line}`}`;
}

export function parsePdfTsv(tsv: string): PdfLayoutPage[] {
	const pages = new Map<number, PdfLayoutPage>();
	const blockMap = new Map<string, LayoutBlock>();
	const lineMap = new Map<string, LayoutLine>();
	let blockOrder = 0;
	let lineOrder = 0;
	let wordOrder = 0;

	for (const rawRow of tsv.replaceAll("\r\n", "\n").split("\n").slice(1)) {
		if (!rawRow.trim()) continue;
		const columns = rawRow.split("\t");
		const level = numberField(columns[0]);
		const pageNumber = numberField(columns[1]);
		const box = rowBox(columns);
		if (level === undefined || pageNumber === undefined || !box) continue;

		if (level === 1) {
			pages.set(pageNumber, {
				page: pageNumber,
				width: box.width,
				height: box.height,
				blocks: [],
				lines: [],
				words: [],
			});
			continue;
		}

		const page = pages.get(pageNumber);
		if (!page) continue;
		const paragraph = columns[2] ?? "0";
		const block = columns[3] ?? "0";
		const line = columns[4] ?? "0";
		const blockId = rowKey(pageNumber, paragraph, block);
		const lineId = rowKey(pageNumber, paragraph, block, line);

		if (level === 3) {
			const layoutBlock: LayoutBlock = {
				...box,
				page: pageNumber,
				order: blockOrder++,
				text: "",
				blockId,
				lines: [],
			};
			page.blocks.push(layoutBlock);
			blockMap.set(blockId, layoutBlock);
			continue;
		}

		if (level === 4) {
			const layoutLine: LayoutLine = {
				...box,
				page: pageNumber,
				order: lineOrder++,
				text: "",
				blockId,
				lineId,
				words: [],
			};
			page.lines.push(layoutLine);
			lineMap.set(lineId, layoutLine);
			const layoutBlock = blockMap.get(blockId);
			if (layoutBlock) layoutBlock.lines.push(layoutLine);
			continue;
		}

		if (level !== 5) continue;
		const text = columns.slice(11).join("\t");
		if (!text || text.startsWith("###")) continue;
		const word: LayoutWord = {
			...box,
			page: pageNumber,
			order: wordOrder++,
			text,
			blockId,
			lineId,
		};
		page.words.push(word);
		let layoutLine = lineMap.get(lineId);
		if (!layoutLine) {
			layoutLine = { ...word, text: "", order: lineOrder++, words: [] };
			page.lines.push(layoutLine);
			lineMap.set(lineId, layoutLine);
		}
		layoutLine.words.push(word);
	}

	for (const page of pages.values()) {
		for (const line of page.lines) {
			line.words.sort((left, right) => left.x - right.x);
			line.text = line.words.map((word) => word.text).join(" ");
		}
		for (const block of page.blocks) {
			block.lines.sort((left, right) => left.order - right.order);
			block.text = block.lines
				.map((line) => line.text)
				.filter(Boolean)
				.join(" ");
		}
	}
	return [...pages.values()].sort((left, right) => left.page - right.page);
}

export function contiguousRanges(pages: number[]): Array<{ first: number; last: number }> {
	const ranges: Array<{ first: number; last: number }> = [];
	for (const page of pages) {
		const current = ranges.at(-1);
		if (current && page === current.last + 1) current.last = page;
		else ranges.push({ first: page, last: page });
	}
	return ranges;
}

export async function extractLayouts(
	pi: CommandExecutor,
	absolutePath: string,
	pages: number[],
	signal?: AbortSignal,
): Promise<PdfLayoutPage[]> {
	const layouts: PdfLayoutPage[] = [];
	for (const range of contiguousRanges(pages)) {
		const result = await pi.exec(
			"pdftotext",
			["-f", String(range.first), "-l", String(range.last), "-tsv", "-r", "72", "-enc", "UTF-8", absolutePath, "-"],
			{ cwd: dirname(absolutePath), signal, timeout: 120_000 },
		);
		if (result.killed || signal?.aborted || result.code !== 0) {
			const reason = signal?.aborted
				? "operation aborted"
				: result.killed
					? "pdftotext was terminated or timed out"
					: result.stderr.trim() || "pdftotext -tsv exited with a non-zero status";
			throw new Error(
				`Could not inspect PDF layout for pages ${range.first}-${range.last}: ${reason}. Poppler 22.05 or newer with pdftotext -tsv is required (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).`,
			);
		}
		layouts.push(...parsePdfTsv(result.stdout));
	}
	return layouts.sort((left, right) => left.page - right.page);
}

export function intersects(left: PdfBox, right: PdfBox): boolean {
	return (
		left.x < right.x + right.width &&
		left.x + left.width > right.x &&
		left.y < right.y + right.height &&
		left.y + left.height > right.y
	);
}

export function wordInside(word: LayoutWord, region: PdfBox): boolean {
	const centerX = word.x + word.width / 2;
	const centerY = word.y + word.height / 2;
	return (
		centerX >= region.x &&
		centerX <= region.x + region.width &&
		centerY >= region.y &&
		centerY <= region.y + region.height
	);
}

export function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export function formatBox(box: PdfBox): string {
	return `x=${round(box.x)} y=${round(box.y)} w=${round(box.width)} h=${round(box.height)}`;
}

export function resolveRegion(
	region: PdfBox,
	coordinateSpace: "points" | "normalized",
	page: Pick<PdfLayoutPage, "width" | "height">,
): PdfBox {
	const resolved =
		coordinateSpace === "normalized"
			? {
					x: region.x * page.width,
					y: region.y * page.height,
					width: region.width * page.width,
					height: region.height * page.height,
				}
			: { ...region };
	if (
		resolved.width <= 0 ||
		resolved.height <= 0 ||
		resolved.x < 0 ||
		resolved.y < 0 ||
		resolved.x >= page.width ||
		resolved.y >= page.height ||
		resolved.x + resolved.width > page.width + 1e-6 ||
		resolved.y + resolved.height > page.height + 1e-6
	) {
		throw new Error(
			`Region (${formatBox(resolved)}) must fit within the ${page.width}x${page.height} point page. Coordinates start at the top-left.`,
		);
	}
	return resolved;
}

export function validateAssetPage(assetId: string | undefined, page: number): void {
	if (!assetId) return;
	const pageMatch = /-p(\d+)(?:-\d+)?$/.exec(assetId);
	if (pageMatch && Number(pageMatch[1]) !== page) {
		throw new Error(`asset_id ${assetId} belongs to physical PDF page ${pageMatch[1]}, not page ${page}.`);
	}
}

export async function renderRegion(
	pi: CommandExecutor,
	absolutePath: string,
	page: number,
	region: PdfBox,
	dpi: number,
	signal?: AbortSignal,
): Promise<{ image: Buffer; renderedPath: string }> {
	const scale = dpi / 72;
	const pixelX = Math.max(0, Math.floor(region.x * scale));
	const pixelY = Math.max(0, Math.floor(region.y * scale));
	const pixelRight = Math.ceil((region.x + region.width) * scale);
	const pixelBottom = Math.ceil((region.y + region.height) * scale);
	const pixelWidth = Math.max(1, pixelRight - pixelX);
	const pixelHeight = Math.max(1, pixelBottom - pixelY);
	if (pixelWidth * pixelHeight > 20_000_000) {
		throw new Error(
			`Rendered region would contain ${pixelWidth}x${pixelHeight} pixels. Reduce the region or DPI to stay below 20 megapixels.`,
		);
	}
	const outputDirectory = await mkdtemp(join(tmpdir(), "pi-paper-region-"));
	const outputPrefix = join(outputDirectory, `page-${page}-region`);
	const result = await pi.exec(
		"pdftoppm",
		[
			"-f",
			String(page),
			"-l",
			String(page),
			"-singlefile",
			"-png",
			"-r",
			String(dpi),
			"-x",
			String(pixelX),
			"-y",
			String(pixelY),
			"-W",
			String(pixelWidth),
			"-H",
			String(pixelHeight),
			absolutePath,
			outputPrefix,
		],
		{ cwd: dirname(absolutePath), signal, timeout: 120_000 },
	);
	if (result.killed || signal?.aborted || result.code !== 0) {
		const reason = signal?.aborted
			? "operation aborted"
			: result.killed
				? "pdftoppm was terminated or timed out"
				: result.stderr.trim() || "pdftoppm exited with a non-zero status";
		throw new Error(`Could not render page ${page} region: ${reason}`);
	}
	const renderedPath = `${outputPrefix}.png`;
	return { image: await readFile(renderedPath), renderedPath };
}

export async function prepareProviderImage(image: Buffer): Promise<ResizedImage> {
	const prepared = await resizeImage(image, "image/png");
	if (!prepared) {
		throw new Error(
			"Rendered region could not be reduced below the provider image payload limit. Select a smaller region or lower DPI.",
		);
	}
	return prepared;
}

export function textInRegion(page: PdfLayoutPage, region: PdfBox): string {
	return page.lines
		.map((line) =>
			line.words
				.filter((word) => wordInside(word, region))
				.map((word) => word.text)
				.join(" "),
		)
		.filter(Boolean)
		.join("\n");
}

export function unionBoxes(boxes: PdfBox[]): PdfBox {
	const x = Math.min(...boxes.map((box) => box.x));
	const y = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x, y, width: right - x, height: bottom - y };
}

export function horizontalOverlap(left: PdfBox, right: PdfBox): number {
	const overlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
	return overlap / Math.max(1, Math.min(left.width, right.width));
}

export function clampRegion(box: PdfBox, page: PdfLayoutPage): PdfBox {
	const x = Math.max(0, Math.min(box.x, page.width - 1));
	const y = Math.max(0, Math.min(box.y, page.height - 1));
	const right = Math.max(x + 1, Math.min(page.width, box.x + box.width));
	const bottom = Math.max(y + 1, Math.min(page.height, box.y + box.height));
	return { x, y, width: right - x, height: bottom - y };
}
