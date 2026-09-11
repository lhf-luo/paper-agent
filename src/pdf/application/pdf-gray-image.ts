import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import type { PaperAsset, PdfBox } from "../domain/pdf-types.ts";
import { clampRegion, type LayoutWord, type PdfLayoutPage, unionBoxes } from "./pdf-layout.ts";
import { attachSubfigureRegions } from "./pdf-subfigure-layout.ts";

export interface GrayImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export function parsePgm(data: Buffer): GrayImage {
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
			const image = parsePgm(await readFile(`${prefix}.pgm`));
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
