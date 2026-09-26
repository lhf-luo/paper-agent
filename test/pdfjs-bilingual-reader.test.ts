import { describe, expect, it } from "vitest";
import { isSingleEnglishWord, selectionContextSentence } from "../web/src/pdfjs-reader-selection.ts";
import { mozillaPdfViewerUrl, PDFJS_VIEWER_PATH } from "../web/src/pdfjs-viewer-url.ts";

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

	it("recognizes a selected English word without treating a phrase as a word", () => {
		expect(isSingleEnglishWord("targets")).toBe(true);
		expect(isSingleEnglishWord("model-based")).toBe(true);
		expect(isSingleEnglishWord("target groups")).toBe(false);
	});

	it("extracts the sentence around a selected word", () => {
		expect(
			selectionContextSentence(
				["First sentence.", "LLMs can", "detect vulnerabilities.", "Another sentence."],
				1,
				0,
			),
		).toBe("LLMs can detect vulnerabilities.");
	});
});
