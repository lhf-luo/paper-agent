export const PDFJS_VIEWER_PATH = "/pdfjs/6.2.108/web/viewer.html";

export function mozillaPdfViewerUrl(url: string, origin: string): string {
	const absolutePdfUrl = new URL(url, origin).href;
	return `${PDFJS_VIEWER_PATH}?file=${encodeURIComponent(absolutePdfUrl)}#page=1&zoom=page-width`;
}

export type PdfReaderPreference = "pdfjs" | "native";

export function usesMozillaPdfViewer(preference: PdfReaderPreference | undefined): boolean {
	return preference !== "native";
}

export function enablesBilingualPdfSelection(
	preference: PdfReaderPreference | undefined,
	outputMode: "mono" | "dual" | undefined,
): boolean {
	return usesMozillaPdfViewer(preference) && outputMode === "dual";
}
