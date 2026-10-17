export const PDFJS_VIEWER_PATH = "/pdfjs/6.2.108/web/viewer.html";

export function mozillaPdfViewerUrl(url: string, origin: string): string {
	const pdf = new URL(url, origin);
	const requestedPage = Number(new URLSearchParams(pdf.hash.slice(1)).get("page"));
	const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	pdf.hash = "";
	return `${PDFJS_VIEWER_PATH}?file=${encodeURIComponent(pdf.href)}#page=${page}&zoom=page-width`;
}
