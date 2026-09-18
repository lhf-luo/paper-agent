import type { Stats } from "node:fs";
import { mkdtemp, open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { parsePageSelection, validatePdfPath } from "../application/pdf-document.ts";

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

export function registerPdfTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description:
			"Extract text from selected original-PDF pages with explicit physical-page markers. Defaults to pages 1-4. Use it to verify decisive claims, values, quotations, equations, conflicts, and limitations located through MinerU, or as the reading fallback when no current MinerU package exists. Requires Poppler commands pdftotext and pdfinfo.",
		promptSnippet: "Read page ranges and metadata from a PDF paper",
		promptGuidelines: [
			"Use bounded page ranges for targeted original-PDF verification. When current MinerU material is unavailable, cover the required PDF scope directly before making paper-wide claims.",
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

	pi.registerTool({
		name: "read_text_file",
		label: "Read local text file",
		description:
			"Read a local UTF-8 text file (markdown .md, plain text .txt, JSON, log, config) from the project directory. Returns the file content (truncated to a safe size). Use this for skill reference documents, generated markdown results, configuration, or any local text artifact that is not a PDF.",
		promptSnippet: "Read a local text/markdown file from the project",
		promptGuidelines: [
			"Path is relative to the working directory or absolute. Only files inside the project directory can be read.",
			"Use for .md/.txt/.json/.log and other text files; for PDFs use read_pdf instead.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Text file path, relative to the working directory or absolute" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Byte offset to start reading from; default: 0" }),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 200_000, description: "Max bytes to read; default: 20000" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path.startsWith("@") ? params.path.slice(1) : params.path);
			const projectRoot = ctx.cwd;
			// 只允许读取项目目录内的文件, 防止 agent 读取任意系统文件。
			if (!absolutePath.startsWith(projectRoot + sep)) {
				throw new Error(`Only files inside the project directory (${projectRoot}) can be read: ${absolutePath}`);
			}
			let fileStat: Stats;
			try {
				fileStat = await stat(absolutePath);
			} catch {
				throw new Error(`File not found: ${absolutePath}`);
			}
			if (!fileStat.isFile()) throw new Error(`Not a file: ${absolutePath}`);
			if (fileStat.size > 2_000_000) throw new Error(`File too large (${formatSize(fileStat.size)}); max 2MB`);
			const offset = Math.max(0, params.offset ?? 0);
			const limit = Math.max(1, Math.min(params.limit ?? 20_000, 200_000));
			const handle = await open(absolutePath, "r");
			let content: string;
			try {
				const buffer = Buffer.alloc(limit);
				const { bytesRead } = await handle.read(buffer, 0, limit, offset);
				content = buffer.subarray(0, bytesRead).toString("utf8");
			} finally {
				await handle.close();
			}
			const truncated = offset + content.length < fileStat.size;
			const header = [
				`File: ${absolutePath}`,
				`Size: ${formatSize(fileStat.size)}; showing bytes ${offset}-${offset + content.length} (truncated: ${truncated ? "yes" : "no"})`,
			].join("\n");
			return {
				content: [{ type: "text", text: `${header}\n\n${content}` }],
				details: {
					path: absolutePath,
					size: fileStat.size,
					offset,
					readBytes: content.length,
					truncated,
				},
			};
		},
	});
}
