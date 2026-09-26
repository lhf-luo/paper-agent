export interface ReaderTextSelection {
	text: string;
	pages: number[];
	context: string;
}

export function isSingleEnglishWord(text: string): boolean {
	return /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(text.trim());
}

export function selectionContextSentence(chunks: string[], selectedIndex: number, selectedOffset: number): string {
	if (selectedIndex < 0 || selectedIndex >= chunks.length) return "";
	const before = chunks.slice(Math.max(0, selectedIndex - 20), selectedIndex).join(" ");
	const middle = chunks[selectedIndex] ?? "";
	const after = chunks.slice(selectedIndex + 1, selectedIndex + 21).join(" ");
	const joined = [before, middle, after].filter(Boolean).join(" ");
	const cursor = Math.min(joined.length, before.length + (before ? 1 : 0) + Math.max(0, selectedOffset));
	const left = Math.max(
		joined.lastIndexOf(".", cursor - 1),
		joined.lastIndexOf("?", cursor - 1),
		joined.lastIndexOf("!", cursor - 1),
		joined.lastIndexOf("。", cursor - 1),
		joined.lastIndexOf("？", cursor - 1),
		joined.lastIndexOf("！", cursor - 1),
	);
	const rightCandidates = [".", "?", "!", "。", "？", "！"]
		.map((mark) => joined.indexOf(mark, cursor))
		.filter((position) => position >= 0);
	const right = rightCandidates.length ? Math.min(...rightCandidates) + 1 : joined.length;
	const start = Math.max(left + 1, cursor - 250);
	return joined
		.slice(start, Math.min(right, start + 500))
		.replace(/\s+/g, " ")
		.trim();
}

function currentSelection(document: Document): { value: ReaderTextSelection; rect: DOMRect } | undefined {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
	const text = selection.toString().replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	const range = selection.getRangeAt(0);
	const startNode =
		range.startContainer.nodeType === Node.ELEMENT_NODE
			? (range.startContainer as Element)
			: range.startContainer.parentElement;
	const endNode =
		range.endContainer.nodeType === Node.ELEMENT_NODE
			? (range.endContainer as Element)
			: range.endContainer.parentElement;
	const start = startNode?.closest<HTMLElement>(".textLayer span");
	const end = endNode?.closest<HTMLElement>(".textLayer span");
	if (!start || !end) return undefined;
	const pages = Array.from(document.querySelectorAll<HTMLElement>(".page[data-page-number]"))
		.filter((page) => {
			if (!page.querySelector(".textLayer")) return false;
			try {
				return range.intersectsNode(page);
			} catch {
				return false;
			}
		})
		.map((page) => Number(page.dataset.pageNumber))
		.filter((page) => Number.isInteger(page) && page > 0);
	if (!pages.length) return undefined;
	const layer = start.closest(".textLayer");
	const spans = layer ? Array.from(layer.querySelectorAll<HTMLElement>("span")) : [];
	const index = spans.indexOf(start);
	const context =
		index < 0
			? text
			: selectionContextSentence(
					spans.map((span) => span.textContent ?? ""),
					index,
					range.startOffset,
				);
	const rect = range.getBoundingClientRect();
	return { value: { text, pages: [...new Set(pages)], context }, rect };
}

export function connectPdfJsReaderSelection(
	frame: HTMLIFrameElement,
	onSelection: (selection: ReaderTextSelection) => void,
	onExplain: (selection: ReaderTextSelection) => void,
	translationMode: () => { enabled: boolean; activation: number },
): () => void {
	const document = frame.contentDocument;
	const frameWindow = frame.contentWindow;
	if (!document || !frameWindow) return () => undefined;
	const style = document.createElement("link");
	style.rel = "stylesheet";
	style.href = "/pdfjs/paper-agent-selection.css";
	document.head.append(style);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "paper-agent-explain-selection";
	button.textContent = "AI 解读";
	button.setAttribute("aria-label", "把选中文字发送到 AI 输入框解读");
	button.hidden = true;
	document.body.append(button);
	let timer = 0;
	let captured: ReaderTextSelection | undefined;
	let lastKey = "";
	const update = () => {
		const result = currentSelection(document);
		if (!result) {
			button.hidden = true;
			captured = undefined;
			lastKey = "";
			return;
		}
		captured = result.value;
		const top = Math.max(8, Math.min(frameWindow.innerHeight - 38, result.rect.bottom + 8));
		const left = Math.max(8, Math.min(frameWindow.innerWidth - 92, result.rect.left));
		button.style.top = `${top}px`;
		button.style.left = `${left}px`;
		button.hidden = false;
		const mode = translationMode();
		if (!mode.enabled) {
			lastKey = "";
			return;
		}
		const key = `${mode.activation}\0${result.value.pages.join(",")}\0${result.value.text}`;
		if (key !== lastKey) {
			lastKey = key;
			onSelection(result.value);
		}
	};
	const schedule = () => {
		frameWindow.clearTimeout(timer);
		timer = frameWindow.setTimeout(update, 350);
	};
	const preserve = (event: PointerEvent) => event.preventDefault();
	const explain = () => {
		if (captured) onExplain(captured);
		button.hidden = true;
	};
	button.addEventListener("pointerdown", preserve);
	button.addEventListener("click", explain);
	document.addEventListener("selectionchange", schedule);
	document.addEventListener("pointerup", schedule);
	document.addEventListener("keyup", schedule);
	return () => {
		frameWindow.clearTimeout(timer);
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("pointerup", schedule);
		document.removeEventListener("keyup", schedule);
		button.removeEventListener("pointerdown", preserve);
		button.removeEventListener("click", explain);
		button.remove();
		style.remove();
	};
}
