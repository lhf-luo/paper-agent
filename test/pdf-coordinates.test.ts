import { describe, expect, it } from "vitest";
import { createPdfCoordinateMapper } from "../web/src/pdf-coordinates.ts";

function expectRectangleClose(
	actual: { x: number; y: number; width: number; height: number },
	expected: { x: number; y: number; width: number; height: number },
) {
	expect(actual.x).toBeCloseTo(expected.x);
	expect(actual.y).toBeCloseTo(expected.y);
	expect(actual.width).toBeCloseTo(expected.width);
	expect(actual.height).toBeCloseTo(expected.height);
}

describe("PDF coordinate mapping", () => {
	it("scales normal pages and remains reversible", () => {
		const mapper = createPdfCoordinateMapper({
			analysisWidth: 600,
			analysisHeight: 800,
			displayWidth: 900,
			displayHeight: 1200,
		});
		const analysis = { x: 100, y: 200, width: 150, height: 120 };
		const display = mapper.toDisplay(analysis);
		expect(mapper.mode).toBe("scaled");
		expectRectangleClose(display, { x: 150, y: 300, width: 225, height: 180 });
		expectRectangleClose(mapper.toAnalysis(display), analysis);
	});

	it("rotates an unrotated analysis page clockwise for a 90-degree PDF viewport", () => {
		const mapper = createPdfCoordinateMapper({
			analysisWidth: 600,
			analysisHeight: 800,
			displayWidth: 1200,
			displayHeight: 900,
			rotation: 90,
		});
		const analysis = { x: 100, y: 200, width: 150, height: 120 };
		const display = mapper.toDisplay(analysis);
		expect(mapper.mode).toBe("rotated");
		expectRectangleClose(display, { x: 720, y: 150, width: 180, height: 225 });
		expectRectangleClose(mapper.toAnalysis(display), analysis);
	});

	it("rotates an unrotated analysis page counter-clockwise for a 270-degree PDF viewport", () => {
		const mapper = createPdfCoordinateMapper({
			analysisWidth: 600,
			analysisHeight: 800,
			displayWidth: 1200,
			displayHeight: 900,
			rotation: 270,
		});
		const analysis = { x: 100, y: 200, width: 150, height: 120 };
		const display = mapper.toDisplay(analysis);
		expect(mapper.mode).toBe("rotated");
		expectRectangleClose(display, { x: 300, y: 525, width: 180, height: 225 });
		expectRectangleClose(mapper.toAnalysis(display), analysis);
	});

	it("does not rotate twice when pdftotext already reports the rotated page dimensions", () => {
		const mapper = createPdfCoordinateMapper({
			analysisWidth: 800,
			analysisHeight: 600,
			displayWidth: 1200,
			displayHeight: 900,
			rotation: 90,
		});
		const analysis = { x: 100, y: 200, width: 150, height: 120 };
		expect(mapper.mode).toBe("scaled");
		expectRectangleClose(mapper.toDisplay(analysis), { x: 150, y: 300, width: 225, height: 180 });
	});
});
