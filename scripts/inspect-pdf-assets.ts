import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { detectPaperAssets, parsePdfTsv } from "../src/tools/pdf-asset-tools.ts";

const pdfs = process.argv.slice(2);
if (pdfs.length === 0) {
	throw new Error("Usage: node scripts/inspect-pdf-assets.ts <paper.pdf> [...]");
}

const pdftotext = process.env.PDFTOTEXT_BIN || "pdftotext";
for (const input of pdfs) {
	const pdfPath = resolve(input);
	const layout = spawnSync(pdftotext, ["-tsv", "-r", "72", "-enc", "UTF-8", pdfPath, "-"], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	if (layout.status !== 0) throw new Error(layout.stderr || `pdftotext failed for ${pdfPath}`);
	const pages = parsePdfTsv(layout.stdout);
	const assets = detectPaperAssets(pages);
	const data = readFileSync(pdfPath);
	console.log(
		JSON.stringify({
			file: basename(pdfPath),
			path: pdfPath,
			sha256: createHash("sha256").update(data).digest("hex"),
			pageCount: pages.length,
			pageSizes: pages.map((page) => ({ page: page.page, width: page.width, height: page.height })),
			assets,
		}),
	);
}
