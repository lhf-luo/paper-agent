import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MineruPackageManifest } from "../domain/mineru-types.ts";
import { inspectExtractedTree } from "../infrastructure/mineru-archive.ts";

interface ContentBlock {
	type?: string;
	text?: string;
	text_level?: number;
	page_idx?: number;
	img_path?: string;
	image_path?: string;
	caption?: string | string[];
}

function captionText(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value.join(" ").trim() || undefined : value?.trim() || undefined;
}

function locate(files: Array<{ path: string }>, pattern: RegExp): string | undefined {
	return files.map((file) => file.path).find((path) => pattern.test(basename(path)));
}

export async function normalizeMineruPackage(input: {
	rawRoot: string;
	normalizedRoot: string;
	sourceSha256: string;
	modelVersion: "pipeline" | "vlm";
	createdAt: string;
}): Promise<{ manifest: MineruPackageManifest; contentSha256: string; fileCount: number; bytes: number }> {
	const rawFiles = await inspectExtractedTree(input.rawRoot);
	const markdownPath = locate(rawFiles, /^full\.md$/i) ?? locate(rawFiles, /\.md$/i);
	const contentListPath = locate(rawFiles, /(?:^|_)content_list\.json$/i);
	if (!markdownPath || !contentListPath) {
		throw new Error("MinerU package must contain full.md and content_list.json");
	}
	const packageRoot = dirname(join(input.rawRoot, markdownPath));
	await rm(input.normalizedRoot, { recursive: true, force: true });
	await mkdir(input.normalizedRoot, { recursive: true });
	const normalizedMarkdownPath = join(input.normalizedRoot, "full.md");
	await copyFile(join(input.rawRoot, markdownPath), normalizedMarkdownPath);
	const normalizedContentPath = join(input.normalizedRoot, "content_list.json");
	await copyFile(join(input.rawRoot, contentListPath), normalizedContentPath);
	for (const [pattern, target] of [
		[/(?:^|_)content_list_v2\.json$/i, "content_list_v2.json"],
		[/(?:^|_)layout\.json$/i, "layout.json"],
	] as const) {
		const source = locate(rawFiles, pattern);
		if (source) await copyFile(join(input.rawRoot, source), join(input.normalizedRoot, target));
	}
	const imagesRoot = join(packageRoot, "images");
	await cp(imagesRoot, join(input.normalizedRoot, "images"), { recursive: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		},
	);
	const markdown = await readFile(normalizedMarkdownPath);
	let blocks: ContentBlock[];
	try {
		const parsed = JSON.parse(await readFile(normalizedContentPath, "utf8")) as unknown;
		if (!Array.isArray(parsed)) throw new Error("not an array");
		blocks = parsed as ContentBlock[];
	} catch {
		throw new Error("MinerU content_list.json is invalid");
	}
	const page = (block: ContentBlock) => Math.max(1, Number(block.page_idx ?? 0) + 1);
	const pageCount = blocks.reduce((maximum, block) => Math.max(maximum, page(block)), 0);
	const headings = blocks
		.filter((block) => Number.isInteger(block.text_level) && block.text?.trim())
		.map((block) => ({ level: Number(block.text_level), text: block.text!.trim(), page: page(block) }));
	const assets = blocks
		.filter((block) => ["image", "table", "equation", "interline_equation"].includes(block.type ?? ""))
		.map((block) => ({
			type: block.type ?? "unknown",
			path: block.img_path ?? block.image_path,
			caption: captionText(block.caption),
			page: page(block),
		}));
	const beforeManifest = await inspectExtractedTree(input.normalizedRoot);
	const manifest: MineruPackageManifest = {
		schemaVersion: 1,
		engine: "mineru",
		sourceSha256: input.sourceSha256,
		modelVersion: input.modelVersion,
		createdAt: input.createdAt,
		pageCount,
		headings,
		assets,
		files: [...beforeManifest.map((file) => file.path), "manifest.json"].sort(),
	};
	await writeFile(join(input.normalizedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	const files = await inspectExtractedTree(input.normalizedRoot);
	return {
		manifest,
		contentSha256: createHash("sha256").update(markdown).digest("hex"),
		fileCount: files.length,
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
	};
}

export async function replaceDirectory(
	preparedRoot: string,
	targetRoot: string,
	backupRoot: string,
	commit: () => Promise<void>,
): Promise<void> {
	await rm(backupRoot, { recursive: true, force: true });
	let hadExisting = false;
	try {
		await rename(targetRoot, backupRoot);
		hadExisting = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		await rename(preparedRoot, targetRoot);
		await commit();
	} catch (error) {
		await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
		if (hadExisting) await rename(backupRoot, targetRoot).catch(() => undefined);
		throw error;
	}
	await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
}
