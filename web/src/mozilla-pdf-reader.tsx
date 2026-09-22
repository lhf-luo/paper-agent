import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserPdfReader } from "./browser-pdf-reader";
import { connectPdfJsBilingualSelectionBridge } from "./pdfjs-bilingual-selection";
import { mozillaPdfViewerUrl } from "./pdfjs-viewer-url";

export function MozillaPdfReader({ url, title }: { url: string; title: string }) {
	const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const [useNativeReader, setUseNativeReader] = useState(false);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const bridgeCleanup = useRef<() => void>(() => undefined);
	const viewerUrl = useMemo(() => mozillaPdfViewerUrl(url, window.location.origin), [url]);

	useEffect(() => {
		const controller = new AbortController();
		bridgeCleanup.current();
		bridgeCleanup.current = () => undefined;
		setStatus("checking");
		setError("");
		setUseNativeReader(false);
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

	const useBrowserReader = () => {
		bridgeCleanup.current();
		bridgeCleanup.current = () => undefined;
		setUseNativeReader(true);
	};

	if (useNativeReader) return <BrowserPdfReader url={url} title={title} />;
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
					<button type="button" className="button primary" onClick={useBrowserReader}>
						使用浏览器阅读器
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="mozilla-pdf-reader">
			<button type="button" className="mozilla-pdf-native-fallback" onClick={useBrowserReader}>
				使用浏览器阅读器
			</button>
			<iframe
				ref={frameRef}
				className="browser-pdf-frame mozilla-pdf-frame"
				src={viewerUrl}
				title={`${title} 双语 PDF`}
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
					try {
						bridgeCleanup.current = connectPdfJsBilingualSelectionBridge(frame);
					} catch (reason) {
						console.warn("Unable to attach the bilingual PDF selection bridge", reason);
					}
				}}
			/>
		</div>
	);
}
