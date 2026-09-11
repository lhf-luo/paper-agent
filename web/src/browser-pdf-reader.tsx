import { useEffect, useMemo, useState } from "react";

export function nativePdfViewerUrl(url: string): string {
	const separator = url.includes("#") ? "&" : "#";
	return `${url}${separator}page=1&zoom=page-width`;
}

export function BrowserPdfReader({ url, title }: { url: string; title: string }) {
	const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const viewerUrl = useMemo(() => nativePdfViewerUrl(url), [url]);

	useEffect(() => {
		const controller = new AbortController();
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

	if (status === "checking") {
		return <div className="browser-pdf-status">正在加载 PDF…</div>;
	}
	if (status === "error") {
		return (
			<div className="browser-pdf-status error">
				<strong>无法在阅读器中打开 PDF</strong>
				<p>{error}</p>
				<div className="button-row">
					<button type="button" className="button secondary" onClick={() => setRetry((current) => current + 1)}>
						重试
					</button>
					<a className="button primary" href={url} target="_blank" rel="noreferrer">
						在新标签页打开
					</a>
				</div>
			</div>
		);
	}
	return <iframe className="browser-pdf-frame" src={viewerUrl} title={`${title} PDF`} />;
}
