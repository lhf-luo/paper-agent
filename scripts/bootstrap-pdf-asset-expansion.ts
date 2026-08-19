import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	detectPaperAssets,
	parsePdfTsv,
	refinePaperAssetRegions,
	type PaperAsset,
} from "../src/tools/pdf-asset-tools.ts";

interface ExpansionSource {
	slug: string;
	arxivId: string;
	title: string;
	domains: string[];
}

const sourcesPath = resolve(process.argv[2] ?? "eval-data/expansion-sources.json");
const outputDirectory = resolve(process.argv[3] ?? "eval-data/expansion-candidates");
const pdfDirectory = resolve("eval-data/pdfs");
const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as ExpansionSource[];
const pdftotext = process.env.PDFTOTEXT_BIN || "pdftotext";
const pdftoppm = process.env.PDFTOPPM_BIN || "pdftoppm";
const maximumBytes = 64 * 1024 * 1024;

const pi = {
	async exec(command: string, args: string[], options: { cwd?: string } = {}) {
		const result = spawnSync(command === "pdftoppm" ? pdftoppm : command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: 128 * 1024 * 1024,
		});
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
	},
} as unknown as ExtensionAPI;

function chooseAssets(assets: PaperAsset[], maximum = 6): PaperAsset[] {
	const usable = assets.filter(
		(asset) => asset.candidateRegion.width > 40 && asset.candidateRegion.height > 30 && asset.caption.length < 1_500,
	);
	const selected: PaperAsset[] = [];
	const pages = [...new Set(usable.map((asset) => asset.page))].sort((left, right) => {
		const density = usable.filter((asset) => asset.page === right).length - usable.filter((asset) => asset.page === left).length;
		return density || left - right;
	});
	for (const page of pages) {
		const onPage = usable.filter((asset) => asset.page === page);
		for (const asset of onPage.slice(0, 3)) {
			selected.push(asset);
			if (selected.length >= maximum) break;
		}
		if (selected.length >= maximum) break;
	}
	for (const asset of usable) {
		if (selected.length >= maximum) break;
		if (!selected.includes(asset)) selected.push(asset);
	}
	return selected.sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
}

await mkdir(outputDirectory, { recursive: true });
await mkdir(pdfDirectory, { recursive: true });
for (const source of sources) {
	const pdfPath = join(pdfDirectory, `${source.slug}-${source.arxivId}.pdf`);
	let pdf: Buffer;
	try {
		pdf = await readFile(pdfPath);
	} catch {
		const response = await fetch(`https://arxiv.org/pdf/${encodeURIComponent(source.arxivId)}`, {
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) throw new Error(`${source.slug}: arXiv HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > maximumBytes) throw new Error(`${source.slug}: PDF exceeds byte limit`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > maximumBytes || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
			throw new Error(`${source.slug}: invalid or oversized PDF response`);
		}
		await writeFile(pdfPath, bytes, { flag: "wx" });
		pdf = bytes;
	}
	if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error(`${source.slug}: cached file is not PDF`);
	const layout = spawnSync(pdftotext, ["-tsv", "-r", "72", "-enc", "UTF-8", pdfPath, "-"], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	if (layout.status !== 0) throw new Error(layout.stderr || `${source.slug}: pdftotext failed`);
	const pages = parsePdfTsv(layout.stdout);
	const selected = chooseAssets(detectPaperAssets(pages));
	await refinePaperAssetRegions(pi, pdfPath, pages, selected);
	const annotation = {
		schemaVersion: 2,
		annotationStatus: "detector-bootstrap-requires-human-review",
		pdfPath: `../pdfs/${basename(pdfPath)}`,
		pdfSha256: createHash("sha256").update(pdf).digest("hex"),
		annotatedPages: [...new Set(selected.map((asset) => asset.page))],
		metadata: {
			paperId: `arxiv:${source.arxivId}`,
			title: source.title,
			domains: source.domains,
			layouts: ["expansion", "human-review-required"],
			sourceUrl: `https://arxiv.org/abs/${source.arxivId}`,
		},
		assets: selected.map((asset) => ({
			type: asset.type,
			identifier: asset.identifier,
			page: asset.page,
			region: asset.candidateRegion,
			mentionPages: [...new Set(asset.mentions.map((mention) => mention.page))],
			caption: asset.caption,
		})),
	};
	await writeFile(join(outputDirectory, `${source.slug}.json`), `${JSON.stringify(annotation, null, 2)}\n`);
	console.log(`${source.slug}: ${selected.length} candidates on ${annotation.annotatedPages.length} pages`);
}
