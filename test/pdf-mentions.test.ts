import { describe, expect, it } from "vitest";
import { detectPaperAssets, parsePdfTsv } from "../src/pdf-asset-tools.ts";

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

describe("layout-aware PDF assets", () => {
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
