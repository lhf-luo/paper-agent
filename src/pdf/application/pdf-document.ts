import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";

export async function validatePdfPath(input: string, cwd: string): Promise<string> {
	const absolutePath = resolve(cwd, input.startsWith("@") ? input.slice(1) : input);
	let fileStat: Stats;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		throw new Error(`PDF not found: ${absolutePath}`);
	}
	if (!fileStat.isFile()) throw new Error(`PDF path is not a file: ${absolutePath}`);
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

export async function getPdfPageCount(
	executor: CommandExecutor,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<number> {
	const result = await executor.exec("pdfinfo", [absolutePath], {
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
	if (normalized === "all") return Array.from({ length: pageCount }, (_value, index) => index + 1);

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
		if (start > end) throw new Error(`Invalid descending page range: ${token}`);
		for (let page = start; page <= end; page++) selected.add(page);
	}

	const result = [...selected].sort((left, right) => left - right);
	if (result.length === 0 || result.some((page) => page < 1 || page > pageCount)) {
		throw new Error(`Page selection must stay within 1-${pageCount}. Received: ${selection}`);
	}
	return result;
}
