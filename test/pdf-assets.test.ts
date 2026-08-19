import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	attachSubfigureRegions,
	augmentPaperAssetsWithOcr,
	buildTableGrid,
	detectPaperAssets,
	type LayoutWord,
	type PaperAsset,
	type PdfLayoutPage,
	parsePdfImagesList,
	parsePdfTsv,
	refineSubfigureRegionsFromGrayImage,
	registerPdfAssetTools,
} from "../src/tools/pdf-asset-tools.ts";
import { registerProgressTool } from "../src/tools/progress-tools.ts";

const tsv = [
	"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
	"1\t4\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
	"3\t4\t0\t0\t0\t0\t60\t300\t240\t20\t-1\t###FLOW###",
	"4\t4\t0\t0\t0\t0\t60\t300\t240\t8\t-1\t###LINE###",
	"5\t4\t0\t0\t0\t0\t60\t300\t24\t8\t100\tFigure",
	"5\t4\t0\t0\t0\t1\t88\t300\t8\t8\t100\t3.",
	"5\t4\t0\t0\t0\t2\t100\t300\t80\t8\t100\tPipeline",
	"4\t4\t0\t0\t1\t0\t60\t310\t240\t8\t-1\t###LINE###",
	"5\t4\t0\t0\t1\t0\t60\t310\t40\t8\t100\tSecond\tline",
	"3\t4\t1\t0\t0\t0\t60\t400\t240\t8\t-1\t###FLOW###",
	"4\t4\t1\t0\t0\t0\t60\t400\t240\t8\t-1\t###LINE###",
	"5\t4\t1\t0\t0\t0\t60\t400\t24\t8\t100\tFigure",
	"5\t4\t1\t0\t0\t1\t88\t400\t8\t8\t100\t3",
	"5\t4\t1\t0\t0\t2\t100\t400\t34\t8\t100\tpresents",
].join("\n");

function word(text: string, x: number, y: number): LayoutWord {
	return {
		page: 1,
		order: 0,
		text,
		x,
		y,
		width: Math.max(10, text.length * 5),
		height: 10,
		blockId: "1:0:0",
		lineId: `1:0:0:${y}`,
	};
}

describe("paper-agent PDF asset parsing", () => {
	it("emits explicit subfigure regions for labeled multi-panel figures", () => {
		const assets: PaperAsset[] = [
			{
				id: "figure-4-p2",
				type: "figure",
				identifier: "4",
				page: 2,
				caption: "Figure 4: (b) Proposed method. (a) Baseline. (d) Failure case. (c) Ablation.",
				captionBox: { x: 50, y: 410, width: 500, height: 35 },
				candidateRegion: { x: 50, y: 80, width: 500, height: 365 },
				regionConfidence: "medium",
				mentions: [],
			},
		];
		attachSubfigureRegions(assets);
		expect(assets[0].subfigureRegions?.map((item) => item.label)).toEqual(["a", "b", "c", "d"]);
		expect(assets[0].subfigureRegions).toHaveLength(4);
		expect(new Set(assets[0].subfigureRegions?.map((item) => item.region.x)).size).toBe(4);
		expect(assets[0].subfigureRegions?.every((item) => item.region.y < assets[0].captionBox.y)).toBe(true);
	});

	it("moves a nominal subfigure split toward a visual whitespace gutter", () => {
		const page: PdfLayoutPage = { page: 1, width: 100, height: 100, blocks: [], lines: [], words: [] };
		const pixels = new Uint8Array(10_000).fill(255);
		for (let y = 5; y < 75; y++) {
			for (let x = 5; x < 55; x++) pixels[y * 100 + x] = 0;
			for (let x = 64; x < 96; x++) pixels[y * 100 + x] = 0;
		}
		const figure: PaperAsset = {
			id: "figure-1-p1",
			type: "figure",
			identifier: "1",
			page: 1,
			caption: "Figure 1: (a) left. (b) right.",
			captionBox: { x: 0, y: 80, width: 100, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 100, height: 90 },
			regionConfidence: "medium",
			mentions: [],
			subfigureRegions: [
				{ label: "a", region: { x: 0, y: 0, width: 50, height: 80 }, confidence: "medium" },
				{ label: "b", region: { x: 50, y: 0, width: 50, height: 80 }, confidence: "medium" },
			],
		};
		refineSubfigureRegionsFromGrayImage(figure, page, { width: 100, height: 100, pixels });
		const split = figure.subfigureRegions?.[0].region.width ?? 0;
		expect(split).toBeGreaterThanOrEqual(56);
		expect(split).toBeLessThanOrEqual(62);
		expect(figure.subfigureRegions?.[1].region.x).toBe(split);
	});

	it("uses extracted subfigure labels to recover a vertical panel layout", () => {
		const page: PdfLayoutPage = {
			page: 1,
			width: 100,
			height: 100,
			blocks: [],
			lines: [],
			words: [word("(a)", 45, 15), word("(b)", 45, 55)],
		};
		const figure: PaperAsset = {
			id: "figure-2-p1",
			type: "figure",
			identifier: "2",
			page: 1,
			caption: "Figure 2: (a) training. (b) validation.",
			captionBox: { x: 0, y: 85, width: 100, height: 10 },
			candidateRegion: { x: 0, y: 0, width: 100, height: 90 },
			regionConfidence: "medium",
			mentions: [],
			subfigureRegions: [
				{ label: "a", region: { x: 0, y: 0, width: 50, height: 80 }, confidence: "medium" },
				{ label: "b", region: { x: 50, y: 0, width: 50, height: 80 }, confidence: "medium" },
			],
		};
		refineSubfigureRegionsFromGrayImage(figure, page, {
			width: 100,
			height: 100,
			pixels: new Uint8Array(10_000).fill(255),
		});
		expect(figure.subfigureRegions?.[0].region).toMatchObject({ x: 0, y: 0, width: 100, height: 40 });
		expect(figure.subfigureRegions?.[1].region).toMatchObject({ x: 0, y: 40, width: 100, height: 40 });
	});

	it("uses OCR to discover captions on sparse pages with no text-layer assets", async () => {
		const page: PdfLayoutPage = { page: 1, width: 100, height: 100, blocks: [], lines: [], words: [] };
		const pi = {
			async exec(command: string, args: string[]) {
				if (command === "pdftoppm") {
					const prefix = args.at(-1);
					if (!prefix) throw new Error("render prefix missing");
					await writeFile(
						`${prefix}.pgm`,
						Buffer.concat([Buffer.from("P5\n100 100\n255\n"), Buffer.alloc(10_000, 255)]),
					);
					return { code: 0, stdout: "", stderr: "", killed: false };
				}
				if (command !== "tesseract" || !args.includes("tsv")) throw new Error(`unexpected OCR command: ${command}`);
				return {
					code: 0,
					stdout:
						"level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
						"5\t1\t1\t1\t1\t1\t10\t70\t20\t8\t95\tFigure\n" +
						"5\t1\t1\t1\t1\t2\t32\t70\t8\t8\t95\t1:\n" +
						"5\t1\t1\t1\t1\t3\t42\t70\t25\t8\t95\tScanned\n" +
						"5\t1\t1\t1\t1\t4\t69\t70\t20\t8\t95\tresult\n",
					stderr: "",
					killed: false,
				};
			},
		} as unknown as ExtensionAPI;
		const assets = await augmentPaperAssetsWithOcr(pi, "paper.pdf", [page], []);
		expect(assets).toMatchObject([{ type: "figure", identifier: "1", page: 1, caption: "Figure 1: Scanned result" }]);
	});

	it("parses Poppler TSV hierarchy and preserves tabs in text", () => {
		const [page] = parsePdfTsv(tsv);

		expect(page.page).toBe(4);
		expect(page.width).toBe(612);
		expect(page.lines).toHaveLength(3);
		expect(page.lines[0].text).toBe("Figure 3. Pipeline");
		expect(page.lines[1].words[0].text).toBe("Second\tline");
	});

	it("detects a caption and reports a bounded low-confidence candidate region", () => {
		const assets = detectPaperAssets(parsePdfTsv(tsv));

		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({ id: "figure-3-p4", type: "figure", identifier: "3", page: 4 });
		expect(assets[0].caption).toContain("Figure 3. Pipeline");
		expect(assets[0].candidateRegion.x).toBeGreaterThanOrEqual(0);
		expect(assets[0].candidateRegion.y).toBeGreaterThanOrEqual(0);
		expect(assets[0].candidateRegion.x + assets[0].candidateRegion.width).toBeLessThanOrEqual(612);
		expect(assets[0].candidateRegion.y + assets[0].candidateRegion.height).toBeLessThanOrEqual(792);
	});

	it("detects a standalone TABLE I caption without admitting a prose reference", () => {
		const tableTsv = [
			"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
			"1\t2\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
			"3\t2\t0\t0\t0\t0\t60\t100\t80\t8\t-1\t###FLOW###",
			"4\t2\t0\t0\t0\t0\t60\t100\t80\t8\t-1\t###LINE###",
			"5\t2\t0\t0\t0\t0\t60\t100\t32\t8\t100\tTABLE",
			"5\t2\t0\t0\t0\t1\t96\t100\t8\t8\t100\tI",
		].join("\n");

		expect(detectPaperAssets(parsePdfTsv(tableTsv))).toMatchObject([
			{ id: "table-i-p2", type: "table", identifier: "I", page: 2 },
		]);
	});

	it("splits side-by-side captions merged into one pdftotext line", () => {
		const mergedTsv = [
			"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
			"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
			"3\t1\t0\t0\t0\t0\t60\t100\t490\t10\t-1\t###FLOW###",
			"4\t1\t0\t0\t0\t0\t60\t100\t490\t10\t-1\t###LINE###",
			"5\t1\t0\t0\t0\t0\t60\t100\t30\t10\t100\tTable",
			"5\t1\t0\t0\t0\t1\t94\t100\t12\t10\t100\t4:",
			"5\t1\t0\t0\t0\t2\t110\t100\t80\t10\t100\tAssessments",
			"5\t1\t0\t0\t0\t3\t315\t100\t30\t10\t100\tTable",
			"5\t1\t0\t0\t0\t4\t349\t100\t12\t10\t100\t5:",
			"5\t1\t0\t0\t0\t5\t365\t100\t80\t10\t100\tDiversity",
		].join("\n");

		const assets = detectPaperAssets(parsePdfTsv(mergedTsv));
		expect(assets.map((asset) => asset.id)).toEqual(["table-4-p1", "table-5-p1"]);
		expect(assets[0].candidateRegion.x + assets[0].candidateRegion.width).toBeLessThanOrEqual(336);
		expect(assets[1].candidateRegion.x).toBeGreaterThanOrEqual(300);
	});

	it("rejects lowercase PDF object labels and keeps the strongest duplicate caption", () => {
		const duplicateTsv = [
			"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
			"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
			"3\t1\t0\t0\t0\t0\t60\t300\t400\t10\t-1\t###FLOW###",
			"4\t1\t0\t0\t0\t0\t60\t300\t400\t10\t-1\t###LINE###",
			"5\t1\t0\t0\t0\t0\t60\t300\t30\t10\t100\tFigure",
			"5\t1\t0\t0\t0\t1\t94\t300\t12\t10\t100\t9:",
			"5\t1\t0\t0\t0\t2\t110\t300\t160\t10\t100\tComparison of classifiers",
			"3\t1\t1\t0\t0\t0\t60\t400\t80\t8\t-1\t###FLOW###",
			"4\t1\t1\t0\t0\t0\t60\t400\t80\t8\t-1\t###LINE###",
			"5\t1\t1\t0\t0\t0\t60\t400\t30\t8\t100\tFigure",
			"5\t1\t1\t0\t0\t1\t94\t400\t12\t8\t100\t9.",
			"3\t1\t2\t0\t0\t0\t280\t170\t20\t3\t-1\t###FLOW###",
			"4\t1\t2\t0\t0\t0\t280\t170\t20\t3\t-1\t###LINE###",
			"5\t1\t2\t0\t0\t0\t280\t170\t20\t3\t100\ttable.81",
		].join("\n");

		const assets = detectPaperAssets(parsePdfTsv(duplicateTsv));
		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({ id: "figure-9-p1", caption: "Figure 9: Comparison of classifiers" });
	});

		it("links captionless continuation pages by repeated table headers", () => {
		const rows = [
			"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
			"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
			"3\t1\t0\t0\t0\t0\t80\t100\t450\t10\t-1\t###FLOW###",
			"4\t1\t0\t0\t0\t0\t80\t100\t450\t10\t-1\t###LINE###",
			"5\t1\t0\t0\t0\t0\t80\t100\t30\t10\t100\tTable",
			"5\t1\t0\t0\t0\t1\t115\t100\t8\t10\t100\t5:",
			"5\t1\t0\t0\t0\t2\t130\t100\t80\t10\t100\tChallenges",
		];
		for (const page of [1, 2, 3]) {
			if (page > 1) rows.push(`1\t${page}\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###`);
			for (const [index, text] of ["Phase", "Challenges", "Key Points", "#"].entries()) {
				rows.push(
					`3\t${page}\t${index + 1}\t0\t0\t0\t${80 + index * 100}\t${page === 1 ? 130 : 70}\t90\t10\t-1\t###FLOW###`,
				);
				rows.push(
					`4\t${page}\t${index + 1}\t0\t0\t0\t${80 + index * 100}\t${page === 1 ? 130 : 70}\t90\t10\t-1\t###LINE###`,
				);
				rows.push(
					`5\t${page}\t${index + 1}\t0\t0\t0\t${80 + index * 100}\t${page === 1 ? 130 : 70}\t90\t10\t100\t${text}`,
				);
			}
			for (let index = 0; index < 8; index++) {
				const y = (page === 1 ? 160 : 100) + index * 30;
				rows.push(`3\t${page}\t20\t${index}\t0\t0\t80\t${y}\t420\t10\t-1\t###FLOW###`);
				rows.push(`4\t${page}\t20\t${index}\t0\t0\t80\t${y}\t420\t10\t-1\t###LINE###`);
				rows.push(`5\t${page}\t20\t${index}\t0\t0\t80\t${y}\t80\t10\t100\trow${index}`);
			}
		}
		const [table] = detectPaperAssets(parsePdfTsv(rows.join("\n")));

		expect(table).toMatchObject({ id: "table-5-p1", type: "table", identifier: "5" });
			expect(table.continuationRegions?.map((region) => region.page)).toEqual([2, 3]);
		});

		it("links a continued table without a repeated header when row geometry remains stable", () => {
			const rows = [
				"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
				"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
				"3\t1\t0\t0\t0\t0\t70\t70\t460\t10\t-1\t###FLOW###",
				"4\t1\t0\t0\t0\t0\t70\t70\t460\t10\t-1\t###LINE###",
				"5\t1\t0\t0\t0\t0\t70\t70\t30\t10\t100\tTable",
				"5\t1\t0\t0\t0\t1\t105\t70\t10\t10\t100\t7:",
				"5\t1\t0\t0\t0\t2\t125\t70\t90\t10\t100\tMeasurements",
			];
			const addDataPage = (page: number, firstY: number, count: number, valueOffset = 0) => {
				if (page > 1) rows.push(`1\t${page}\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###`);
				for (let row = 0; row < count; row++) {
					const y = firstY + row * 32;
					for (const [column, value] of [
						`method-${row + valueOffset}`,
						`${70 + row + valueOffset}.1`,
						`${80 + row + valueOffset}.2`,
					].entries()) {
						const x = [80, 260, 420][column];
						rows.push(`3\t${page}\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t90\t10\t-1\t###FLOW###`);
						rows.push(`4\t${page}\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t90\t10\t-1\t###LINE###`);
						rows.push(`5\t${page}\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t70\t10\t100\t${value}`);
					}
				}
			};
			addDataPage(1, 130, 19);
			addDataPage(2, 55, 10, 20);

			const [table] = detectPaperAssets(parsePdfTsv(rows.join("\n")));
			expect(table).toMatchObject({ id: "table-7-p1", type: "table", identifier: "7" });
			expect(table.continuationRegions?.map((region) => region.page)).toEqual([2]);
			expect(table.continuationRegions?.[0].confidence).toBe("medium");
		});

		it("does not treat ordinary next-page prose as a headerless table continuation", () => {
			const rows = [
				"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
				"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
				"3\t1\t0\t0\t0\t0\t70\t70\t460\t10\t-1\t###FLOW###",
				"4\t1\t0\t0\t0\t0\t70\t70\t460\t10\t-1\t###LINE###",
				"5\t1\t0\t0\t0\t0\t70\t70\t30\t10\t100\tTable",
				"5\t1\t0\t0\t0\t1\t105\t70\t10\t10\t100\t8:",
			];
			for (let row = 0; row < 19; row++) {
				const y = 130 + row * 32;
				for (const [column, value] of [`item-${row}`, `${row}`, `${row + 1}`].entries()) {
					const x = [80, 260, 420][column];
					rows.push(`3\t1\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t90\t10\t-1\t###FLOW###`);
					rows.push(`4\t1\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t90\t10\t-1\t###LINE###`);
					rows.push(`5\t1\t${row + 1}\t${column}\t0\t0\t${x}\t${y}\t70\t10\t100\t${value}`);
				}
			}
			rows.push("1\t2\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###");
			for (let line = 0; line < 12; line++) {
				const y = 60 + line * 18;
				rows.push(`3\t2\t${line}\t0\t0\t0\t60\t${y}\t492\t10\t-1\t###FLOW###`);
				rows.push(`4\t2\t${line}\t0\t0\t0\t60\t${y}\t492\t10\t-1\t###LINE###`);
				for (const [wordIndex, value] of "This paragraph continues the ordinary discussion on the next page".split(" ").entries()) {
					rows.push(`5\t2\t${line}\t0\t0\t${wordIndex}\t${60 + wordIndex * 48}\t${y}\t42\t10\t100\t${value}`);
				}
			}

			const [table] = detectPaperAssets(parsePdfTsv(rows.join("\n")));
			expect(table.continuationRegions).toBeUndefined();
		});

		it("detects Chinese figure captions and body mentions", () => {
			const chineseTsv = [
				"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
				"1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
				"3\t1\t0\t0\t0\t0\t60\t100\t300\t10\t-1\t###FLOW###",
				"4\t1\t0\t0\t0\t0\t60\t100\t300\t10\t-1\t###LINE###",
				"5\t1\t0\t0\t0\t0\t60\t100\t40\t10\t100\t如图",
				"5\t1\t0\t0\t0\t1\t105\t100\t10\t10\t100\t2",
				"5\t1\t0\t0\t0\t2\t120\t100\t120\t10\t100\t所示，系统包含三层。",
				"1\t2\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
				"3\t2\t0\t0\t0\t0\t70\t300\t360\t10\t-1\t###FLOW###",
				"4\t2\t0\t0\t0\t0\t70\t300\t360\t10\t-1\t###LINE###",
				"5\t2\t0\t0\t0\t0\t70\t300\t20\t10\t100\t图",
				"5\t2\t0\t0\t0\t1\t95\t300\t10\t10\t100\t2：",
				"5\t2\t0\t0\t0\t2\t110\t300\t100\t10\t100\t系统结构",
			].join("\n");
			const [figure] = detectPaperAssets(parsePdfTsv(chineseTsv));
			expect(figure).toMatchObject({ type: "figure", identifier: "2", page: 2 });
			expect(figure.mentions.map((mention) => mention.page)).toEqual([1]);
		});

	it("rejects a caption-shaped reference inside a normal body block", () => {
		const bodyReferenceTsv = [
			"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
			"1\t8\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###",
			"3\t8\t0\t0\t0\t0\t315\t100\t243\t45\t-1\t###FLOW###",
			"4\t8\t0\t0\t0\t0\t315\t100\t243\t9\t-1\t###LINE###",
			"5\t8\t0\t0\t0\t0\t315\t100\t30\t9\t100\tTABLE",
			"5\t8\t0\t0\t0\t1\t349\t100\t8\t9\t100\t2.",
			"5\t8\t0\t0\t0\t2\t361\t100\t20\t9\t100\tEach",
			"4\t8\t0\t0\t1\t0\t315\t112\t243\t9\t-1\t###LINE###",
			"5\t8\t0\t0\t1\t0\t315\t112\t30\t9\t100\tfuzzing",
			"4\t8\t0\t0\t2\t0\t315\t124\t243\t9\t-1\t###LINE###",
			"5\t8\t0\t0\t2\t0\t315\t124\t30\t9\t100\tsession",
			"4\t8\t0\t0\t3\t0\t315\t136\t243\t9\t-1\t###LINE###",
			"5\t8\t0\t0\t3\t0\t315\t136\t30\t9\t100\tcontinues",
		].join("\n");

		expect(detectPaperAssets(parsePdfTsv(bodyReferenceTsv))).toEqual([]);
	});

	it("parses the 16-column pdfimages inventory", () => {
		const output = [
			"page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio",
			"--------------------------------------------------------------------------------",
			"4 0 image 183 205 icc 3 8 image yes 179 0 405 402 24.5K 22%",
			"4 1 smask 183 205 gray 1 8 image yes 179 0 405 402 2280B 6.1%",
			"5 2 image 10 10 rgb 3 8 image no [inline] 72 72 300B 100%",
		].join("\n");

		expect(parsePdfImagesList(output)).toEqual([
			{
				page: 4,
				index: 0,
				type: "image",
				width: 183,
				height: 205,
				encoding: "image",
				objectId: "179 0",
				xPpi: 405,
				yPpi: 402,
				size: "24.5K",
			},
			{
				page: 4,
				index: 1,
				type: "smask",
				width: 183,
				height: 205,
				encoding: "image",
				objectId: "179 0",
				xPpi: 405,
				yPpi: 402,
				size: "2280B",
			},
			{
				page: 5,
				index: 2,
				type: "image",
				width: 10,
				height: 10,
				encoding: "image",
				objectId: "[inline]",
				xPpi: 72,
				yPpi: 72,
				size: "300B",
			},
		]);
	});

	it("uses explicit table boundaries to reconstruct stable cells", () => {
		const words = [word("Method", 10, 10), word("Score", 200, 10), word("Base", 10, 30), word("71.2", 200, 30)];
		const grid = buildTableGrid(words, { x: 0, y: 0, width: 300, height: 60 }, [150]);

		expect(grid.usedExplicitBoundaries).toBe(true);
		expect(grid.columnAnchors).toEqual([0, 150]);
		expect(grid.rows).toEqual([
			["Method", "Score"],
			["Base", "71.2"],
		]);
		expect(() => buildTableGrid(words, { x: 0, y: 0, width: 300, height: 60 }, [150, 150])).toThrow(/unique/);
	});

	it("rejects partial Poppler output when pi.exec reports a killed process", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-paper-killed-test-"));
		const pdfPath = join(temporaryDirectory, "paper.pdf");
		await writeFile(pdfPath, "%PDF-1.4\n");
		let layoutTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				if (tool.name === "inspect_pdf_layout") layoutTool = tool;
			},
			exec: async (command: string) =>
				command === "pdfinfo"
					? { stdout: "Pages: 1\n", stderr: "", code: 0, killed: false }
					: { stdout: "partial", stderr: "", code: 0, killed: true },
		} as unknown as ExtensionAPI;
		try {
			registerPdfAssetTools(pi);
			expect(layoutTool).toBeDefined();
			if (!layoutTool) return;
			await expect(
				layoutTool.execute("layout", { path: pdfPath, pages: "1" }, undefined, undefined, {
					cwd: temporaryDirectory,
				} as never),
			).rejects.toThrow(/terminated or timed out/);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("audits split asset indexes without double-counting repeated PDF objects", async () => {
		let progressTool: ToolDefinition | undefined;
		registerProgressTool({
			registerTool(tool: ToolDefinition) {
				progressTool = tool;
			},
		} as unknown as ExtensionAPI);
		expect(progressTool).toBeDefined();
		if (!progressTool) return;
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: false,
					toolName: "read_pdf",
					details: { path: "/paper.pdf", pageCount: 2, selectedPages: [1, 2], truncated: false },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: false,
					toolName: "list_paper_assets",
					details: {
						path: "/paper.pdf",
						pageCount: 2,
						selectedPages: [1, 2],
						truncated: true,
						assets: [],
						embeddedImages: [],
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: false,
					toolName: "list_paper_assets",
					details: {
						path: "/paper.pdf",
						pageCount: 2,
						selectedPages: [1],
						truncated: false,
						assets: [{ id: "figure-1-p1", page: 1 }],
						embeddedImages: [{ page: 1, index: 0, objectId: "10 0", type: "image" }],
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: false,
					toolName: "list_paper_assets",
					details: {
						path: "/paper.pdf",
						pageCount: 2,
						selectedPages: [2],
						truncated: false,
						assets: [{ id: "table-1-p2", page: 2 }],
						embeddedImages: [{ page: 1, index: 0, objectId: "10 0", type: "image" }],
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					isError: false,
					toolName: "extract_pdf_region",
					details: { path: "/paper.pdf", pageCount: 2, page: 1, assetId: "figure-1-p1" },
				},
			},
		];
		const result = await progressTool.execute("progress", {}, undefined, undefined, {
			sessionManager: { getBranch: () => branch },
		} as never);
		const details = result.details as {
			pdfs: Array<{
				assetIndexedPages: number[];
				semanticAssetCount: number;
				embeddedImageCount: number;
			}>;
		};
		expect(details.pdfs[0]).toMatchObject({
			assetIndexedPages: [1, 2],
			semanticAssetCount: 2,
			embeddedImageCount: 1,
		});
		const text = result.content.find((item) => item.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain(
			"[x] Every physical PDF page included in an untruncated asset index",
		);
		expect(text?.type === "text" ? text.text : "").toContain(
			"[x] At least one indexed asset per PDF checked at object level with asset_id",
		);
	});
});
