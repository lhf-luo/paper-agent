import type { PaperAsset, PdfBox } from "../domain/pdf-types.ts";
import { attachAssetMentions } from "./pdf-asset-mentions.ts";
import {
	clampRegion,
	horizontalOverlap,
	intersects,
	type LayoutBlock,
	type LayoutLine,
	type PdfLayoutPage,
	unionBoxes,
} from "./pdf-layout.ts";
import { attachSubfigureRegions } from "./pdf-subfigure-layout.ts";
import { median } from "./pdf-table.ts";
import { attachTableContinuations } from "./pdf-table-continuation.ts";

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

export function normalizedCaptionMatch(text: string): { type: PaperAsset["type"]; identifier: string } | undefined {
	const chinese = /^\s*(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)\s*[：:.]?/.exec(text);
	if (chinese) return { type: chinese[1] === "表" ? "table" : "figure", identifier: chinese[2] };
	return captionMatch(text);
}

export function explicitCaption(text: string): boolean {
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

function denseBodyBlock(block: LayoutBlock, column: PdfBox, bodyLineHeight: number): boolean {
	if (block.lines.length < 3 || horizontalOverlap(block, column) < 0.45) return false;
	const words = block.lines.reduce((count, line) => count + line.words.length, 0);
	if (words < 16 || block.width < column.width * 0.42) return false;
	const ordered = [...block.lines].sort((left, right) => left.y - right.y);
	const gaps = ordered.slice(1).map((line, index) => line.y - (ordered[index].y + ordered[index].height));
	const typicalGap = median(gaps.filter((gap) => gap >= -1));
	return typicalGap <= Math.max(5, bodyLineHeight * 0.8);
}

export function candidateAssetRegion(
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
