import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PdfMaterialRecord } from "../../../pdf/domain/pdf-material-types.ts";
import type { MineruAssetIndex, MineruPackageManifest } from "../domain/mineru-types.ts";
import {
	effectiveMineruIndex,
	type MineruContentBlock,
	mineruBlockMarkdown,
	mineruBlockText,
	mineruPageNumber,
} from "./mineru-index.ts";

export type MineruReadMode = "overview" | "sections" | "markdown" | "pages" | "search" | "assets";

export interface MineruReadRequest {
	mode: MineruReadMode;
	sectionIds?: string[];
	pages?: number[];
	queries?: string[];
	assetIds?: string[];
	contextBlocks?: number;
	maxMatches?: number;
	cursor?: string;
	maxCharacters?: number;
}

interface CursorPayload {
	v: 1;
	mode: MineruReadMode;
	offset: number;
	key: string;
}

interface PageItem {
	text: string;
	page?: number;
	blockIndex?: number;
}

export interface MineruAssetReadResult extends MineruAssetIndex {
	structuredContent?: string;
	resolvedPath?: string;
}

function cursorKey(mode: MineruReadMode, values: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify([mode, values]))
		.digest("hex")
		.slice(0, 16);
}

function encodeCursor(payload: CursorPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, mode: MineruReadMode, key: string): number {
	if (!value) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorPayload;
		if (
			parsed.v !== 1 ||
			parsed.mode !== mode ||
			parsed.key !== key ||
			!Number.isInteger(parsed.offset) ||
			parsed.offset < 0
		) {
			throw new Error("invalid");
		}
		return parsed.offset;
	} catch {
		throw new Error("The MinerU cursor is invalid or belongs to a different request");
	}
}

function markdownBlocks(markdown: string): string[] {
	if (!markdown) return [];
	const blocks: string[] = [];
	let start = 0;
	for (const match of markdown.matchAll(/\n[ \t]*\n+/g)) {
		const end = (match.index ?? start) + match[0].length;
		blocks.push(markdown.slice(start, end));
		start = end;
	}
	if (start < markdown.length) blocks.push(markdown.slice(start));
	return blocks;
}

function paginate(
	items: PageItem[],
	mode: MineruReadMode,
	key: string,
	cursor: string | undefined,
	maximum: number,
	separator = "\n\n",
) {
	const offset = decodeCursor(cursor, mode, key);
	if (offset > items.length) throw new Error("The MinerU cursor is past the end of this result");
	const selected: PageItem[] = [];
	let length = 0;
	for (let index = offset; index < items.length; index += 1) {
		const addition = items[index].text.length + (selected.length ? separator.length : 0);
		if (selected.length && length + addition > maximum) break;
		selected.push(items[index]);
		length += addition;
	}
	const nextOffset = offset + selected.length;
	const truncated = nextOffset < items.length;
	return {
		body: selected.map((item) => item.text).join(separator),
		truncated,
		nextCursor: truncated ? encodeCursor({ v: 1, mode, offset: nextOffset, key }) : undefined,
		selected,
		range: { start: offset, end: nextOffset, total: items.length, key },
	};
}

function readAssetContent(block: MineruContentBlock): string | undefined {
	return block.table_body ?? block.code_body ?? block.text ?? block.content;
}

function formatText(mode: MineruReadMode, body: string, truncated: boolean, nextCursor?: string): string {
	return [
		`MinerU mode: ${mode}`,
		body,
		`truncated: ${truncated ? "true" : "false"}`,
		`next_cursor: ${nextCursor ?? "none"}`,
	].join("\n\n");
}

export async function readMineruMaterial(material: PdfMaterialRecord, request: MineruReadRequest) {
	const [manifestText, contentText, markdown] = await Promise.all([
		readFile(resolve(material.path, "manifest.json"), "utf8"),
		readFile(resolve(material.path, "content_list.json"), "utf8"),
		readFile(resolve(material.path, "full.md"), "utf8"),
	]);
	const manifest = JSON.parse(manifestText) as MineruPackageManifest;
	const blocks = JSON.parse(contentText) as MineruContentBlock[];
	if (!Array.isArray(blocks)) throw new Error("MinerU content_list.json is invalid");
	const mode = request.mode;
	const maximum = Math.min(Math.max(request.maxCharacters ?? 30_000, 1_000), 80_000);
	const index = effectiveMineruIndex(manifest, blocks, markdown);
	const assetByBlock = new Map(index.assets.map((asset) => [asset.blockIndex, asset]));
	let body = "";
	let truncated = false;
	let nextCursor: string | undefined;
	let selectedPages: number[] = [];
	const selectedSectionIds: string[] = [];
	let selectedBlockIndexes: number[] = [];
	let cursorRange: { start: number; end: number; total: number; key: string } | undefined;
	let pageBlocks: Array<{ page: number; selected: number[]; total: number[] }> = [];
	const assetResults: MineruAssetReadResult[] = [];
	const unknownAssetIds: string[] = [];

	if (mode === "overview") {
		const navigation = index.sections.map(
			(section) =>
				`${"  ".repeat(Math.max(0, section.level - 1))}- ${section.id} | pp.${section.startPage}-${section.endPage} | ${section.title}`,
		);
		const assets = index.assets.map(
			(asset) => `- ${asset.id} | ${asset.type} | p.${asset.page}${asset.caption ? ` | ${asset.caption}` : ""}`,
		);
		body = [
			`source_sha256: ${material.sourceSha256}`,
			`schema_version: ${manifest.schemaVersion}`,
			`pages: ${index.statistics.pages}`,
			`blocks: ${Object.values(index.statistics.blockTypes).reduce((sum, count) => sum + count, 0)}`,
			`text=${index.statistics.textBlocks}, tables=${index.statistics.tables}, figures=${index.statistics.figures}, charts=${index.statistics.charts}, code=${index.statistics.codeBlocks}`,
			manifest.schemaVersion === 1 ? "warning: legacy schema-v1 package; navigation was indexed at read time" : "",
			"Sections:",
			...navigation,
			"Assets:",
			...assets,
		]
			.filter(Boolean)
			.join("\n");
	} else if (mode === "markdown") {
		const items = markdownBlocks(markdown).map((text) => ({ text }));
		const key = cursorKey(mode, material.contentSha256);
		const page = paginate(items, mode, key, request.cursor, maximum, "");
		({ body, truncated, nextCursor } = page);
		cursorRange = page.range;
	} else if (mode === "sections") {
		const ids = [...new Set(request.sectionIds ?? [])].slice(0, 12);
		if (!ids.length) throw new Error("sections mode requires at least one section_id");
		const sections = ids.map((id) => index.sections.find((section) => section.id === id));
		const unknown = ids.filter((_id, position) => !sections[position]);
		if (unknown.length) throw new Error(`Unknown MinerU section IDs: ${unknown.join(", ")}`);
		const items: PageItem[] = [];
		for (const section of sections) {
			if (!section) continue;
			selectedSectionIds.push(section.id);
			const relatedAssets = index.assets
				.filter(
					(asset) => asset.blockIndex >= section.blockRange.start && asset.blockIndex < section.blockRange.end,
				)
				.map((asset) => asset.id);
			items.push({
				text: `<!-- section_id=${section.id}; pages=${section.startPage}-${section.endPage}; assets=${relatedAssets.join(",") || "none"} -->\n`,
			});
			items.push(
				...markdownBlocks(markdown.slice(section.markdownRange.start, section.markdownRange.end)).map((text) => ({
					text,
				})),
			);
		}
		const key = cursorKey(mode, [material.contentSha256, ids]);
		const page = paginate(items, mode, key, request.cursor, maximum, "");
		({ body, truncated, nextCursor } = page);
		cursorRange = page.range;
	} else if (mode === "pages") {
		const pages = [...new Set((request.pages ?? []).filter((page) => Number.isInteger(page) && page > 0))].slice(
			0,
			20,
		);
		if (!pages.length) throw new Error("pages mode requires at least one page");
		selectedPages = pages;
		const pageSet = new Set(pages);
		const items = blocks.flatMap((block, blockIndex) => {
			const page = mineruPageNumber(block);
			if (!pageSet.has(page)) return [];
			const rendered = mineruBlockMarkdown(block, assetByBlock.get(blockIndex)?.id);
			return rendered
				? [{ text: `[page ${page}] [${block.type ?? "unknown"}]\n${rendered}`, page, blockIndex }]
				: [];
		});
		const key = cursorKey(mode, [material.contentSha256, pages]);
		const page = paginate(items, mode, key, request.cursor, maximum);
		({ body, truncated, nextCursor } = page);
		selectedBlockIndexes = page.selected.flatMap((item) => (item.blockIndex === undefined ? [] : [item.blockIndex]));
		cursorRange = page.range;
		pageBlocks = pages.map((selectedPage) => ({
			page: selectedPage,
			selected: selectedBlockIndexes.filter((blockIndex) => mineruPageNumber(blocks[blockIndex]) === selectedPage),
			total: items
				.filter((item) => item.page === selectedPage)
				.flatMap((item) => (item.blockIndex === undefined ? [] : [item.blockIndex])),
		}));
	} else if (mode === "search") {
		const queries = [...new Set((request.queries ?? []).map((query) => query.trim()).filter(Boolean))].slice(0, 8);
		if (!queries.length) throw new Error("search mode requires at least one query");
		const normalized = queries.map((query) => query.toLocaleLowerCase());
		const context = Math.min(Math.max(request.contextBlocks ?? 1, 0), 3);
		const maximumMatches = Math.min(Math.max(request.maxMatches ?? 50, 1), 100);
		const matches = blocks
			.map((block, blockIndex) => ({ block, blockIndex, text: mineruBlockText(block) }))
			.filter(({ text }) => text && normalized.some((query) => text.toLocaleLowerCase().includes(query)))
			.slice(0, maximumMatches);
		const items = matches.map(({ block, blockIndex }) => {
			const first = Math.max(0, blockIndex - context);
			const last = Math.min(blocks.length, blockIndex + context + 1);
			const nearby = blocks
				.slice(first, last)
				.map((item, offset) => mineruBlockMarkdown(item, assetByBlock.get(first + offset)?.id))
				.filter(Boolean)
				.join("\n\n");
			const section = [...index.sections]
				.reverse()
				.find((candidate) => blockIndex >= candidate.blockRange.start && blockIndex < candidate.blockRange.end);
			return {
				text: `[match block=${blockIndex} page=${mineruPageNumber(block)} section=${section?.id ?? "none"} asset=${assetByBlock.get(blockIndex)?.id ?? "none"}]\n${nearby}`,
				page: mineruPageNumber(block),
				blockIndex,
			};
		});
		const key = cursorKey(mode, [material.contentSha256, queries, context, maximumMatches]);
		const page = paginate(items, mode, key, request.cursor, maximum);
		({ body, truncated, nextCursor } = page);
		cursorRange = page.range;
		selectedPages = [...new Set(page.selected.flatMap((item) => (item.page === undefined ? [] : [item.page])))];
		selectedBlockIndexes = page.selected.flatMap((item) => (item.blockIndex === undefined ? [] : [item.blockIndex]));
	} else if (mode === "assets") {
		const ids = [...new Set(request.assetIds ?? [])].slice(0, 8);
		if (!ids.length) throw new Error("assets mode requires at least one asset_id");
		for (const id of ids) {
			const asset = index.assets.find((candidate) => candidate.id === id);
			if (!asset) {
				unknownAssetIds.push(id);
				continue;
			}
			const block = blocks[asset.blockIndex];
			assetResults.push({
				...asset,
				structuredContent: readAssetContent(block),
				resolvedPath: asset.path ? resolveMineruAsset(material, asset.path) : undefined,
			});
		}
		body = [
			...assetResults.map(
				(asset) =>
					`asset_id=${asset.id} | type=${asset.type} | page=${asset.page}\n${[asset.caption, asset.structuredContent, asset.footnote].filter(Boolean).join("\n")}`,
			),
			...(unknownAssetIds.length ? [`unknown_asset_ids: ${unknownAssetIds.join(", ")}`] : []),
		].join("\n\n");
	}

	return {
		text: formatText(mode, body, truncated, nextCursor),
		body,
		mode,
		truncated,
		nextCursor,
		manifest: { ...manifest, sections: index.sections, assets: index.assets, statistics: index.statistics },
		material,
		selectedPages,
		selectedSectionIds,
		selectedBlockIndexes,
		cursorRange,
		pageBlocks,
		assetResults,
		unknownAssetIds,
		fullMarkdownComplete: mode === "markdown" && !truncated && !request.cursor,
	};
}

export function resolveMineruAsset(material: PdfMaterialRecord, assetPath: string): string {
	const root = resolve(material.path);
	const target = resolve(root, assetPath);
	const rel = relative(root, target);
	if (!assetPath || isAbsolute(rel) || rel.startsWith("..")) throw new Error("MinerU asset path is invalid");
	return target;
}
