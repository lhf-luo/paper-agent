import { describe, expect, it } from "vitest";
import {
	enablesBilingualPdfSelection,
	mozillaPdfViewerUrl,
	PDFJS_VIEWER_PATH,
	usesMozillaPdfViewer,
} from "../web/src/pdfjs-viewer-url.ts";

describe("Mozilla PDF.js bilingual reader", () => {
	it("builds a same-origin viewer URL without losing PDF query parameters", () => {
		const url = mozillaPdfViewerUrl(
			"/api/papers/paper%201/pdf/abc?namespace=research%20notes",
			"http://127.0.0.1:4317/app",
		);
		expect(url).toBe(
			`${PDFJS_VIEWER_PATH}?file=${encodeURIComponent("http://127.0.0.1:4317/api/papers/paper%201/pdf/abc?namespace=research%20notes")}#page=1&zoom=page-width`,
		);
	});

	it("uses the configured viewer for every PDF version", () => {
		expect(usesMozillaPdfViewer("pdfjs")).toBe(true);
		expect(usesMozillaPdfViewer(undefined)).toBe(true);
		expect(usesMozillaPdfViewer("native")).toBe(false);
	});

	it("enables bilingual selection only for dual output in PDF.js", () => {
		expect(enablesBilingualPdfSelection("pdfjs", "dual")).toBe(true);
		expect(enablesBilingualPdfSelection("pdfjs", "mono")).toBe(false);
		expect(enablesBilingualPdfSelection("pdfjs", undefined)).toBe(false);
		expect(enablesBilingualPdfSelection("native", "dual")).toBe(false);
	});
});
