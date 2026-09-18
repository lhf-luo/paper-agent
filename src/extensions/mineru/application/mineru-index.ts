import type {
	MineruAssetIndex,
	MineruPackageManifest,
	MineruPackageStatistics,
	MineruSectionIndex,
} from "../domain/mineru-types.ts";

export interface MineruContentBlock {
	type?: string;
	text?: string;
	text_level?: number;
	page_idx?: number;
	img_path?: string;
	image_path?: string;
	caption?: string | string[];
	image_caption?: string | string[];
	image_footnote?: string | string[];
	table_caption?: string | string[];
	table_footnote?: string | string[];
	table_body?: string;
	chart_caption?: string | string[];
	chart_footnote?: string | string[];
	code_caption?: string | string[];
	code_body?: string;
	content?: string;
	bbox?: number[];
}

const ignoredPageTypes = new Set(["header", "footer", "page_header", "page_footer", "page_number"]);

export function mineruPageNumber(block: MineruContentBlock): number {
	return Math.max(1, Number(block.page_idx ?? 0) + 1);
}

export function mineruText(value: string | string[] | undefined): string | undefined {
	const text = Array.isArray(value) ? value.join(" ") : value;
	return text?.trim() || undefined;
}

export function mineruBlockCaption(block: MineruContentBlock): string | undefined {
	return mineruText(
		block.image_caption ?? block.table_caption ?? block.chart_caption ?? block.code_caption ?? block.caption,
	);
}

export function mineruBlockFootnote(block: MineruContentBlock): string | undefined {
	return mineruText(block.image_footnote ?? block.table_footnote ?? block.chart_footnote);
}

export function mineruBlockText(block: MineruContentBlock): string {
	return [
		block.text,
		mineruBlockCaption(block),
		block.table_body,
		block.code_body,
		block.content,
		mineruBlockFootnote(block),
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.join("\n")
		.trim();
}

export function mineruBlockMarkdown(block: MineruContentBlock, assetId?: string): string {
	if (ignoredPageTypes.has(block.type ?? "")) return "";
	const caption = mineruBlockCaption(block);
	const footnote = mineruBlockFootnote(block);
	const marker = assetId ? ` [asset_id=${assetId}]` : "";
	switch (block.type) {
		case "text":
			return block.text?.trim()
				? `${Number.isInteger(block.text_level) ? `${"#".repeat(Math.min(6, Math.max(1, Number(block.text_level))))} ` : ""}${block.text.trim()}`
				: "";
		case "image":
		case "chart":
			return [`${caption ?? (block.type === "chart" ? "Chart" : "Figure")}${marker}`, footnote]
				.filter(Boolean)
				.join("\n");
		case "table":
			return [`${caption ?? "Table"}${marker}`, block.table_body, footnote].filter(Boolean).join("\n");
		case "code":
			return [caption ? `${caption}${marker}` : assetId ? `Code [asset_id=${assetId}]` : undefined, block.code_body]
				.filter(Boolean)
				.join("\n");
		case "equation":
		case "interline_equation":
			return [caption ? `${caption}${marker}` : undefined, block.text ?? block.content].filter(Boolean).join("\n");
		default:
			return mineruBlockText(block);
	}
}

function slug(value: string): string {
	return (
		value
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "section"
	);
}

function identifier(caption: string | undefined, type: string, page: number, ordinal: number): string {
	const patterns =
		type === "table"
			? [/\btable\s+([a-z0-9.-]+)/i, /表\s*([a-z0-9.-]+)/i]
			: [/\b(?:figure|fig\.?|chart)\s+([a-z0-9.-]+)/i, /图\s*([a-z0-9.-]+)/i];
	for (const pattern of patterns) {
		const match = caption?.match(pattern);
		if (match) return `${type === "table" ? "table" : "figure"}-${slug(match[1])}-p${page}`;
	}
	return `${type === "image" ? "figure" : type}-p${page}-${ordinal}`;
}

function markdownHeadingRanges(markdown: string, headings: Array<{ level: number; text: string }>) {
	const lines = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
		level: match[1].length,
		text: match[2].trim(),
		start: match.index,
	}));
	let cursor = 0;
	return headings.map((heading) => {
		const normalized = heading.text.normalize("NFKC").trim().toLowerCase();
		let index = lines.findIndex(
			(line, candidate) =>
				candidate >= cursor &&
				line.level === heading.level &&
				line.text.normalize("NFKC").trim().toLowerCase() === normalized,
		);
		if (index < 0) index = lines.findIndex((line, candidate) => candidate >= cursor && line.level === heading.level);
		if (index < 0) return { start: markdown.length, end: markdown.length };
		cursor = index + 1;
		const next = lines.slice(index + 1).find((line) => line.level <= heading.level);
		return { start: lines[index].start, end: next?.start ?? markdown.length };
	});
}

export function buildMineruIndex(
	blocks: MineruContentBlock[],
	markdown: string,
): {
	sections: MineruSectionIndex[];
	assets: MineruAssetIndex[];
	statistics: MineruPackageStatistics;
} {
	const headings = blocks
		.map((block, blockIndex) => ({ block, blockIndex }))
		.filter(({ block }) => Number.isInteger(block.text_level) && Boolean(block.text?.trim()));
	const markdownRanges = markdownHeadingRanges(
		markdown,
		headings.map(({ block }) => ({ level: Number(block.text_level), text: block.text!.trim() })),
	);
	const sectionIds = new Map<string, number>();
	const sections = headings.map(({ block, blockIndex }, headingIndex) => {
		const level = Number(block.text_level);
		const endHeading = headings.slice(headingIndex + 1).find(({ block: next }) => Number(next.text_level) <= level);
		const end = endHeading?.blockIndex ?? blocks.length;
		const base = `${slug(block.text!)}-p${mineruPageNumber(block)}`;
		const occurrence = (sectionIds.get(base) ?? 0) + 1;
		sectionIds.set(base, occurrence);
		return {
			id: occurrence === 1 ? base : `${base}-${occurrence}`,
			title: block.text!.trim(),
			level,
			startPage: mineruPageNumber(block),
			endPage: blocks.slice(blockIndex, end).reduce((maximum, item) => Math.max(maximum, mineruPageNumber(item)), 1),
			blockRange: { start: blockIndex, end },
			markdownRange: markdownRanges[headingIndex],
		};
	});
	const ordinals = new Map<string, number>();
	const assetIds = new Map<string, number>();
	const assets = blocks.flatMap((block, blockIndex) => {
		const type = block.type ?? "";
		if (!["image", "table", "chart", "equation", "interline_equation", "code"].includes(type)) return [];
		const page = mineruPageNumber(block);
		const key = `${type}:${page}`;
		const ordinal = (ordinals.get(key) ?? 0) + 1;
		ordinals.set(key, ordinal);
		const caption = mineruBlockCaption(block);
		const assetType = type === "interline_equation" ? "equation" : type;
		const baseId = identifier(caption, assetType, page, ordinal);
		const idOccurrence = (assetIds.get(baseId) ?? 0) + 1;
		assetIds.set(baseId, idOccurrence);
		return [
			{
				id: idOccurrence === 1 ? baseId : `${baseId}-${idOccurrence}`,
				type: assetType,
				page,
				caption,
				footnote: mineruBlockFootnote(block),
				path: block.img_path ?? block.image_path,
				bbox: block.bbox,
				hasImage: Boolean(block.img_path ?? block.image_path),
				hasStructuredContent: Boolean(block.table_body ?? block.code_body ?? block.text ?? block.content),
				blockIndex,
			},
		];
	});
	const blockTypes: Record<string, number> = {};
	for (const block of blocks) blockTypes[block.type ?? "unknown"] = (blockTypes[block.type ?? "unknown"] ?? 0) + 1;
	const statistics: MineruPackageStatistics = {
		pages: blocks.reduce((maximum, block) => Math.max(maximum, mineruPageNumber(block)), 0),
		blockTypes,
		textBlocks: blockTypes.text ?? 0,
		tables: blockTypes.table ?? 0,
		figures: blockTypes.image ?? 0,
		charts: blockTypes.chart ?? 0,
		codeBlocks: blockTypes.code ?? 0,
	};
	return { sections, assets, statistics };
}

export function effectiveMineruIndex(manifest: MineruPackageManifest, blocks: MineruContentBlock[], markdown: string) {
	if (
		manifest.schemaVersion === 2 &&
		manifest.sections &&
		manifest.statistics &&
		manifest.assets.every((item) => item.id)
	) {
		return {
			sections: manifest.sections,
			assets: manifest.assets as MineruAssetIndex[],
			statistics: manifest.statistics,
		};
	}
	return buildMineruIndex(blocks, markdown);
}
