import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { isSingleEnglishWord, type ReaderTextSelection } from "./pdfjs-reader-selection";

type Provider = "google" | "deepl" | "youdao" | "baidu";
type TargetLanguage = "zh-CN" | "en";
const names: Record<Provider, string> = { google: "Google", deepl: "DeepL", youdao: "有道", baidu: "百度" };

export function ReaderTranslationPanel({
	selection,
	open,
	onClose,
}: {
	selection?: ReaderTextSelection;
	open: boolean;
	onClose: () => void;
}) {
	const [available, setAvailable] = useState<Provider[]>([]);
	const [provider, setProvider] = useState<Provider>();
	const [targetLanguage, setTargetLanguage] = useState<TargetLanguage>("zh-CN");
	const [translation, setTranslation] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [providersLoading, setProvidersLoading] = useState(false);
	const cache = useRef(new Map<string, string>());
	const providersLoaded = useRef(false);
	useEffect(() => {
		if (!open || providersLoaded.current) return;
		const controller = new AbortController();
		setProvidersLoading(true);
		void api<{ providers: Provider[]; defaultProvider: Provider }>("/api/reader/translation/providers", {
			signal: controller.signal,
		})
			.then((result) => {
				if (controller.signal.aborted) return;
				providersLoaded.current = true;
				setError("");
				setAvailable(result.providers);
				setProvider((current) =>
					current && result.providers.includes(current)
						? current
						: result.providers.includes(result.defaultProvider)
							? result.defaultProvider
							: result.providers[0],
				);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) setProvidersLoading(false);
			});
		return () => controller.abort();
	}, [open]);
	useEffect(() => {
		if (!open || !selection || !provider) return;
		const key = `${provider}\0${targetLanguage}\0${selection.text}`;
		const cached = cache.current.get(key);
		if (cached !== undefined) {
			setTranslation(cached);
			setError("");
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		setTranslation("");
		setError("");
		setLoading(true);
		void api<{ translation: string }>("/api/reader/translate", {
			method: "POST",
			body: JSON.stringify({ text: selection.text, provider, targetLanguage }),
			signal: controller.signal,
		})
			.then((result) => {
				if (controller.signal.aborted) return;
				cache.current.set(key, result.translation);
				setTranslation(result.translation);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [open, selection, provider, targetLanguage]);
	return (
		<aside className={`reader-translation-panel${open ? "" : " closed"}`} aria-label="选区翻译" hidden={!open}>
			<header className="reader-translation-header">
				<strong>选区翻译</strong>
				<button type="button" onClick={onClose} aria-label="关闭翻译栏">
					<X size={16} />
				</button>
			</header>
			<div className="reader-translation-controls">
				<label>
					服务
					<select
						aria-label="翻译服务"
						value={provider ?? ""}
						onChange={(event) => setProvider(event.target.value as Provider)}
						disabled={!available.length}
					>
						{!available.length && <option value="">未配置</option>}
						{available.map((item) => (
							<option key={item} value={item}>
								{names[item]}
							</option>
						))}
					</select>
				</label>
				<label>
					译为
					<select
						aria-label="目标语言"
						value={targetLanguage}
						onChange={(event) => setTargetLanguage(event.target.value as TargetLanguage)}
					>
						<option value="zh-CN">简体中文</option>
						<option value="en">英语</option>
					</select>
				</label>
			</div>
			<div className="reader-translation-content">
				{!available.length && (
					<output>
						{providersLoading
							? "正在读取翻译服务…"
							: error || "请先在“系统设置 → PDF 选区翻译”配置翻译服务凭据。"}
					</output>
				)}
				{selection ? (
					<>
						<div className="reader-translation-source">
							<span>
								{isSingleEnglishWord(selection.text) ? "单词" : "原文"} · PDF 第 {selection.pages.join("、")} 页
							</span>
							<p>{selection.text}</p>
						</div>
						{isSingleEnglishWord(selection.text) && selection.context && (
							<div className="reader-translation-context">
								<span>所在语境</span>
								<p>{selection.context}</p>
							</div>
						)}
						<div className="reader-translation-result">
							<span>译文{provider ? ` · ${names[provider]}` : ""}</span>
							{loading ? (
								<output>正在翻译…</output>
							) : error ? (
								<p role="alert" className="error">
									{error}
								</p>
							) : (
								<p>{translation || "等待翻译结果"}</p>
							)}
						</div>
					</>
				) : (
					<p>翻译已开启。请在 PDF 中选中单词或句子。</p>
				)}
			</div>
		</aside>
	);
}
