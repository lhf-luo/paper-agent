type HighlightRect = [number, number, number, number];

interface PageHighlight {
	page: number;
	rects: HighlightRect[];
}

interface ReaderHighlight {
	id: string;
	text: string;
	pages: PageHighlight[];
}

const HIGHLIGHT_CLASS = "paper-agent-reader-highlight";
const MAX_HIGHLIGHTS = 500;
const MAX_RECTS = 200;

interface PdfViewerEventBus {
	on(name: string, listener: () => void): void;
	off(name: string, listener: () => void): void;
}

function validHighlight(value: unknown): value is ReaderHighlight {
	if (!value || typeof value !== "object") return false;
	const item = value as ReaderHighlight;
	return (
		typeof item.id === "string" &&
		item.id.length <= 100 &&
		typeof item.text === "string" &&
		item.text.length <= 10_000 &&
		Array.isArray(item.pages) &&
		item.pages.length > 0 &&
		item.pages.length <= 100 &&
		item.pages.every(
			(page) =>
				Number.isInteger(page.page) &&
				page.page > 0 &&
				Array.isArray(page.rects) &&
				page.rects.length > 0 &&
				page.rects.length <= MAX_RECTS &&
				page.rects.every(
					(rect) =>
						Array.isArray(rect) &&
						rect.length === 4 &&
						rect.every((number) => Number.isInteger(number) && number >= 0 && number <= 10_000),
				),
		)
	);
}

function selectionHighlight(document: Document): Omit<ReaderHighlight, "id"> | undefined {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
	const text = selection.toString().replace(/\s+/g, " ").trim();
	if (!text || text.length > 10_000) return undefined;
	const range = selection.getRangeAt(0);
	const pageRects = new Map<number, HighlightRect[]>();
	for (const page of document.querySelectorAll<HTMLElement>(".page[data-page-number]")) {
		const textLayer = page.querySelector<HTMLElement>(".textLayer");
		if (!textLayer) continue;
		try {
			if (!range.intersectsNode(page)) continue;
		} catch {
			continue;
		}
		const number = Number(page.dataset.pageNumber);
		const bounds = page.getBoundingClientRect();
		const leftEdge = bounds.left + page.clientLeft;
		const topEdge = bounds.top + page.clientTop;
		const rightEdge = leftEdge + page.clientWidth;
		const bottomEdge = topEdge + page.clientHeight;
		if (!Number.isInteger(number) || number < 1 || !page.clientWidth || !page.clientHeight) continue;
		const rects: HighlightRect[] = [];
		for (const span of textLayer.querySelectorAll<HTMLElement>("span")) {
			if (!range.intersectsNode(span)) continue;
			const part = document.createRange();
			part.selectNodeContents(span);
			if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
				part.setStart(range.startContainer, range.startOffset);
			}
			if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
				part.setEnd(range.endContainer, range.endOffset);
			}
			if (part.collapsed) continue;
			const spanBounds = span.getBoundingClientRect();
			for (const box of part.getClientRects()) {
				const left = Math.max(box.left, spanBounds.left, leftEdge);
				const top = Math.max(box.top, spanBounds.top, topEdge);
				const right = Math.min(box.right, spanBounds.right, rightEdge);
				const bottom = Math.min(box.bottom, spanBounds.bottom, bottomEdge);
				if (right - left <= 1 || bottom - top <= 1) continue;
				rects.push([
					Math.round(((left - leftEdge) / page.clientWidth) * 10_000),
					Math.round(((top - topEdge) / page.clientHeight) * 10_000),
					Math.round(((right - left) / page.clientWidth) * 10_000),
					Math.round(((bottom - top) / page.clientHeight) * 10_000),
				]);
				if (rects.length > MAX_RECTS) return undefined;
			}
		}
		if (rects.length) pageRects.set(number, rects);
	}
	if (!pageRects.size) return undefined;
	return {
		text,
		pages: [...pageRects].map(([page, rects]) => ({ page, rects })),
	};
}

function sameHighlight(a: Omit<ReaderHighlight, "id">, b: Omit<ReaderHighlight, "id">): boolean {
	return (
		a.text === b.text &&
		a.pages.length === b.pages.length &&
		a.pages.every(
			(page, index) =>
				page.page === b.pages[index]?.page &&
				page.rects.length === b.pages[index]?.rects.length &&
				page.rects.every((rect, rectIndex) =>
					rect.every(
						(value, coordinate) =>
							Math.abs(value - (b.pages[index]?.rects[rectIndex]?.[coordinate] ?? -100)) <= 30,
					),
				),
		)
	);
}

export function connectPdfJsReaderHighlights(frame: HTMLIFrameElement, pdfUrl: string) {
	const document = frame.contentDocument;
	const frameWindow = frame.contentWindow;
	if (!document || !frameWindow) return undefined;
	const storageKey = `paper-agent-pdf-highlights:v1:${pdfUrl}`;
	let highlights: ReaderHighlight[] = [];
	try {
		const saved = JSON.parse(frameWindow.localStorage.getItem(storageKey) ?? "[]") as unknown;
		if (Array.isArray(saved)) highlights = saved.filter(validHighlight).slice(0, MAX_HIGHLIGHTS);
	} catch {
		// A corrupt or unavailable browser store must not prevent PDF reading.
	}
	const viewer = document.getElementById("viewer");
	let renderFrame = 0;
	const render = () => {
		renderFrame = 0;
		for (const old of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) old.remove();
		for (const item of highlights) {
			for (const { page, rects } of item.pages) {
				const element = viewer?.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
				if (!element) continue;
				for (const [left, top, width, height] of rects) {
					const marker = document.createElement("span");
					marker.className = HIGHLIGHT_CLASS;
					marker.setAttribute("aria-hidden", "true");
					marker.style.left = `${left / 100}%`;
					marker.style.top = `${top / 100}%`;
					marker.style.width = `${width / 100}%`;
					marker.style.height = `${height / 100}%`;
					element.append(marker);
				}
			}
		}
	};
	const scheduleRender = () => {
		if (!renderFrame) renderFrame = frameWindow.requestAnimationFrame(render);
	};
	const eventBus = (frameWindow as Window & { PDFViewerApplication?: { eventBus?: PdfViewerEventBus } })
		.PDFViewerApplication?.eventBus;
	eventBus?.on("textlayerrendered", scheduleRender);
	eventBus?.on("pagesloaded", scheduleRender);
	scheduleRender();
	return {
		selectedAction(): "add" | "remove" | undefined {
			const selected = selectionHighlight(document);
			if (!selected) return undefined;
			return highlights.some((item) => sameHighlight(item, selected)) ? "remove" : "add";
		},
		toggleSelected(): "added" | "removed" | "unavailable" | "full" | "error" {
			const selected = selectionHighlight(document);
			if (!selected) return "unavailable";
			const index = highlights.findIndex((item) => sameHighlight(item, selected));
			if (index < 0 && highlights.length >= MAX_HIGHLIGHTS) return "full";
			const next = [...highlights];
			if (index >= 0) next.splice(index, 1);
			else next.push({ ...selected, id: frameWindow.crypto.randomUUID() });
			try {
				if (next.length) frameWindow.localStorage.setItem(storageKey, JSON.stringify(next));
				else frameWindow.localStorage.removeItem(storageKey);
			} catch {
				return "error";
			}
			highlights = next;
			scheduleRender();
			return index >= 0 ? "removed" : "added";
		},
		dispose() {
			eventBus?.off("textlayerrendered", scheduleRender);
			eventBus?.off("pagesloaded", scheduleRender);
			if (renderFrame) frameWindow.cancelAnimationFrame(renderFrame);
			for (const marker of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) marker.remove();
		},
	};
}
