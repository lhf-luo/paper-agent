import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ResizedImage } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	resizeImage,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandExecutor } from "./command-executor.ts";
import { getPdfPageCount, parsePageSelection, validatePdfPath } from "./pdf-tools.ts";

export interface PdfBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutWord extends PdfBox {
	page: number;
	order: number;
	text: string;
	blockId: string;
	lineId: string;
}

interface LayoutLine extends PdfBox {
	page: number;
	order: number;
	text: string;
	blockId: string;
	lineId: string;
	words: LayoutWord[];
}

interface LayoutBlock extends PdfBox {
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

export interface PaperAsset {
	id: string;
	type: "figure" | "table" | "algorithm" | "listing";
	identifier: string;
	page: number;
	caption: string;
	captionBox: PdfBox;
	candidateRegion: PdfBox;
	continuationRegions?: Array<{ page: number; region: PdfBox; confidence: "high" | "medium" }>;
	subfigureRegions?: Array<{ label: string; region: PdfBox; confidence: "medium" | "low" }>;
	regionConfidence: "high" | "medium" | "low";
	mentions: PaperAssetMention[];
	manualCorrection?: { id: string; author: string; createdAt: string; note?: string };
}

export function attachSubfigureRegions(assets: PaperAsset[]): void {
	for (const asset of assets) {
		if (asset.type !== "figure") continue;
		const labels = new Set<string>();
		for (const match of asset.caption.matchAll(/\(([a-h])\)/gi)) labels.add(match[1].toLowerCase());
		if (labels.size < 2) {
			for (const match of asset.caption.matchAll(/\b\d+([a-h])\b/gi)) labels.add(match[1].toLowerCase());
		}
		if (labels.size < 2 && /\bleft\b/i.test(asset.caption) && /\bright\b/i.test(asset.caption)) {
			labels.add("left");
			labels.add("right");
		}
		if (labels.size < 2 || labels.size > 9) continue;
		const parent = asset.candidateRegion;
		const captionBelow = asset.captionBox.y >= parent.y + parent.height * 0.5;
		const contentTop = captionBelow ? parent.y : asset.captionBox.y + asset.captionBox.height;
		const contentBottom = captionBelow ? asset.captionBox.y : parent.y + parent.height;
		if (contentBottom - contentTop < parent.height * 0.25) continue;
		const ordered = [...labels].sort((left, right) => {
			const explicitOrder = ["left", "right"];
			const leftIndex = explicitOrder.indexOf(left);
			const rightIndex = explicitOrder.indexOf(right);
			if (leftIndex >= 0 || rightIndex >= 0) {
				return (
					(leftIndex < 0 ? explicitOrder.length : leftIndex) - (rightIndex < 0 ? explicitOrder.length : rightIndex)
				);
			}
			return left.localeCompare(right);
		});
		const columns = ordered.length === 4 ? 4 : ordered.length <= 3 ? ordered.length : ordered.length <= 6 ? 3 : 4;
		const rows = Math.ceil(ordered.length / columns);
		const cellWidth = parent.width / columns;
		const cellHeight = (contentBottom - contentTop) / rows;
		asset.subfigureRegions = ordered.map((label, index) => ({
			label,
			region: {
				x: parent.x + (index % columns) * cellWidth,
				y: contentTop + Math.floor(index / columns) * cellHeight,
				width: cellWidth,
				height: cellHeight,
			},
			confidence: ordered.length <= 3 ? "medium" : "low",
		}));
	}
}

function normalizedHeaderLine(text: string): string {
	return text
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}#]+/gu, " ")
		.trim();
}

function tableHeaderLines(page: PdfLayoutPage, top: number, region: PdfBox): LayoutLine[] {
	return page.lines
		.filter(
			(line) =>
				line.y >= top &&
				line.y < top + page.height * 0.13 &&
				horizontalOverlap(line, region) >= 0.35 &&
				line.text.trim(),
		)
		.sort((left, right) => left.y - right.y || left.x - right.x)
		.slice(0, 12);
}

interface TableStructureSignature {
	anchors: number[];
	structuredRowCount: number;
	contentTop: number;
	contentBottom: number;
}

function tableStructureSignature(
	page: PdfLayoutPage,
	region: PdfBox,
	excluded: PdfBox[] = [],
): TableStructureSignature | undefined {
	const words = page.words.filter(
		(word) => wordInside(word, region) && !excluded.some((box) => intersects(word, box)),
	);
	if (words.length < 12) return undefined;
	const grid = buildTableGrid(words, region);
	const structuredRowCount = grid.rows.filter((row) => {
		const cells = row.map((cell) => cell.trim()).filter(Boolean);
		if (cells.length < 2 || cells.some((cell) => cell.split(/\s+/).length > 10)) return false;
		return cells.length >= 3 || cells.some((cell) => /\d/.test(cell));
	}).length;
	if (grid.columnAnchors.length < 2 || structuredRowCount < 4) return undefined;
	return {
		anchors: grid.columnAnchors.map((anchor) => (anchor - region.x) / Math.max(1, region.width)),
		structuredRowCount,
		contentTop: Math.min(...words.map((word) => word.y)),
		contentBottom: Math.max(...words.map((word) => word.y + word.height)),
	};
}

function compatibleTableStructures(left: TableStructureSignature, right: TableStructureSignature): boolean {
	if (left.anchors.length !== right.anchors.length) return false;
	return left.anchors.every((anchor, index) => Math.abs(anchor - right.anchors[index]) <= 0.075);
}

function attachTableContinuations(layouts: PdfLayoutPage[], assets: PaperAsset[]): void {
	const pages = new Map(layouts.map((page) => [page.page, page]));
	for (const asset of assets.filter((item) => item.type === "table")) {
		const captionPage = pages.get(asset.page);
		if (!captionPage) continue;
		const captionBelow = asset.candidateRegion.y + asset.candidateRegion.height * 0.5 < asset.captionBox.y;
		const headerLines = tableHeaderLines(
			captionPage,
			captionBelow ? asset.candidateRegion.y : asset.captionBox.y + asset.captionBox.height,
			asset.candidateRegion,
		);
		const header = new Set(
			headerLines.map((line) => normalizedHeaderLine(line.text)).filter((text) => text.length > 0),
		);
		const sourceProbe = captionBelow
			? clampRegion(
					{
						x: asset.candidateRegion.x,
						y: asset.candidateRegion.y,
						width: asset.candidateRegion.width,
						height: Math.max(1, asset.captionBox.y - asset.candidateRegion.y),
					},
					captionPage,
				)
			: clampRegion(
					{
						x: asset.candidateRegion.x,
						y: asset.captionBox.y + asset.captionBox.height,
						width: asset.candidateRegion.width,
						height: captionPage.height * 0.94 - (asset.captionBox.y + asset.captionBox.height),
					},
					captionPage,
				);
		const sourceStructure = tableStructureSignature(captionPage, sourceProbe, [asset.captionBox]);
		let structuralContinuationAllowed =
			Boolean(sourceStructure) && (sourceStructure?.contentBottom ?? 0) >= captionPage.height * 0.78;
		if (header.size < 3 && !structuralContinuationAllowed) continue;
		const continuations: NonNullable<PaperAsset["continuationRegions"]> = [];
		for (let pageNumber = asset.page + 1; pageNumber <= asset.page + 4; pageNumber++) {
			const page = pages.get(pageNumber);
			if (!page) break;
			const topLines = page.lines
				.filter(
					(line) =>
						line.y < page.height * 0.2 &&
						horizontalOverlap(line, asset.candidateRegion) >= 0.35 &&
						line.text.trim(),
				)
				.sort((left, right) => left.y - right.y || left.x - right.x);
			const repeated = topLines.filter((line) => header.has(normalizedHeaderLine(line.text)));
			const repeatedHeader = header.size >= 3 && repeated.length >= Math.min(3, header.size);
			const tableTop = repeatedHeader
				? Math.max(page.height * 0.04, Math.min(...repeated.map((line) => line.y)) - 10)
				: page.height * 0.04;
			const typicalTableHeight = median(topLines.map((line) => line.height)) || 7;
			const section = page.lines
				.filter(
					(line) =>
						line.y > tableTop + page.height * 0.2 &&
						line.height >= typicalTableHeight * 1.15 &&
						sectionHeading(line.text),
				)
				.sort((left, right) => left.y - right.y)[0];
			const tableBottom = section ? section.y - 10 : page.height * 0.94;
			const tableLines = page.lines.filter(
				(line) =>
					line.y >= tableTop &&
					line.y + line.height <= tableBottom &&
					line.text.trim() &&
					(repeatedHeader || horizontalOverlap(line, asset.candidateRegion) >= 0.35),
			);
			if (tableLines.length < 8) break;
			const left = Math.max(0, Math.min(...tableLines.map((line) => line.x)) - 8);
			const right = Math.min(page.width, Math.max(...tableLines.map((line) => line.x + line.width)) + 8);
			const contentBottom = Math.max(...tableLines.map((line) => line.y + line.height));
			if (!repeatedHeader) {
				if (!structuralContinuationAllowed || !sourceStructure) break;
				const structuralRegion = clampRegion(
					{
						x: asset.candidateRegion.x,
						y: tableTop,
						width: asset.candidateRegion.width,
						height: Math.max(1, Math.min(tableBottom, contentBottom + 8) - tableTop),
					},
					page,
				);
				const nextStructure = tableStructureSignature(page, structuralRegion);
				if (!nextStructure || !compatibleTableStructures(sourceStructure, nextStructure)) break;
				structuralContinuationAllowed = nextStructure.contentBottom >= page.height * 0.78;
			}
			continuations.push({
				page: pageNumber,
				region: clampRegion(
					{
						x: left,
						y: tableTop,
						width: right - left,
						height: Math.min(tableBottom, contentBottom + 8) - tableTop,
					},
					page,
				),
				confidence: repeatedHeader && repeated.length >= 4 ? "high" : "medium",
			});
		}
		if (continuations.length > 0) {
			asset.continuationRegions = continuations;
			if (captionBelow) continue;
			const tableLines = captionPage.lines.filter(
				(line) =>
					line.y >= asset.captionBox.y &&
					line.y < captionPage.height * 0.9 &&
					line.text.trim() &&
					!sectionHeading(line.text),
			);
			if (tableLines.length > 0) {
				const right = Math.min(captionPage.width, Math.max(...tableLines.map((line) => line.x + line.width)) + 8);
				const left = Math.max(0, Math.min(...tableLines.map((line) => line.x)) - 8);
				const bottom = Math.min(
					captionPage.height * 0.9,
					Math.max(...tableLines.map((line) => line.y + line.height)) + 8,
				);
				asset.candidateRegion = clampRegion(
					{ x: left, y: asset.captionBox.y, width: right - left, height: bottom - asset.captionBox.y },
					captionPage,
				);
				asset.regionConfidence = "high";
			}
		}
	}
}

export interface PaperAssetMention {
	page: number;
	matchedText: string;
	section?: string;
	context: string;
	lineBox: PdfBox;
	confidence: "high" | "ambiguous";
}

export interface EmbeddedImage {
	page: number;
	index: number;
	type: string;
	width: number;
	height: number;
	encoding: string;
	objectId: string;
	xPpi: number;
	yPpi: number;
	size: string;
}

interface InspectPdfLayoutDetails {
	path: string;
	pageCount: number;
	selectedPages: number[];
	granularity: "blocks" | "lines" | "words";
	itemCount: number;
	truncated: boolean;
}

interface ExtractPdfRegionDetails {
	path: string;
	pageCount: number;
	page: number;
	assetId?: string;
	dpi: number;
	pageSize: { width: number; height: number };
	region: PdfBox;
	renderedPath: string;
	extractedCharacters: number;
	textTruncated: boolean;
	returnedImage: {
		mimeType: string;
		width: number;
		height: number;
		wasResized: boolean;
	};
}

interface ExtractPdfTableDetails extends ExtractPdfRegionDetails {
	rowCount: number;
	columnCount: number;
	columnAnchors: number[];
	usedExplicitBoundaries: boolean;
	warnings: string[];
}

interface ListPaperAssetsDetails {
	path: string;
	pageCount: number;
	selectedPages: number[];
	assets: PaperAsset[];
	embeddedImages: EmbeddedImage[];
	truncated: boolean;
}

interface TableGrid {
	rows: string[][];
	columnAnchors: number[];
	usedExplicitBoundaries: boolean;
	warnings: string[];
}

const regionSchema = Type.Object({
	x: Type.Number({ minimum: 0, description: "Left edge" }),
	y: Type.Number({ minimum: 0, description: "Top edge" }),
	width: Type.Number({ exclusiveMinimum: 0, description: "Region width" }),
	height: Type.Number({ exclusiveMinimum: 0, description: "Region height" }),
});

const coordinateSpaceSchema = Type.Optional(
	Type.Union([Type.Literal("points"), Type.Literal("normalized")], {
		description:
			'Coordinate space; "points" uses PDF points from the top-left (72 points/inch), "normalized" uses fractions in [0,1]; default: "points"',
	}),
);

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

function contiguousRanges(pages: number[]): Array<{ first: number; last: number }> {
	const ranges: Array<{ first: number; last: number }> = [];
	for (const page of pages) {
		const current = ranges.at(-1);
		if (current && page === current.last + 1) current.last = page;
		else ranges.push({ first: page, last: page });
	}
	return ranges;
}

async function extractLayouts(
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

function intersects(left: PdfBox, right: PdfBox): boolean {
	return (
		left.x < right.x + right.width &&
		left.x + left.width > right.x &&
		left.y < right.y + right.height &&
		left.y + left.height > right.y
	);
}

function wordInside(word: LayoutWord, region: PdfBox): boolean {
	const centerX = word.x + word.width / 2;
	const centerY = word.y + word.height / 2;
	return (
		centerX >= region.x &&
		centerX <= region.x + region.width &&
		centerY >= region.y &&
		centerY <= region.y + region.height
	);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatBox(box: PdfBox): string {
	return `x=${round(box.x)} y=${round(box.y)} w=${round(box.width)} h=${round(box.height)}`;
}

function resolveRegion(
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

function validateAssetPage(assetId: string | undefined, page: number): void {
	if (!assetId) return;
	const pageMatch = /-p(\d+)(?:-\d+)?$/.exec(assetId);
	if (pageMatch && Number(pageMatch[1]) !== page) {
		throw new Error(`asset_id ${assetId} belongs to physical PDF page ${pageMatch[1]}, not page ${page}.`);
	}
}

async function renderRegion(
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

async function prepareProviderImage(image: Buffer): Promise<ResizedImage> {
	const prepared = await resizeImage(image, "image/png");
	if (!prepared) {
		throw new Error(
			"Rendered region could not be reduced below the provider image payload limit. Select a smaller region or lower DPI.",
		);
	}
	return prepared;
}

function textInRegion(page: PdfLayoutPage, region: PdfBox): string {
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

function unionBoxes(boxes: PdfBox[]): PdfBox {
	const x = Math.min(...boxes.map((box) => box.x));
	const y = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x, y, width: right - x, height: bottom - y };
}

function captionMatch(text: string): { type: PaperAsset["type"]; identifier: string } | undefined {
	// Tiny lowercase strings such as `table.81` are PDF object labels, not captions.
	if (/^\s*(?:table|algorithm|listing)\.\d+\s*$/.test(text)) return undefined;
	const english =
		/^\s*(fig(?:ure)?|table|algorithm|listing)\.?\s*(?:\(|\[)?([A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)(?:\)|\])?\s*([.:|])?(?:\s|$)/i.exec(
			text,
		);
	const chinese = /^\s*(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)\s*[：:.]?/.exec(text);
	if (!english && !chinese) return undefined;
	const label = (english?.[1] ?? chinese?.[1] ?? "").toLowerCase();
	if (english && !english[3] && label !== "algorithm" && label !== "listing") {
		const trailingText = text.slice(english[0].length).trim();
		const uppercaseHeading = english[1] === english[1].toUpperCase() && trailingText === trailingText.toUpperCase();
		if (trailingText && !uppercaseHeading) return undefined;
	}
	const type =
		label === "table" || label === "表"
			? "table"
			: label === "algorithm"
				? "algorithm"
				: label === "listing"
					? "listing"
					: "figure";
	return { type, identifier: english?.[2] ?? chinese?.[2] ?? "" };
}

function normalizedCaptionMatch(text: string): { type: PaperAsset["type"]; identifier: string } | undefined {
	const chinese = /^\s*(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)\s*[：:.]?/.exec(text);
	if (chinese) return { type: chinese[1] === "表" ? "table" : "figure", identifier: chinese[2] };
	return captionMatch(text);
}

function explicitCaption(text: string): boolean {
	return /^\s*(?:fig(?:ure)?|table|algorithm|listing)\.?\s*(?:\(|\[)?(?:[A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)(?:\)|\])?\s*[:|]/i.test(
		text,
	);
}

function splitMergedCaptionLine(line: LayoutLine): LayoutLine[] {
	const starts = line.words
		.map((word, index) => ({ word, index }))
		.filter(
			({ word, index }) =>
				/^(?:fig(?:ure)?|table|algorithm|listing)\.?$/i.test(word.text) &&
				/^(?:[A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)[.:|]?$/i.test(line.words[index + 1]?.text ?? ""),
		)
		.map(({ index }) => index);
	if (starts.length < 2) return [line];
	return starts.map((start, segmentIndex) => {
		const words = line.words.slice(start, starts[segmentIndex + 1] ?? line.words.length);
		const box = unionBoxes(words);
		return {
			...line,
			...box,
			order: line.order + segmentIndex / 1000,
			lineId: `${line.lineId}:caption-${segmentIndex + 1}`,
			text: words.map((word) => word.text).join(" "),
			words,
		};
	});
}

function captionQuality(caption: { lines: LayoutLine[]; box: PdfBox }): number {
	const text = caption.lines.map((line) => line.text).join(" ");
	return (explicitCaption(text) ? 10_000 : 0) + Math.min(text.length, 2_000) + caption.box.height;
}

function horizontalOverlap(left: PdfBox, right: PdfBox): number {
	const overlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
	return overlap / Math.max(1, Math.min(left.width, right.width));
}

function denseBodyBlock(block: LayoutBlock, column: PdfBox, bodyLineHeight: number): boolean {
	if (block.lines.length < 3 || horizontalOverlap(block, column) < 0.45) return false;
	const words = block.lines.reduce((count, line) => count + line.words.length, 0);
	if (words < 16 || block.width < column.width * 0.42) return false;
	const ordered = [...block.lines].sort((left, right) => left.y - right.y);
	const gaps = ordered.slice(1).map((line, index) => line.y - (ordered[index].y + ordered[index].height));
	const typicalGap = median(gaps.filter((gap) => gap >= -1));
	return typicalGap <= Math.max(5, bodyLineHeight * 0.8);
}

function clampRegion(box: PdfBox, page: PdfLayoutPage): PdfBox {
	const x = Math.max(0, Math.min(box.x, page.width - 1));
	const y = Math.max(0, Math.min(box.y, page.height - 1));
	const right = Math.max(x + 1, Math.min(page.width, box.x + box.width));
	const bottom = Math.max(y + 1, Math.min(page.height, box.y + box.height));
	return { x, y, width: right - x, height: bottom - y };
}

function candidateAssetRegion(
	assetType: PaperAsset["type"],
	caption: PdfBox,
	page: PdfLayoutPage,
	siblingCaptions: PdfBox[],
	occupiedRegions: PdfBox[] = [],
): { region: PdfBox; confidence: PaperAsset["regionConfidence"] } {
	const pageMargin = page.width * 0.055;
	let x = pageMargin;
	let width = page.width - 2 * pageMargin;
	const singleColumnPage = page.lines.filter((line) => line.width >= page.width * 0.72).length >= 8;
	const sideBySideCaption = siblingCaptions.some(
		(sibling) =>
			Math.abs(sibling.y - caption.y) < page.height * 0.08 &&
			horizontalOverlap(sibling, caption) < 0.1 &&
			Math.abs(sibling.x - caption.x) > page.width * 0.2,
	);
	if ((!singleColumnPage || sideBySideCaption) && caption.width < page.width * 0.55) {
		if (caption.x + caption.width < page.width * 0.58) {
			x = pageMargin;
			width = page.width * 0.45;
		} else if (caption.x > page.width * 0.42) {
			x = page.width * 0.5;
			width = page.width * 0.445;
		}
	}
	const column = { x, y: 0, width, height: page.height };
	const bodyLineHeight =
		median(
			page.lines
				.filter((line) => horizontalOverlap(line, column) >= 0.5 && line.width > width * 0.45)
				.map((line) => line.height),
		) || 9;
	const bodyBlocks = page.blocks
		.filter((block) => !intersects(block, caption) && denseBodyBlock(block, column, bodyLineHeight))
		.sort((left, right) => left.y - right.y);
	const minimumAssetHeight = Math.max(42, page.height * 0.075);
	const padding = Math.max(2, bodyLineHeight * 0.55);
	const overlappingSiblings = siblingCaptions
		.filter((sibling) => horizontalOverlap(sibling, column) >= 0.4)
		.sort((left, right) => left.y - right.y);
	const previousSibling = overlappingSiblings.filter((sibling) => sibling.y + sibling.height < caption.y).at(-1);
	const nextSibling = overlappingSiblings.find((sibling) => sibling.y > caption.y + caption.height);
	if (assetType === "table" || assetType === "algorithm" || assetType === "listing") {
		const captionBottom = caption.y + caption.height;
		const nearbyLines = page.lines.filter(
			(line) =>
				!intersects(line, caption) &&
				!occupiedRegions.some((region) => intersects(line, region)) &&
				horizontalOverlap(line, column) >= 0.35 &&
				line.text.trim(),
		);
		const previousLine = nearbyLines
			.filter((line) => line.y + line.height <= caption.y)
			.sort((left, right) => left.y - right.y)
			.at(-1);
		const nextLine = nearbyLines.filter((line) => line.y >= captionBottom).sort((left, right) => left.y - right.y)[0];
		const previousGap = previousLine ? caption.y - (previousLine.y + previousLine.height) : Number.POSITIVE_INFINITY;
		const nextGap = nextLine ? nextLine.y - captionBottom : Number.POSITIVE_INFINITY;
		const probableTableRows = new Map<number, LayoutLine[]>();
		const previousSiblingBottom = previousSibling ? previousSibling.y + previousSibling.height + padding : 0;
		for (const line of nearbyLines.filter(
			(item) =>
				item.y + item.height <= caption.y &&
				item.y >= previousSiblingBottom &&
				caption.y - (item.y + item.height) < page.height * 0.18,
		)) {
			const baseline = Math.round(line.y / Math.max(1, bodyLineHeight * 0.6));
			const row = probableTableRows.get(baseline) ?? [];
			row.push(line);
			probableTableRows.set(baseline, row);
		}
		const structuredRowsAbove = [...probableTableRows.values()].filter((row) => {
			if (row.length >= 2) return true;
			return row.some((line) => {
				const numericTokens = line.words.filter((word) => /\d/.test(word.text)).length;
				return (
					(numericTokens >= 2 &&
						(line.words.length <= 12 || numericTokens / Math.max(1, line.words.length) >= 0.35)) ||
					(numericTokens === 1 && line.words.length <= 8)
				);
			});
		}).length;
		const contentAbove = structuredRowsAbove >= 2 || previousGap + bodyLineHeight * 0.75 < nextGap;
		if (contentAbove) {
			const previousBody = bodyBlocks
				.filter((block) => caption.y - (block.y + block.height) >= minimumAssetHeight)
				.at(-1);
			const fallbackTop = Math.max(page.height * 0.04, caption.y - page.height * 0.3);
			const top = Math.max(
				fallbackTop,
				previousBody ? previousBody.y + previousBody.height + padding : 0,
				previousSibling ? previousSibling.y + previousSibling.height + padding : 0,
			);
			return {
				region: clampRegion({ x, y: top, width, height: captionBottom - top }, page),
				confidence: previousLine && Number.isFinite(nextGap) ? "high" : "low",
			};
		}
		const nextBody = bodyBlocks.find((block) => block.y - captionBottom >= minimumAssetHeight);
		const structuralBottom = Math.min(
			nextBody?.y ?? Number.POSITIVE_INFINITY,
			nextSibling?.y ?? Number.POSITIVE_INFINITY,
		);
		if (Number.isFinite(structuralBottom)) {
			const bottom = Math.max(captionBottom + 1, structuralBottom - padding);
			return {
				region: clampRegion({ x, y: caption.y, width, height: bottom - caption.y }, page),
				confidence: "high",
			};
		}
		const fallbackBottom = Math.min(page.height - page.height * 0.035, captionBottom + page.height * 0.25);
		if (fallbackBottom <= captionBottom + 1) {
			const fallbackTop = Math.max(page.height * 0.04, caption.y - page.height * 0.24);
			return {
				region: clampRegion({ x, y: fallbackTop, width, height: captionBottom - fallbackTop }, page),
				confidence: "low",
			};
		}
		return {
			region: clampRegion({ x, y: caption.y, width, height: fallbackBottom - caption.y }, page),
			confidence: "low",
		};
	}
	const previousBody = bodyBlocks.filter((block) => caption.y - (block.y + block.height) >= minimumAssetHeight).at(-1);
	const structuralTop = Math.max(
		previousBody ? previousBody.y + previousBody.height + padding : 0,
		previousSibling ? previousSibling.y + previousSibling.height + padding : 0,
	);
	if (structuralTop > 0) {
		const top = Math.min(caption.y - 1, structuralTop);
		return {
			region: clampRegion({ x, y: top, width, height: caption.y + caption.height - top }, page),
			confidence: "high",
		};
	}
	const top = Math.max(page.height * 0.04, caption.y - page.height * 0.48);
	return {
		region: clampRegion({ x, y: top, width, height: caption.y + caption.height - top }, page),
		confidence: "low",
	};
}

function sectionHeading(text: string): boolean {
	const normalized = text.trim();
	if (!normalized || normalized.length > 120 || normalizedCaptionMatch(normalized)) return false;
	if (
		/^(?:abstract|introduction|background|related work|method(?:ology)?|experiments?|evaluation|results?|discussion|conclusion|references|appendix)\s*$/i.test(
			normalized,
		)
	) {
		return true;
	}
	if (/^(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][\p{L}\p{N}\s,:()/-]{2,100}$/u.test(normalized)) return true;
	return (
		normalized.length >= 4 &&
		normalized === normalized.toUpperCase() &&
		normalized !== normalized.toLowerCase() &&
		/[\p{L}]/u.test(normalized)
	);
}

function referenceIdentifiers(
	text: string,
): Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> {
	const references: Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> = [];
	const pattern = /\b(fig(?:ure)?s?|tables?|algorithms?|listings?)\.?\s+([^.;:\n]{1,100})/gi;
	for (const match of text.matchAll(pattern)) {
		const label = match[1].toLowerCase();
		const type: PaperAsset["type"] = label.startsWith("tab")
			? "table"
			: label.startsWith("alg")
				? "algorithm"
				: label.startsWith("list")
					? "listing"
					: "figure";
		const identifiers = [...match[2].matchAll(/\b(?:[A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)\b/g)].map((identifier) =>
			identifier[0].toLowerCase(),
		);
		if (identifiers.length) references.push({ type, identifiers, matchedText: match[0].trim() });
	}
	for (const match of text.matchAll(/(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)/g)) {
		references.push({
			type: match[1] === "表" ? "table" : "figure",
			identifiers: [match[2].toLowerCase()],
			matchedText: match[0],
		});
	}
	return references;
}

function attachAssetMentions(layouts: PdfLayoutPage[], assets: PaperAsset[]): void {
	const keyCounts = new Map<string, number>();
	for (const asset of assets) {
		const key = asset.type + ":" + asset.identifier.toLowerCase();
		keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
	}
	let section: string | undefined;
	for (const page of layouts) {
		const lines = [...page.lines].filter((line) => line.text.trim()).sort((left, right) => left.order - right.order);
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const block = page.blocks.find((item) => item.blockId === line.blockId);
			if (sectionHeading(line.text) && (block?.lines.length ?? 0) <= 2) {
				section = line.text.trim();
				continue;
			}
			for (const reference of referenceIdentifiers(line.text)) {
				for (const identifier of reference.identifiers) {
					const candidates = assets.filter(
						(asset) => asset.type === reference.type && asset.identifier.toLowerCase() === identifier,
					);
					for (const asset of candidates) {
						if (asset.page === page.page && intersects(line, asset.captionBox)) continue;
						const context = (
							block?.text ||
							lines
								.slice(Math.max(0, index - 1), index + 2)
								.map((item) => item.text)
								.join(" ")
						)
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 600);
						const key = asset.type + ":" + identifier;
						asset.mentions.push({
							page: page.page,
							matchedText: reference.matchedText,
							section,
							context,
							lineBox: { x: line.x, y: line.y, width: line.width, height: line.height },
							confidence: (keyCounts.get(key) ?? 0) === 1 ? "high" : "ambiguous",
						});
					}
				}
			}
		}
	}
}

export function detectPaperAssets(layouts: PdfLayoutPage[]): PaperAsset[] {
	const assets: PaperAsset[] = [];
	const idCounts = new Map<string, number>();
	for (const page of layouts) {
		const lines = page.lines
			.flatMap(splitMergedCaptionLine)
			.filter((line) => line.text.trim())
			.sort((left, right) => left.y - right.y || left.x - right.x);
		const blockLineCounts = new Map(page.blocks.map((block) => [block.blockId, block.lines.length]));
		const bodyLineHeight = median(lines.filter((line) => line.width >= page.width * 0.25).map((line) => line.height));
		const pageCaptions: Array<{
			match: { type: PaperAsset["type"]; identifier: string };
			lines: LayoutLine[];
			box: PdfBox;
		}> = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const match = normalizedCaptionMatch(line.text);
			if (!match) continue;
			const isolatedBlock = (blockLineCounts.get(line.blockId) ?? 0) <= 3;
			const captionSized = bodyLineHeight === 0 || line.height < bodyLineHeight * 0.95;
			if (!explicitCaption(line.text) && !isolatedBlock && !captionSized) continue;
			const captionLines = [line];
			for (const next of lines.slice(index + 1, index + 7)) {
				const previous = captionLines.at(-1);
				if (!previous || normalizedCaptionMatch(next.text)) break;
				if (next.blockId !== line.blockId) break;
				const verticalGap = next.y - (previous.y + previous.height);
				if (verticalGap < -1 || verticalGap > Math.max(4, previous.height * 0.55)) break;
				if (Math.abs(next.x - line.x) > 18) break;
				captionLines.push(next);
			}
			const captionBox = unionBoxes(captionLines);
			pageCaptions.push({ match, lines: captionLines, box: captionBox });
		}
		const bestCaptions = new Map<string, (typeof pageCaptions)[number]>();
		for (const caption of pageCaptions) {
			const key = `${caption.match.type}:${caption.match.identifier.toLowerCase()}`;
			const current = bestCaptions.get(key);
			if (!current || captionQuality(caption) > captionQuality(current)) bestCaptions.set(key, caption);
		}
		const selectedCaptions = [...bestCaptions.values()].sort(
			(left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
		);
		for (const caption of selectedCaptions) {
			const { match, lines: captionLines, box: captionBox } = caption;
			const baseId = `${match.type}-${match.identifier.toLowerCase()}-p${page.page}`;
			const count = (idCounts.get(baseId) ?? 0) + 1;
			idCounts.set(baseId, count);
			const candidate = candidateAssetRegion(
				match.type,
				captionBox,
				page,
				selectedCaptions.filter((item) => item !== caption).map((item) => item.box),
				assets.filter((asset) => asset.page === page.page).map((asset) => asset.candidateRegion),
			);
			assets.push({
				id: count === 1 ? baseId : `${baseId}-${count}`,
				type: match.type,
				identifier: match.identifier,
				page: page.page,
				caption: captionLines.map((captionLine) => captionLine.text).join(" "),
				captionBox,
				candidateRegion: candidate.region,
				regionConfidence: candidate.confidence,
				mentions: [],
			});
		}
	}
	attachTableContinuations(layouts, assets);
	attachSubfigureRegions(assets);
	attachAssetMentions(layouts, assets);
	return assets;
}

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
			const image = parsePgm(await readFile(prefix + ".pgm"));
			const recognized = await pi.exec("tesseract", [prefix + ".pgm", "stdout", "--psm", "6", "tsv"], {
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

export interface GrayImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

function parsePgm(data: Buffer): GrayImage {
	let offset = 0;
	const token = () => {
		while (offset < data.length) {
			if (data[offset] === 35) {
				while (offset < data.length && data[offset] !== 10) offset++;
			} else if (data[offset] <= 32) offset++;
			else break;
		}
		const start = offset;
		while (offset < data.length && data[offset] > 32 && data[offset] !== 35) offset++;
		return data.subarray(start, offset).toString("ascii");
	};
	if (token() !== "P5") throw new Error("Expected a binary PGM page image");
	const width = Number(token());
	const height = Number(token());
	const maximum = Number(token());
	if (data[offset] === 13 && data[offset + 1] === 10) offset += 2;
	else if (data[offset] <= 32) offset++;
	if (!Number.isInteger(width) || !Number.isInteger(height) || maximum !== 255) {
		throw new Error("Unsupported PGM header");
	}
	const pixels = data.subarray(offset, offset + width * height);
	if (pixels.length !== width * height) throw new Error("Truncated PGM page image");
	return { width, height, pixels };
}

export function refineRegionFromGrayImage(region: PdfBox, page: PdfLayoutPage, image: GrayImage): PdfBox {
	const scaleX = image.width / page.width;
	const scaleY = image.height / page.height;
	const left = Math.max(0, Math.floor(region.x * scaleX));
	const top = Math.max(0, Math.floor(region.y * scaleY));
	const right = Math.min(image.width, Math.ceil((region.x + region.width) * scaleX));
	const bottom = Math.min(image.height, Math.ceil((region.y + region.height) * scaleY));
	let minX = right;
	let minY = bottom;
	let maxX = left - 1;
	let maxY = top - 1;
	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++) {
			if (image.pixels[y * image.width + x] >= 248) continue;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	if (maxX < minX || maxY < minY) return region;
	const padding = 4;
	return clampRegion(
		{
			x: Math.max(left, minX - padding) / scaleX,
			y: Math.max(top, minY - padding) / scaleY,
			width: (Math.min(right - 1, maxX + padding) - Math.max(left, minX - padding) + 1) / scaleX,
			height: (Math.min(bottom - 1, maxY + padding) - Math.max(top, minY - padding) + 1) / scaleY,
		},
		page,
	);
}

function uniqueCoordinates(values: number[]): number[] {
	const result: number[] = [];
	for (const value of [...values].sort((left, right) => left - right)) {
		if (!result.some((existing) => Math.abs(existing - value) < 1)) result.push(value);
	}
	return result;
}

function clusteredCoordinateCount(values: number[], tolerance: number): number {
	const clusters: number[] = [];
	for (const value of [...values].sort((left, right) => left - right)) {
		const index = clusters.findIndex((center) => Math.abs(center - value) <= tolerance);
		if (index < 0) clusters.push(value);
		else clusters[index] = (clusters[index] + value) / 2;
	}
	return clusters.length;
}

function subfigureWordLabel(text: string): string | undefined {
	return /^\(?([a-h])\)?[.:]?$/i.exec(text.trim())?.[1]?.toLowerCase();
}

function inferSubfigureGridFromLabels(
	regions: NonNullable<PaperAsset["subfigureRegions"]>,
	page: PdfLayoutPage,
	content: PdfBox,
): { columns: number; rows: number; anchors: Array<{ x: number; y: number }> } | undefined {
	const anchors = regions.map((entry) => {
		const candidates = page.words
			.filter((word) => {
				const centerX = word.x + word.width / 2;
				const centerY = word.y + word.height / 2;
				return (
					subfigureWordLabel(word.text) === entry.label.toLowerCase() &&
					centerX >= content.x - 8 &&
					centerX <= content.x + content.width + 8 &&
					centerY >= content.y - 8 &&
					centerY < content.y + content.height - 1
				);
			})
			.sort((left, right) => left.y - right.y || left.x - right.x);
		return candidates[0];
	});
	if (anchors.some((anchor) => !anchor)) return undefined;
	const resolved = anchors.filter((anchor): anchor is LayoutWord => Boolean(anchor));
	const columns = clusteredCoordinateCount(
		resolved.map((word) => word.x + word.width / 2),
		Math.max(8, content.width / Math.max(12, regions.length * 6)),
	);
	const rows = clusteredCoordinateCount(
		resolved.map((word) => word.y + word.height / 2),
		Math.max(8, content.height / Math.max(12, regions.length * 6)),
	);
	const cells = columns * rows;
	if (cells < regions.length || cells > regions.length + Math.max(columns, rows)) return undefined;
	return {
		columns,
		rows,
		anchors: resolved.map((word) => ({ x: word.x + word.width / 2, y: word.y + word.height / 2 })),
	};
}

function visualGutter(
	image: GrayImage,
	page: PdfLayoutPage,
	axis: "x" | "y",
	nominal: number,
	content: PdfBox,
	searchRadius: number,
): { value: number; improved: boolean } {
	const scaleX = image.width / page.width;
	const scaleY = image.height / page.height;
	const start =
		axis === "x"
			? Math.max(0, Math.floor((nominal - searchRadius) * scaleX))
			: Math.max(0, Math.floor((nominal - searchRadius) * scaleY));
	const end =
		axis === "x"
			? Math.min(image.width - 1, Math.ceil((nominal + searchRadius) * scaleX))
			: Math.min(image.height - 1, Math.ceil((nominal + searchRadius) * scaleY));
	const crossStart =
		axis === "x" ? Math.max(0, Math.floor(content.y * scaleY)) : Math.max(0, Math.floor(content.x * scaleX));
	const crossEnd =
		axis === "x"
			? Math.min(image.height, Math.ceil((content.y + content.height) * scaleY))
			: Math.min(image.width, Math.ceil((content.x + content.width) * scaleX));
	const densities: Array<{ coordinate: number; density: number }> = [];
	for (let coordinate = start; coordinate <= end; coordinate++) {
		let ink = 0;
		let samples = 0;
		for (let cross = crossStart; cross < crossEnd; cross++) {
			const pixel =
				axis === "x"
					? image.pixels[cross * image.width + coordinate]
					: image.pixels[coordinate * image.width + cross];
			if (pixel < 238) ink++;
			samples++;
		}
		densities.push({ coordinate, density: samples ? ink / samples : 1 });
	}
	if (!densities.length) return { value: nominal, improved: false };
	const smoothed = densities.map((item, index) => ({
		coordinate: item.coordinate,
		density:
			densities.slice(Math.max(0, index - 2), index + 3).reduce((sum, entry) => sum + entry.density, 0) /
			densities.slice(Math.max(0, index - 2), index + 3).length,
	}));
	const minimumDensity = Math.min(...smoothed.map((item) => item.density));
	const nominalPixel = axis === "x" ? nominal * scaleX : nominal * scaleY;
	const nominalEntry = smoothed.reduce((current, item) =>
		Math.abs(item.coordinate - nominalPixel) < Math.abs(current.coordinate - nominalPixel) ? item : current,
	);
	const nearMinimum = smoothed.filter(
		(item) => item.density <= minimumDensity + Math.max(0.003, minimumDensity * 0.15),
	);
	const best = nearMinimum.reduce((current, item) =>
		Math.abs(item.coordinate - nominalPixel) < Math.abs(current.coordinate - nominalPixel) ? item : current,
	);
	const improved = best.density <= nominalEntry.density * 0.82 || best.density < 0.015;
	return { value: improved ? best.coordinate / (axis === "x" ? scaleX : scaleY) : nominal, improved };
}

export function refineSubfigureRegionsFromGrayImage(asset: PaperAsset, page: PdfLayoutPage, image: GrayImage): void {
	const regions = asset.subfigureRegions;
	if (!regions || regions.length < 2) return;
	let content = unionBoxes(regions.map((entry) => entry.region));
	const existingColumns = uniqueCoordinates(regions.map((entry) => entry.region.x)).length;
	const existingRows = uniqueCoordinates(regions.map((entry) => entry.region.y)).length;
	const inferred = inferSubfigureGridFromLabels(regions, page, content);
	if (inferred && inferred.rows > 1) {
		const anchorRows = uniqueCoordinates(inferred.anchors.map((anchor) => anchor.y));
		const spacings = anchorRows
			.slice(1)
			.map((value, index) => value - anchorRows[index])
			.filter((value) => value > 8);
		if (spacings.length) {
			const rowSpacing = Math.min(...spacings);
			const firstLabelOffset = anchorRows[0] - content.y;
			if (firstLabelOffset > 24 && firstLabelOffset < rowSpacing * 0.6) {
				const bottom = content.y + content.height;
				const expandedTop = Math.max(0, anchorRows[0] - rowSpacing * 0.9);
				content = { ...content, y: expandedTop, height: bottom - expandedTop };
			}
		}
	}
	const columnCount = inferred?.columns ?? existingColumns;
	const rowCount = inferred?.rows ?? existingRows;
	if (columnCount * rowCount < regions.length) return;
	const nominalXBounds = Array.from(
		{ length: columnCount + 1 },
		(_value, index) => content.x + (content.width * index) / columnCount,
	);
	const nominalYBounds = Array.from(
		{ length: rowCount + 1 },
		(_value, index) => content.y + (content.height * index) / rowCount,
	);
	let visuallyAdjusted = false;
	const xBounds = nominalXBounds
		.map((boundary, index) => {
			if (index === 0 || index === nominalXBounds.length - 1) return boundary;
			const adjusted = visualGutter(
				image,
				page,
				"x",
				boundary,
				content,
				Math.max(3, Math.min(boundary - nominalXBounds[index - 1], nominalXBounds[index + 1] - boundary) * 0.22),
			);
			visuallyAdjusted ||= adjusted.improved;
			return adjusted.value;
		})
		.sort((left, right) => left - right);
	const yBounds = nominalYBounds
		.map((boundary, index) => {
			if (index === 0 || index === nominalYBounds.length - 1) return boundary;
			const adjusted = visualGutter(
				image,
				page,
				"y",
				boundary,
				content,
				Math.max(3, Math.min(boundary - nominalYBounds[index - 1], nominalYBounds[index + 1] - boundary) * 0.22),
			);
			visuallyAdjusted ||= adjusted.improved;
			return adjusted.value;
		})
		.sort((left, right) => left - right);
	asset.subfigureRegions = regions.map((entry, index) => {
		const row = Math.floor(index / columnCount);
		const column = index % columnCount;
		if (row >= yBounds.length - 1) return entry;
		return {
			label: entry.label,
			region: clampRegion(
				{
					x: xBounds[column],
					y: yBounds[row],
					width: xBounds[column + 1] - xBounds[column],
					height: yBounds[row + 1] - yBounds[row],
				},
				page,
			),
			confidence: visuallyAdjusted || inferred ? "medium" : entry.confidence,
		};
	});
	asset.candidateRegion = clampRegion(
		unionBoxes([asset.candidateRegion, ...asset.subfigureRegions.map((entry) => entry.region)]),
		page,
	);
}

export async function refinePaperAssetRegions(
	pi: CommandExecutor,
	pdfPath: string,
	layouts: PdfLayoutPage[],
	assets: PaperAsset[],
	signal?: AbortSignal,
): Promise<PaperAsset[]> {
	const layoutByPage = new Map(layouts.map((page) => [page.page, page]));
	for (const pageNumber of new Set(assets.map((asset) => asset.page))) {
		const page = layoutByPage.get(pageNumber);
		if (!page) continue;
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-paper-assets-"));
		try {
			const prefix = join(temporaryDirectory, "page");
			const rendered = await pi.exec(
				"pdftoppm",
				["-f", String(pageNumber), "-l", String(pageNumber), "-r", "72", "-gray", "-singlefile", pdfPath, prefix],
				{ cwd: dirname(pdfPath), signal, timeout: 60_000 },
			);
			if (rendered.code !== 0 || rendered.killed || signal?.aborted) continue;
			const image = parsePgm(await readFile(prefix + ".pgm"));
			const pageAssets = assets.filter((item) => item.page === pageNumber);
			for (const asset of pageAssets) {
				asset.candidateRegion = refineRegionFromGrayImage(asset.candidateRegion, page, image);
			}
			attachSubfigureRegions(pageAssets);
			for (const asset of pageAssets) refineSubfigureRegionsFromGrayImage(asset, page, image);
		} catch {
			// Text-layout regions remain usable when raster refinement is unavailable.
			attachSubfigureRegions(assets.filter((item) => item.page === pageNumber));
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
	return assets;
}

export function parsePdfImagesList(output: string): EmbeddedImage[] {
	const images: EmbeddedImage[] = [];
	for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 15 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) continue;
		const page = Number(fields[0]);
		const index = Number(fields[1]);
		const width = Number(fields[3]);
		const height = Number(fields[4]);
		const numericObjectId = /^\d+$/.test(fields[10]) && /^\d+$/.test(fields[11]);
		const metricOffset = numericObjectId ? 12 : 11;
		const xPpi = Number(fields[metricOffset]);
		const yPpi = Number(fields[metricOffset + 1]);
		if (![page, index, width, height, xPpi, yPpi].every(Number.isFinite)) continue;
		images.push({
			page,
			index,
			type: fields[2],
			width,
			height,
			encoding: fields[8],
			objectId: numericObjectId ? `${fields[10]} ${fields[11]}` : fields[10],
			xPpi,
			yPpi,
			size: fields[metricOffset + 2],
		});
	}
	return images;
}

async function listEmbeddedImages(
	pi: CommandExecutor,
	absolutePath: string,
	selectedPages: number[],
	signal?: AbortSignal,
): Promise<EmbeddedImage[]> {
	const images: EmbeddedImage[] = [];
	for (const range of contiguousRanges(selectedPages)) {
		const result = await pi.exec(
			"pdfimages",
			["-f", String(range.first), "-l", String(range.last), "-list", absolutePath],
			{ cwd: dirname(absolutePath), signal, timeout: 120_000 },
		);
		if (result.killed || signal?.aborted || result.code !== 0) {
			const reason = signal?.aborted
				? "operation aborted"
				: result.killed
					? "pdfimages was terminated or timed out"
					: result.stderr.trim() || "pdfimages -list exited with a non-zero status";
			throw new Error(`Could not list embedded images in ${basename(absolutePath)}: ${reason}`);
		}
		images.push(...parsePdfImagesList(result.stdout));
	}
	return images;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clusterVisualRows(words: LayoutWord[]): LayoutWord[][] {
	const tolerance = Math.max(2, median(words.map((word) => word.height)) * 0.55);
	const rows: Array<{ centerY: number; words: LayoutWord[] }> = [];
	for (const word of [...words].sort((left, right) => left.y - right.y || left.x - right.x)) {
		const centerY = word.y + word.height / 2;
		let row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= tolerance);
		if (!row) {
			row = { centerY, words: [] };
			rows.push(row);
		}
		row.words.push(word);
		row.centerY = row.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.words.length;
	}
	return rows
		.sort((left, right) => left.centerY - right.centerY)
		.map((row) => row.words.sort((left, right) => left.x - right.x));
}

function splitIntoChunks(words: LayoutWord[], gapThreshold: number): LayoutWord[][] {
	const chunks: LayoutWord[][] = [];
	for (const word of words) {
		const current = chunks.at(-1);
		const previous = current?.at(-1);
		if (!current || !previous || word.x - (previous.x + previous.width) > gapThreshold) chunks.push([word]);
		else current.push(word);
	}
	return chunks;
}

function inferColumnAnchors(rows: LayoutWord[][], region: PdfBox): number[] {
	const wordHeight = median(rows.flat().map((word) => word.height));
	const gapThreshold = Math.max(10, wordHeight * 1.35);
	const starts = rows.flatMap((row) => splitIntoChunks(row, gapThreshold).map((chunk) => chunk[0].x));
	const clusters: Array<{ center: number; count: number }> = [];
	for (const start of starts.sort((left, right) => left - right)) {
		const cluster = clusters.find((candidate) => Math.abs(candidate.center - start) <= Math.max(8, wordHeight));
		if (cluster) {
			cluster.center = (cluster.center * cluster.count + start) / (cluster.count + 1);
			cluster.count++;
		} else {
			clusters.push({ center: start, count: 1 });
		}
	}
	const minimumSupport = Math.max(2, Math.ceil(rows.length * 0.5));
	const supported = clusters
		.filter(
			(cluster) =>
				cluster.count >= minimumSupport && cluster.center >= region.x && cluster.center <= region.x + region.width,
		)
		.sort((left, right) => left.center - right.center)
		.slice(0, 12)
		.map((cluster) => cluster.center);
	return supported.length > 0 ? supported : [region.x];
}

function escapeMarkdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function csvCell(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function buildTableGrid(words: LayoutWord[], region: PdfBox, explicitBoundaries?: number[]): TableGrid {
	const visualRows = clusterVisualRows(words);
	const warnings = [
		"Rows are reconstructed from visual baselines; wrapped or merged cells may appear as additional rows.",
		"Markdown serialization treats the first extracted visual row as a header; verify multi-row headers in the image.",
	];
	if (visualRows.length === 0) {
		return {
			rows: [],
			columnAnchors: [],
			usedExplicitBoundaries: explicitBoundaries !== undefined,
			warnings: ["No text-layer words were found in the region; inspect the returned image or use OCR externally."],
		};
	}

	if (explicitBoundaries) {
		const boundaries = [...explicitBoundaries].sort((left, right) => left - right);
		if (boundaries.some((boundary, index) => index > 0 && boundary - boundaries[index - 1] < 0.5)) {
			throw new Error("column_boundaries must be unique and separated by at least 0.5 PDF points.");
		}
		const rows = visualRows.map((row) => {
			const cells = Array.from({ length: boundaries.length + 1 }, () => [] as string[]);
			for (const word of row) {
				const center = word.x + word.width / 2;
				const column = boundaries.findIndex((boundary) => center < boundary);
				cells[column === -1 ? cells.length - 1 : column].push(word.text);
			}
			return cells.map((cell) => cell.join(" "));
		});
		return {
			rows,
			columnAnchors: [region.x, ...boundaries],
			usedExplicitBoundaries: true,
			warnings,
		};
	}

	const anchors = inferColumnAnchors(visualRows, region);
	const gapThreshold = Math.max(10, median(words.map((word) => word.height)) * 1.35);
	const rows = visualRows.map((row) => {
		const cells = Array.from({ length: anchors.length }, () => [] as string[]);
		for (const chunk of splitIntoChunks(row, gapThreshold)) {
			const chunkStart = chunk[0].x;
			let column = 0;
			let distance = Number.POSITIVE_INFINITY;
			for (let index = 0; index < anchors.length; index++) {
				const candidateDistance = Math.abs(anchors[index] - chunkStart);
				if (candidateDistance < distance) {
					distance = candidateDistance;
					column = index;
				}
			}
			cells[column].push(chunk.map((word) => word.text).join(" "));
		}
		return cells.map((cell) => cell.join(" "));
	});
	if (anchors.length < 2) {
		warnings.push(
			"Automatic column detection found fewer than two stable column anchors; provide column_boundaries.",
		);
	} else {
		warnings.push(
			"Column anchors were inferred heuristically; verify the image and retry with column_boundaries if needed.",
		);
	}
	return { rows, columnAnchors: anchors, usedExplicitBoundaries: false, warnings };
}

function markdownTable(rows: string[][]): string {
	if (rows.length === 0) return "(no structured rows extracted)";
	const columnCount = Math.max(...rows.map((row) => row.length));
	const normalized = rows.map((row) => Array.from({ length: columnCount }, (_value, index) => row[index] ?? ""));
	return [
		`| ${normalized[0].map(escapeMarkdownCell).join(" | ")} |`,
		`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
		...normalized.slice(1).map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
	].join("\n");
}

function csvTable(rows: string[][]): string {
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function registerPdfAssetTools(pi: ExtensionAPI): void {
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
			const assets = await refinePaperAssetRegions(
				pi,
				absolutePath,
				layouts,
				await augmentPaperAssetsWithOcr(pi, absolutePath, layouts, textAssets, { signal }),
				signal,
			);
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
								...(asset.continuationRegions ?? []).map(
									(continuation) =>
										`  continuation_page=${continuation.page}; region=[${formatBox(continuation.region)}]; confidence=${continuation.confidence}`,
								),
								"  body_mentions=" + asset.mentions.length,
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
