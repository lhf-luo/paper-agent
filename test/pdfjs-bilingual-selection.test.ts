import { describe, expect, it } from "vitest";
import { mapOppositeColumnRects, rectColumn, type VisualRect } from "../web/src/pdfjs-bilingual-selection.ts";

function rect(left: number, top: number, width: number, height: number): VisualRect {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

describe("PDF.js bilingual selection mapping", () => {
	it("maps a left-column selection to overlapping right-column text", () => {
		const selected = [rect(80, 300, 330, 18), rect(80, 322, 300, 18)];
		const candidates = [
			rect(590, 302, 310, 18),
			rect(590, 324, 280, 18),
			rect(590, 390, 310, 18),
			rect(80, 302, 300, 18),
		];
		const matches = mapOppositeColumnRects({ selected, candidates, pageWidth: 1000, pageHeight: 1400 });
		expect(matches).toHaveLength(2);
		expect(matches.every((match) => rectColumn(match, 1000) === "right")).toBe(true);
		expect(matches.map((match) => match.top)).toEqual([302, 324]);
	});

	it("maps a right-column selection back to the left column", () => {
		const matches = mapOppositeColumnRects({
			selected: [rect(590, 500, 290, 20)],
			candidates: [rect(70, 498, 320, 20), rect(70, 650, 320, 20)],
			pageWidth: 1000,
			pageHeight: 1400,
		});
		expect(matches).toEqual([rect(70, 498, 320, 20)]);
	});

	it("does not guess when a selection crosses both columns", () => {
		const matches = mapOppositeColumnRects({
			selected: [rect(80, 300, 320, 18), rect(590, 302, 300, 18)],
			candidates: [rect(80, 300, 320, 18), rect(590, 302, 300, 18)],
			pageWidth: 1000,
			pageHeight: 1400,
		});
		expect(matches).toEqual([]);
	});

	it("uses a nearby opposite line only within a bounded vertical distance", () => {
		const near = mapOppositeColumnRects({
			selected: [rect(80, 300, 320, 18)],
			candidates: [rect(590, 332, 300, 18)],
			pageWidth: 1000,
			pageHeight: 1400,
		});
		const far = mapOppositeColumnRects({
			selected: [rect(80, 300, 320, 18)],
			candidates: [rect(590, 700, 300, 18)],
			pageWidth: 1000,
			pageHeight: 1400,
		});
		expect(near).toHaveLength(1);
		expect(far).toEqual([]);
	});
});
