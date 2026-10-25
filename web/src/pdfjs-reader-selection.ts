import { connectPdfJsReaderHighlights } from "./pdfjs-reader-highlights.js";

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
	pdfUrl: string,
	onCapture?: (selection: ReaderTextSelection) => Promise<boolean>,
): () => void {
	const document = frame.contentDocument;
	const frameWindow = frame.contentWindow;
	if (!document || !frameWindow) return () => undefined;
	const style = document.createElement("link");
	style.rel = "stylesheet";
	style.href = "/pdfjs/paper-agent-selection.css?v=2";
	document.head.append(style);
	const highlights = connectPdfJsReaderHighlights(frame, pdfUrl);
	const actions = document.createElement("div");
	actions.className = "paper-agent-selection-actions";
	actions.hidden = true;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "paper-agent-explain-selection";
	button.textContent = "AI 解读";
	button.setAttribute("aria-label", "把选中文字发送到 AI 输入框解读");
	const highlightButton = document.createElement("button");
	highlightButton.type = "button";
	highlightButton.className = "paper-agent-highlight-selection";
	highlightButton.textContent = "高亮";
	highlightButton.title = "保存在当前浏览器，不修改原 PDF";
	highlightButton.setAttribute("aria-label", "高亮选中的 PDF 文字");
	actions.append(button, highlightButton);
	const captureButton = document.createElement("button");
	captureButton.type = "button";
	captureButton.textContent = "记一条";
	captureButton.setAttribute("aria-label", "将选中文字保存到随手记");
	if (onCapture) actions.append(captureButton);
	document.body.append(actions);
	let capturing = false;
	let savedKey = "";
	let timer = 0;
	let captured: ReaderTextSelection | undefined;
	let lastKey = "";
	const update = () => {
		const result = currentSelection(document);
		if (!result) {
			actions.hidden = true;
			captured = undefined;
			if (!capturing) savedKey = "";
			lastKey = "";
			return;
		}
		captured = result.value;
		actions.hidden = false;
		const top = Math.max(8, Math.min(frameWindow.innerHeight - 40, result.rect.bottom + 8));
		const left = Math.max(8, Math.min(frameWindow.innerWidth - actions.offsetWidth - 8, result.rect.left));
		actions.style.top = `${top}px`;
		actions.style.left = `${left}px`;
		actions.hidden = false;
		const captureKey = JSON.stringify([result.value.pages, result.value.text]);
		captureButton.disabled = capturing || savedKey === captureKey;
		captureButton.textContent = capturing ? "正在保存…" : savedKey === captureKey ? "已保存" : "记一条";
		const action = highlights?.selectedAction();
		highlightButton.disabled = !action;
		highlightButton.textContent = action === "remove" ? "取消高亮" : "高亮";
		highlightButton.setAttribute("aria-label", action === "remove" ? "取消所选文字的高亮" : "高亮选中的 PDF 文字");
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
	const capture = async () => {
		if (!captured || !onCapture || capturing) return;
		const value = captured;
		capturing = true; captureButton.disabled = true; captureButton.textContent = "正在保存…";
		try {
			if (await onCapture(value)) savedKey = JSON.stringify([value.pages, value.text]);
		} catch { /* The reader notice owns retry feedback and preserves the submitted selection. */ }
		finally { capturing = false; update(); }
	};
	const explain = () => {
		if (captured) onExplain(captured);
		actions.hidden = true;
	};
	const toggleHighlight = () => {
		const result = highlights?.toggleSelected();
		if (result === "error" || result === "full") {
			highlightButton.textContent = result === "full" ? "高亮数量已达上限" : "高亮保存失败";
			return;
		}
		if (result === "unavailable") return;
		document.getSelection()?.removeAllRanges();
		actions.hidden = true;
	};
	button.addEventListener("pointerdown", preserve);
	button.addEventListener("click", explain);
	highlightButton.addEventListener("pointerdown", preserve);
	highlightButton.addEventListener("click", toggleHighlight);
	captureButton.addEventListener("pointerdown", preserve);
	captureButton.addEventListener("click", capture);
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
		highlightButton.removeEventListener("pointerdown", preserve);
		highlightButton.removeEventListener("click", toggleHighlight);
		captureButton.removeEventListener("pointerdown", preserve);
		captureButton.removeEventListener("click", capture);
		actions.remove();
		highlights?.dispose();
		style.remove();
	};
}
