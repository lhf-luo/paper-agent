import type { Stats } from "node:fs";
import { mkdtemp, open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandExecutor } from "../command-executor.ts";

interface ExtractedPdf {
	mtimeMs: number;
	size: number;
	metadata: string;
	pages: string[];
}

interface ReadPdfDetails {
	path: string;
	pageCount: number;
	selectedPages: number[];
	truncated: boolean;
}

interface RenderPdfPageDetails {
	path: string;
	page: number;
	dpi: number;
	renderedPath: string;
}

const pdfCache = new Map<string, ExtractedPdf>();

export async function validatePdfPath(input: string, cwd: string): Promise<string> {
	const absolutePath = resolve(cwd, input.startsWith("@") ? input.slice(1) : input);
	let fileStat: Stats;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		throw new Error(`PDF not found: ${absolutePath}`);
	}
	if (!fileStat.isFile()) {
		throw new Error(`PDF path is not a file: ${absolutePath}`);
	}
	// 用文件内容(%PDF- 魔数)判断, 而不是扩展名——个人库的 blob 路径没有 .pdf 后缀
	const handle = await open(absolutePath, "r");
	try {
		const buffer = Buffer.alloc(5);
		const { bytesRead } = await handle.read(buffer, 0, 5, 0);
		if (bytesRead < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
			throw new Error(`File is not a PDF (missing %PDF- header): ${input}`);
		}
	} finally {
		await handle.close();
	}
	return absolutePath;
}

function selectMetadata(pdfInfo: string): string {
	const wanted = new Set([
		"Title",
		"Author",
		"Subject",
		"Keywords",
		"Creator",
		"Producer",
		"CreationDate",
		"ModDate",
		"Pages",
		"Page size",
		"Encrypted",
	]);
	return pdfInfo
		.split("\n")
		.filter((line) => wanted.has(line.slice(0, line.indexOf(":"))))
		.join("\n");
}

async function extractPdf(pi: CommandExecutor, absolutePath: string, signal?: AbortSignal): Promise<ExtractedPdf> {
	const fileStat = await stat(absolutePath);
	const cached = pdfCache.get(absolutePath);
	if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
		return cached;
	}

	const [textResult, infoResult] = await Promise.all([
		pi.exec("pdftotext", ["-layout", "-enc", "UTF-8", absolutePath, "-"], {
			cwd: dirname(absolutePath),
			signal,
			timeout: 120_000,
		}),
		pi.exec("pdfinfo", [absolutePath], {
			cwd: dirname(absolutePath),
			signal,
			timeout: 30_000,
		}),
	]);

	if (textResult.killed || signal?.aborted || textResult.code !== 0) {
		const reason = signal?.aborted
			? "operation aborted"
			: textResult.killed
				? "pdftotext was terminated or timed out"
				: textResult.stderr.trim() || "pdftotext exited with a non-zero status";
		throw new Error(
			`Could not extract ${basename(absolutePath)}: ${reason}. Install Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).`,
		);
	}

	const pages = textResult.stdout.replaceAll("\r\n", "\n").split("\f");
	if (pages.length > 1 && pages.at(-1)?.trim() === "") {
		pages.pop();
	}
	const extracted: ExtractedPdf = {
		mtimeMs: fileStat.mtimeMs,
		size: fileStat.size,
		metadata: infoResult.code === 0 ? selectMetadata(infoResult.stdout) : "",
		pages: pages.map((page) => page.trimEnd()),
	};
	pdfCache.set(absolutePath, extracted);
	return extracted;
}

export async function getPdfPageCount(
	pi: CommandExecutor,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<number> {
	const result = await pi.exec("pdfinfo", [absolutePath], {
		cwd: dirname(absolutePath),
		signal,
		timeout: 30_000,
	});
	if (result.killed || signal?.aborted || result.code !== 0) {
		const reason = signal?.aborted
			? "operation aborted"
			: result.killed
				? "pdfinfo was terminated or timed out"
				: result.stderr.trim() || "pdfinfo exited with a non-zero status";
		throw new Error(
			`Could not inspect ${basename(absolutePath)}: ${reason}. Install Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).`,
		);
	}
	const match = /^Pages:\s+(\d+)\s*$/m.exec(result.stdout);
	const pageCount = match ? Number(match[1]) : Number.NaN;
	if (!Number.isInteger(pageCount) || pageCount < 1) {
		throw new Error(`pdfinfo did not report a valid page count for ${absolutePath}`);
	}
	return pageCount;
}

export function parsePageSelection(selection: string | undefined, pageCount: number): number[] {
	if (selection === undefined || selection.trim() === "") {
		return Array.from({ length: Math.min(4, pageCount) }, (_value, index) => index + 1);
	}
	const normalized = selection.trim().toLowerCase();
	if (normalized === "all") {
		return Array.from({ length: pageCount }, (_value, index) => index + 1);
	}

	const selected = new Set<number>();
	for (const part of normalized.split(",")) {
		const token = part.trim();
		const single = /^(\d+)$/.exec(token);
		if (single) {
			selected.add(Number(single[1]));
			continue;
		}
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
		if (!range) {
			throw new Error(`Invalid page selection "${selection}". Use forms such as "1-4,7,10-12" or "all".`);
		}
		const start = Number(range[1]);
		const end = Number(range[2]);
		if (start > end) {
			throw new Error(`Invalid descending page range: ${token}`);
		}
		for (let page = start; page <= end; page++) {
			selected.add(page);
		}
	}

	const result = [...selected].sort((left, right) => left - right);
	if (result.length === 0 || result.some((page) => page < 1 || page > pageCount)) {
		throw new Error(`Page selection must stay within 1-${pageCount}. Received: ${selection}`);
	}
	return result;
}

export function registerPdfTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description:
			"Extract text from selected PDF pages with explicit page markers. Defaults to pages 1-4. Read every page range, including appendices, before producing a full paper review. If a figure, table, equation, or scanned page is unclear, use render_pdf_page. Requires Poppler commands pdftotext and pdfinfo.",
		promptSnippet: "Read page ranges and metadata from a PDF paper",
		promptGuidelines: [
			"Use read_pdf in bounded page ranges and cover the complete paper before making paper-wide claims.",
			"Cite PDF evidence with the physical PDF page number reported by read_pdf, plus section, figure, or table identifiers when available.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			pages: Type.Optional(
				Type.String({ description: 'Physical PDF pages, for example "1-4,7,10-12" or "all"; default: "1-4"' }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const extracted = await extractPdf(pi, absolutePath, signal);
			const selectedPages = parsePageSelection(params.pages, extracted.pages.length);
			const pageText = selectedPages
				.map((page) => `\n===== PDF PAGE ${page} =====\n${extracted.pages[page - 1]}`)
				.join("\n");
			const header = [
				`PDF: ${absolutePath}`,
				`Extracted pages: ${extracted.pages.length}`,
				extracted.metadata ? `Metadata:\n${extracted.metadata}` : "Metadata: unavailable",
				"Page index (physical_page:extracted_characters):",
				extracted.pages.map((page, index) => `${index + 1}:${page.length}`).join("  "),
				`Selected pages: ${selectedPages.join(", ")}`,
			].join("\n");
			const fullOutput = `${header}\n${pageText}`;
			const truncation = truncateHead(fullOutput, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});
			let output = truncation.content;
			if (truncation.truncated) {
				output += `\n\n[Output truncated at ${formatSize(truncation.maxBytes)} or ${truncation.maxLines} lines. Re-read fewer pages; do not treat this result as complete.]`;
			}
			if (extracted.pages.every((page) => page.trim().length < 40)) {
				output +=
					"\n\n[Extraction warning: almost no text was recovered. This PDF may be scanned or text may be encoded unusually. Inspect pages with render_pdf_page.]";
			}

			const details: ReadPdfDetails = {
				path: absolutePath,
				pageCount: extracted.pages.length,
				selectedPages,
				truncated: truncation.truncated,
			};
			return { content: [{ type: "text", text: output }], details };
		},
	});

	pi.registerTool({
		name: "render_pdf_page",
		label: "Render PDF page",
		description:
			"Render one physical PDF page to PNG for visual inspection of figures, tables, equations, diagrams, or scanned text. Use only for pages whose visual layout matters. Requires Poppler command pdftoppm.",
		promptSnippet: "Render a PDF page as an image for visual inspection",
		promptGuidelines: [
			"Use render_pdf_page when read_pdf loses figure, table, equation, or multi-column layout information.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "PDF path, relative to the working directory or absolute" }),
			page: Type.Integer({ minimum: 1, description: "Physical PDF page number" }),
			dpi: Type.Optional(
				Type.Integer({ minimum: 72, maximum: 220, description: "Render resolution; default: 144" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absolutePath = await validatePdfPath(params.path, ctx.cwd);
			const dpi = params.dpi ?? 144;
			const outputDirectory = await mkdtemp(join(tmpdir(), "pi-paper-page-"));
			const outputPrefix = join(outputDirectory, `page-${params.page}`);
			const result = await pi.exec(
				"pdftoppm",
				[
					"-f",
					String(params.page),
					"-l",
					String(params.page),
					"-singlefile",
					"-png",
					"-r",
					String(dpi),
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
				throw new Error(
					`Could not render page ${params.page}: ${reason}. Install Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).`,
				);
			}

			const renderedPath = `${outputPrefix}.png`;
			const image = await readFile(renderedPath);
			const details: RenderPdfPageDetails = {
				path: absolutePath,
				page: params.page,
				dpi,
				renderedPath,
			};
			return {
				content: [
					{ type: "text", text: `Rendered physical PDF page ${params.page} at ${dpi} DPI from ${absolutePath}` },
					{ type: "image", mimeType: "image/png", data: image.toString("base64") },
				],
				details,
			};
		},
	});
}
