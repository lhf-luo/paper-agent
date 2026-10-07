import { useEffect, useMemo, useRef, useState } from "react";
import { connectPdfJsBilingualSelectionBridge } from "./pdfjs-bilingual-selection";
import { connectPdfJsReaderSelection, type ReaderTextSelection } from "./pdfjs-reader-selection";
import { mozillaPdfViewerUrl } from "./pdfjs-viewer-url";

export function MozillaPdfReader({
	url,
	title,
	enableBilingualSelection,
	translationEnabled,
	translationActivation,
	onSelection,
	onExplain,
}: {
	url: string;
	title: string;
	enableBilingualSelection: boolean;
	translationEnabled: boolean;
	translationActivation: number;
	onSelection: (selection: ReaderTextSelection) => void;
	onExplain: (selection: ReaderTextSelection) => void;
}) {
	const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const bridgeCleanup = useRef<() => void>(() => undefined);
	const onSelectionRef = useRef(onSelection);
	const onExplainRef = useRef(onExplain);
	const translationModeRef = useRef({ enabled: translationEnabled, activation: translationActivation });
	onSelectionRef.current = onSelection;
	onExplainRef.current = onExplain;
	translationModeRef.current = { enabled: translationEnabled, activation: translationActivation };
	const viewerUrl = useMemo(() => mozillaPdfViewerUrl(url, window.location.origin), [url]);

	useEffect(() => {
		const controller = new AbortController();
		bridgeCleanup.current();
		bridgeCleanup.current = () => undefined;
		setStatus("checking");
		setError("");
		void fetch(url, { method: "HEAD", signal: controller.signal, cache: retry ? "reload" : "default" })
			.then((response) => {
				if (!response.ok) throw new Error(`PDF 加载失败（HTTP ${response.status}）`);
				if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) {
					throw new Error("服务器返回的内容不是 PDF");
				}
				setStatus("ready");
			})
			.catch((reason) => {
				if (controller.signal.aborted) return;
				setError(reason instanceof Error ? reason.message : "PDF 加载失败");
				setStatus("error");
			});
		return () => controller.abort();
	}, [url, retry]);

	useEffect(
		() => () => {
			bridgeCleanup.current();
		},
		[],
	);
	useEffect(() => {
		if (translationActivation > 0) frameRef.current?.contentWindow?.getSelection()?.removeAllRanges();
	}, [translationActivation]);

	if (status === "checking") return <div className="browser-pdf-status">正在加载 Mozilla PDF.js…</div>;
	if (status === "error") {
		return (
			<div className="browser-pdf-status error">
				<strong>无法在 Mozilla PDF.js 中打开 PDF</strong>
				<p>{error}</p>
				<div className="button-row">
					<button type="button" className="button secondary" onClick={() => setRetry((current) => current + 1)}>
						重试
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="mozilla-pdf-reader">
			<iframe
				ref={frameRef}
				className="browser-pdf-frame mozilla-pdf-frame"
				src={viewerUrl}
				title={`${title} PDF`}
				onError={() => {
					bridgeCleanup.current();
					bridgeCleanup.current = () => undefined;
					setError("Mozilla PDF.js Viewer 加载失败");
					setStatus("error");
				}}
				onLoad={() => {
					bridgeCleanup.current();
					bridgeCleanup.current = () => undefined;
					const frame = frameRef.current;
					if (!frame?.contentDocument?.getElementById("viewer")) {
						setError("Mozilla PDF.js Viewer 未正确加载");
						setStatus("error");
						return;
					}
					const cleanups: Array<() => void> = [];
					const viewerWindow = frame.contentWindow;
					const resizeViewer = () => {
						if (!viewerWindow || !frame.clientWidth) return;
						viewerWindow.dispatchEvent(new Event("resize"));
					};
					const container = frame.parentElement;
					if (container) {
						const viewsToggle = frame.contentDocument.getElementById("viewsManagerToggleButton");
						let wasNarrow = false;
						let narrowHandled = false;
						const collapseOutline = () => {
							if (
								container.clientWidth >= 700 ||
								narrowHandled ||
								viewsToggle?.getAttribute("aria-expanded") !== "true"
							)
								return;
							viewsToggle.click();
							narrowHandled = true;
						};
						const observer = new ResizeObserver(() => {
							resizeViewer();
							const isNarrow = container.clientWidth < 700;
							if (isNarrow && !wasNarrow) narrowHandled = false;
							wasNarrow = isNarrow;
							collapseOutline();
						});
						observer.observe(container);
						cleanups.push(() => observer.disconnect());
						if (viewsToggle) {
							const menuObserver = new MutationObserver(collapseOutline);
							menuObserver.observe(viewsToggle, { attributes: true, attributeFilter: ["aria-expanded"] });
							cleanups.push(() => menuObserver.disconnect());
						}
					}
					try {
						cleanups.push(
							connectPdfJsReaderSelection(
								frame,
								(value) => onSelectionRef.current(value),
								(value) => onExplainRef.current(value),
								() => translationModeRef.current,
							),
						);
					} catch (reason) {
						console.warn("Unable to attach PDF selection bridge", reason);
					}
					if (enableBilingualSelection) {
						try {
							cleanups.push(connectPdfJsBilingualSelectionBridge(frame));
						} catch (reason) {
							console.warn("Unable to attach the bilingual PDF selection bridge", reason);
						}
					}
					bridgeCleanup.current = () => {
						for (const cleanup of cleanups) cleanup();
					};
				}}
			/>
		</div>
	);
}
