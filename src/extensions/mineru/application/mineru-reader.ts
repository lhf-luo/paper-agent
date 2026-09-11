import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PdfMaterialRecord } from "../../../pdf/domain/pdf-material-types.ts";
import type { MineruPackageManifest } from "../domain/mineru-types.ts";

interface MineruContentBlock {
	type?: string;
	text?: string;
	page_idx?: number;
	img_path?: string;
	image_path?: string;
	caption?: string | string[];
}

export type MineruReadMode = "overview" | "pages" | "search";

export interface MineruReadRequest {
	mode?: MineruReadMode;
	pages?: number[];
	query?: string;
	maxCharacters?: number;
}

function blockText(block: MineruContentBlock): string {
	const caption = Array.isArray(block.caption) ? block.caption.join(" ") : block.caption;
	return [block.text, caption].filter(Boolean).join("\n").trim();
}

function pageNumber(block: MineruContentBlock): number {
	return Math.max(1, Number(block.page_idx ?? 0) + 1);
}

export async function readMineruMaterial(material: PdfMaterialRecord, request: MineruReadRequest = {}) {
	const [manifestText, contentText, markdown] = await Promise.all([
		readFile(resolve(material.path, "manifest.json"), "utf8"),
		readFile(resolve(material.path, "content_list.json"), "utf8"),
		readFile(resolve(material.path, "full.md"), "utf8"),
	]);
	const manifest = JSON.parse(manifestText) as MineruPackageManifest;
	const blocks = JSON.parse(contentText) as MineruContentBlock[];
	if (!Array.isArray(blocks)) throw new Error("MinerU content_list.json is invalid");
	const mode = request.mode ?? "overview";
	const maximum = Math.min(Math.max(request.maxCharacters ?? 30_000, 1_000), 80_000);
	let text: string;
	if (mode === "pages") {
		const pages = new Set((request.pages ?? []).filter((page) => Number.isInteger(page) && page > 0).slice(0, 20));
		if (!pages.size) throw new Error("At least one page is required");
		text = blocks
			.filter((block) => pages.has(pageNumber(block)))
			.map((block) => `[page ${pageNumber(block)}] ${blockText(block)}`)
			.filter((value) => !value.endsWith("] "))
			.join("\n\n");
	} else if (mode === "search") {
		const query = request.query?.trim().toLowerCase();
		if (!query) throw new Error("A search query is required");
		text = blocks
			.filter((block) => blockText(block).toLowerCase().includes(query))
			.slice(0, 100)
			.map((block) => `[page ${pageNumber(block)}] ${blockText(block)}`)
			.join("\n\n");
	} else {
		const outline = manifest.headings.map(
			(heading) => `${"#".repeat(Math.min(heading.level, 6))} ${heading.text} (p.${heading.page})`,
		);
		text = [`Pages: ${manifest.pageCount}`, "", ...outline, "", markdown].join("\n");
	}
	return {
		text: text.slice(0, maximum),
		truncated: text.length > maximum,
		manifest,
		material,
	};
}

export function resolveMineruAsset(material: PdfMaterialRecord, assetPath: string): string {
	const root = resolve(material.path);
	const target = resolve(root, assetPath);
	const rel = relative(root, target);
	if (!assetPath || isAbsolute(rel) || rel.startsWith("..")) throw new Error("MinerU asset path is invalid");
	return target;
}
