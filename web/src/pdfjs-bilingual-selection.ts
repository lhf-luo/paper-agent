export interface VisualRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export type PdfColumn = "left" | "right";

const HIGHLIGHT_CLASS = "paper-agent-bilingual-highlight";
const STYLE_ID = "paper-agent-bilingual-highlight-style";
const HIGHLIGHT_STYLESHEET = "/pdfjs/paper-agent-bilingual.css";

function rectCenterX(rect: VisualRect): number {
	return rect.left + rect.width / 2;
}

function rectCenterY(rect: VisualRect): number {
	return rect.top + rect.height / 2;
}

export function rectColumn(rect: VisualRect, pageWidth: number): PdfColumn | undefined {
	if (pageWidth <= 0 || rect.width <= 0 || rect.height <= 0) return undefined;
	const midpoint = pageWidth / 2;
	const gutter = Math.max(4, pageWidth * 0.0125);
	if (rect.right <= midpoint + gutter && rectCenterX(rect) < midpoint) return "left";
	if (rect.left >= midpoint - gutter && rectCenterX(rect) > midpoint) return "right";
	return undefined;
}

function mergeLineRects(rects: VisualRect[]): VisualRect[] {
	const sorted = [...rects].sort((left, right) => left.top - right.top || left.left - right.left);
	const lines: VisualRect[] = [];
	for (const rect of sorted) {
		const current = lines.at(-1);
		const sameLine =
			current &&
			Math.abs(rectCenterY(current) - rectCenterY(rect)) <= Math.max(2, Math.min(current.height, rect.height) * 0.6);
		if (!sameLine || !current) {
			lines.push({ ...rect });
			continue;
		}
		const left = Math.min(current.left, rect.left);
		const top = Math.min(current.top, rect.top);
		const right = Math.max(current.right, rect.right);
		const bottom = Math.max(current.bottom, rect.bottom);
		Object.assign(current, { left, top, right, bottom, width: right - left, height: bottom - top });
	}
	return lines;
}

export function mapOppositeColumnRects(input: {
	selected: VisualRect[];
	candidates: VisualRect[];
	pageWidth: number;
	pageHeight: number;
}): VisualRect[] {
	const selected = input.selected.filter((rect) => rect.width > 0 && rect.height > 0);
	if (!selected.length) return [];
	const selectedColumns = new Set(selected.map((rect) => rectColumn(rect, input.pageWidth)).filter(Boolean));
	if (selectedColumns.size !== 1) return [];
	const sourceColumn = [...selectedColumns][0];
	if (!sourceColumn) return [];
	const targetColumn: PdfColumn = sourceColumn === "left" ? "right" : "left";
	const candidates = input.candidates.filter((rect) => rectColumn(rect, input.pageWidth) === targetColumn);
	if (!candidates.length) return [];

	const sourceTop = Math.min(...selected.map((rect) => rect.top));
	const sourceBottom = Math.max(...selected.map((rect) => rect.bottom));
	const sourceHeight = Math.max(1, sourceBottom - sourceTop);
	const margin = Math.max(4, Math.min(18, sourceHeight * 0.2));
	let matches = candidates.filter((rect) => rect.bottom >= sourceTop - margin && rect.top <= sourceBottom + margin);

	if (!matches.length) {
		const sourceCenter = (sourceTop + sourceBottom) / 2;
		const distances = candidates.map((rect) => ({ rect, distance: Math.abs(rectCenterY(rect) - sourceCenter) }));
		const nearest = Math.min(...distances.map((entry) => entry.distance));
		const maximumDistance = Math.max(24, input.pageHeight * 0.06, sourceHeight * 1.5);
		if (nearest > maximumDistance) return [];
		matches = distances
			.filter((entry) => entry.distance <= nearest + Math.max(3, entry.rect.height * 0.65))
			.map((entry) => entry.rect);
	}

	return mergeLineRects(matches);
}

function visualRect(rect: DOMRect, pageRect: DOMRect): VisualRect {
	return {
		left: rect.left - pageRect.left,
		top: rect.top - pageRect.top,
		right: rect.right - pageRect.left,
		bottom: rect.bottom - pageRect.top,
		width: rect.width,
		height: rect.height,
	};
}

function selectedSpans(document: Document, selection: Selection): HTMLElement[] {
	const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
	return Array.from(document.querySelectorAll<HTMLElement>(".textLayer span")).filter((span) => {
		if (!span.textContent?.trim()) return false;
		return ranges.some((range) => {
			try {
				return range.intersectsNode(span);
			} catch {
				return false;
			}
		});
	});
}

function ensureHighlightStyle(document: Document): void {
	if (document.getElementById(STYLE_ID)) return;
	const link = document.createElement("link");
	link.id = STYLE_ID;
	link.rel = "stylesheet";
	link.href = HIGHLIGHT_STYLESHEET;
	document.head.append(link);
}

function clearHighlights(document: Document): void {
	for (const highlight of Array.from(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`))) highlight.remove();
}

function renderSelectionHighlights(document: Document): void {
	clearHighlights(document);
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return;
	const spans = selectedSpans(document, selection);
	if (!spans.length) return;
	const byPage = new Map<HTMLElement, HTMLElement[]>();
	for (const span of spans) {
		const page = span.closest<HTMLElement>(".page[data-page-number]");
		if (!page) continue;
		const entries = byPage.get(page) ?? [];
		entries.push(span);
		byPage.set(page, entries);
	}

	for (const [page, pageSelection] of byPage) {
		const pageRect = page.getBoundingClientRect();
		if (!pageRect.width || !pageRect.height) continue;
		const selected = pageSelection.flatMap((span) =>
			Array.from(span.getClientRects()).map((rect) => visualRect(rect, pageRect)),
		);
		const candidates = Array.from(page.querySelectorAll<HTMLElement>(".textLayer span"))
			.filter((span) => !pageSelection.includes(span) && Boolean(span.textContent?.trim()))
			.flatMap((span) => Array.from(span.getClientRects()).map((rect) => visualRect(rect, pageRect)));
		const matches = mapOppositeColumnRects({
			selected,
			candidates,
			pageWidth: pageRect.width,
			pageHeight: pageRect.height,
		});
		for (const match of matches) {
			const highlight = document.createElement("div");
			highlight.className = HIGHLIGHT_CLASS;
			highlight.setAttribute("aria-hidden", "true");
			Object.assign(highlight.style, {
				left: `${match.left}px`,
				top: `${match.top}px`,
				width: `${match.width}px`,
				height: `${match.height}px`,
			});
			page.append(highlight);
		}
	}
}

export function connectPdfJsBilingualSelectionBridge(frame: HTMLIFrameElement): () => void {
	const document = frame.contentDocument;
	const frameWindow = frame.contentWindow;
	if (!document || !frameWindow) return () => undefined;
	ensureHighlightStyle(document);
	let scheduled = 0;
	const schedule = () => {
		if (scheduled) frameWindow.cancelAnimationFrame(scheduled);
		scheduled = frameWindow.requestAnimationFrame(() => {
			scheduled = 0;
			renderSelectionHighlights(document);
		});
	};
	document.addEventListener("selectionchange", schedule);
	document.addEventListener("pointerup", schedule);
	document.addEventListener("keyup", schedule);
	const frameGlobals = frameWindow as Window & typeof globalThis;
	const observer = new frameGlobals.MutationObserver((changes: MutationRecord[]) => {
		if (
			changes.some((change) =>
				change.type === "attributes"
					? change.target instanceof frameGlobals.Element && change.target.matches(".page, .textLayer")
					: Array.from(change.addedNodes).some(
							(node) => node instanceof frameGlobals.Element && node.matches(".textLayer, .textLayer *"),
						),
			)
		) {
			schedule();
		}
	});
	observer.observe(document.getElementById("viewer") ?? document.body, {
		attributes: true,
		attributeFilter: ["class", "style"],
		childList: true,
		subtree: true,
	});
	return () => {
		if (scheduled) frameWindow.cancelAnimationFrame(scheduled);
		observer.disconnect();
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("pointerup", schedule);
		document.removeEventListener("keyup", schedule);
		clearHighlights(document);
	};
}
