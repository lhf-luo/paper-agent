import type { PaperAsset, PdfBox } from "../domain/pdf-types.ts";
import {
	clampRegion,
	horizontalOverlap,
	intersects,
	type LayoutLine,
	type PdfLayoutPage,
	wordInside,
} from "./pdf-layout.ts";
import { sectionHeading } from "./pdf-section-heading.ts";
import { buildTableGrid, median } from "./pdf-table.ts";

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

export function attachTableContinuations(layouts: PdfLayoutPage[], assets: PaperAsset[]): void {
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
