import { describe, expect, it } from "vitest";
import { mozillaPdfViewerUrl, PDFJS_VIEWER_PATH, usesMozillaPdfViewer } from "../web/src/pdfjs-viewer-url.ts";

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

	it("selects the Mozilla viewer only for structured dual output", () => {
		expect(usesMozillaPdfViewer("dual")).toBe(true);
		expect(usesMozillaPdfViewer("mono")).toBe(false);
		expect(usesMozillaPdfViewer(undefined)).toBe(false);
	});

});
