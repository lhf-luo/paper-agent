import { describe, expect, it } from "vitest";
import { attachAssetMentions } from "../src/pdf/application/pdf-asset-mentions.ts";
import type { PaperAsset } from "../src/pdf/domain/pdf-types.ts";
import { detectPaperAssets, parsePdfTsv } from "../src/pdf/presentation/pdf-asset-tools.ts";

const header = "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

function pageRow(page: number): string {
	return ["1", page, 0, 0, 0, 0, 0, 0, 612, 792, -1, "###PAGE###"].join("\t");
}

function blockRows(
	page: number,
	paragraph: number,
	block: number,
	top: number,
	lines: string[],
	x = 60,
	width = 492,
): string[] {
	const rows = [["3", page, paragraph, block, 0, 0, x, top, width, lines.length * 12, -1, "###FLOW###"].join("\t")];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const y = top + lineIndex * 12;
		rows.push(["4", page, paragraph, block, lineIndex, 0, x, y, width, 9, -1, "###LINE###"].join("\t"));
		let wordX = x;
		for (const [wordIndex, text] of lines[lineIndex].split(" ").entries()) {
			const wordWidth = Math.max(8, text.length * 5);
			rows.push(["5", page, paragraph, block, lineIndex, wordIndex, wordX, y, wordWidth, 9, 100, text].join("\t"));
			wordX += wordWidth + 5;
		}
	}
	return rows;
}

function referenceAsset(type: PaperAsset["type"], identifier: string): PaperAsset {
	return {
		id: type + "-" + identifier,
		type,
		identifier,
		page: 2,
		caption: type + " " + identifier,
		captionBox: { x: 10, y: 70, width: 80, height: 10 },
		candidateRegion: { x: 10, y: 10, width: 80, height: 70 },
		regionConfidence: "medium",
		mentions: [],
	};
}

describe("layout-aware PDF assets", () => {
	it.each([
		["Figure 2 shows results for 5 tasks in 2024.", ["2", "5", "2024"], ["2"]],
		["Figure 2 improves accuracy by 95% over Figure 5.", ["2", "5", "95"], ["2", "5"]],
		["Figures 2, 3 and 4 compare 5 tasks.", ["2", "3", "4", "5"], ["2", "3", "4"]],
		["Figures 2–4 compare 5 tasks.", ["2", "3", "4", "5"], ["2", "3", "4"]],
		["Figures 2-4 compare 5 tasks.", ["2", "3", "4", "5"], ["2", "3", "4"]],
		["Figure 2-4 reports 5 tasks.", ["2-4", "2", "3", "4", "5"], ["2-4"]],
		["Figure 2.1 shows 5 results.", ["2.1", "5"], ["2.1"]],
		["Figures S1 and S2 report 5 measurements.", ["S1", "S2", "5"], ["S1", "S2"]],
		["Figure 2(a) has 3 components.", ["2", "3"], ["2"]],
		["Figure I illustrates 5 steps.", ["I", "5"], ["I"]],
		["Figures II–IV illustrate 5 steps.", ["II", "III", "IV", "5"], ["II", "III", "IV"]],
		["Figure 2, 5 % above the baseline.", ["2", "5"], ["2"]],
		["Figures 2(a) and 2(b) compare 5 tasks.", ["2", "5"], ["2"]],
		["Figure captions describe 5 tasks.", ["5"], []],
	])("associates only explicit figure references in %s", (text, identifiers, expected) => {
		const layouts = parsePdfTsv([header, pageRow(1), ...blockRows(1, 0, 0, 95, [text])].join("\n"));
		const assets = identifiers.map((identifier) => referenceAsset("figure", identifier));
		attachAssetMentions(layouts, assets);
		expect(assets.filter((asset) => asset.mentions.length).map((asset) => asset.identifier)).toEqual(expected);
		for (const asset of assets) {
			for (const mention of asset.mentions)
				expect(mention.matchedText).not.toMatch(/tasks|results|measurements|components/);
		}
	});

	it("keeps adjacent figure, table, algorithm, and listing references separate", () => {
		const text = "Figure 2 uses Table II and Algorithm 1 for 3 passes; Listing 4 processes 5 inputs.";
		const layouts = parsePdfTsv([header, pageRow(1), ...blockRows(1, 0, 0, 95, [text])].join("\n"));
		const assets = [
			referenceAsset("figure", "2"),
			referenceAsset("figure", "5"),
			referenceAsset("table", "II"),
			referenceAsset("table", "3"),
			referenceAsset("algorithm", "1"),
			referenceAsset("algorithm", "3"),
			referenceAsset("listing", "4"),
			referenceAsset("listing", "5"),
		];
		attachAssetMentions(layouts, assets);
		expect(assets.filter((asset) => asset.mentions.length).map((asset) => asset.id)).toEqual([
			"figure-2",
			"table-II",
			"algorithm-1",
			"listing-4",
		]);
	});

	it("uses nearby body layout as a crop boundary and links section-aware prose mentions", () => {
		const rows = [
			header,
			pageRow(1),
			...blockRows(1, 0, 0, 55, ["3 Results"], 60, 180),
			...blockRows(1, 1, 0, 95, [
				"As shown in Figure 2, performance improves",
				"The comparison uses identical training budgets",
				"This paragraph provides surrounding evidence context",
			]),
			pageRow(2),
			...blockRows(2, 0, 0, 85, [
				"The preceding paragraph has enough words for layout boundary detection",
				"It describes evaluation details before the visual object begins",
				"The text remains dense and aligned within the same column",
				"The final prose line ends well above the complete figure",
			]),
			...blockRows(2, 1, 0, 220, ["Encoder Decoder", "Input Output"], 110, 360),
			...blockRows(2, 2, 0, 300, ["Figure 2. Overview of the system."], 70, 460),
		];
		const assets = detectPaperAssets(parsePdfTsv(rows.join("\n")));

		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({
			id: "figure-2-p2",
			regionConfidence: "high",
		});
		expect(assets[0].candidateRegion.y).toBeGreaterThan(130);
		expect(assets[0].candidateRegion.y).toBeLessThan(220);
		expect(assets[0].mentions).toMatchObject([
			{
				page: 1,
				section: "3 Results",
				confidence: "high",
			},
		]);
		expect(assets[0].mentions[0].context).toContain("identical training budgets");
	});
});
