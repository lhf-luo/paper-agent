import { useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, JobProgress, useJob } from "./components";
import type {
	BackgroundJob,
	ConfirmationGrant,
	PdfTranslationEngineStatus,
	PdfTranslationResult,
	PreparedOperation,
} from "./types";

interface PdfTranslationSource {
	title: string;
	paperId: string;
	namespace: string;
	sha256: string;
}

interface PdfTranslationControlProps {
	source?: PdfTranslationSource;
	onOpenResult: (result: PdfTranslationResult) => void;
}

const requestBody = (source: PdfTranslationSource) => ({
	paperId: source.paperId,
	namespace: source.namespace,
	sourceSha256: source.sha256,
	sourceLanguage: "en",
	targetLanguage: "zh-CN",
	outputMode: "dual" as const,
});

export function PdfTranslationControl({ source, onOpenResult }: PdfTranslationControlProps) {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<PdfTranslationEngineStatus>();
	const [pending, setPending] = useState<PreparedOperation>();
	const [jobId, setJobId] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const job = useJob(jobId);
	const result = job?.status === "succeeded" ? (job.result as PdfTranslationResult) : undefined;

	useEffect(() => {
		let active = true;
		void api<PdfTranslationEngineStatus>("/api/pdf-translations/status")
			.then((value) => {
				if (active) setStatus(value);
			})
			.catch((reason) => {
				if (active)
					setStatus({
						available: false,
						engine: "pdf2zh-next",
						command: "pdf2zh_next",
						reason: String(reason),
					});
			});
		return () => {
			active = false;
		};
	}, []);

	const prepare = async () => {
		if (!source) return;
		setBusy(true);
		setError("");
		try {
			setPending(await api<PreparedOperation>("/api/pdf-translations/prepare", jsonBody(requestBody(source))));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const execute = async () => {
		if (!source || !pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const queued = await api<BackgroundJob>(
				"/api/pdf-translations/execute",
				jsonBody({ ...requestBody(source), grant }),
			);
			setJobId(queued.id);
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const cancel = async () => {
		if (pending) {
			await api(`/api/pdf-translations/${encodeURIComponent(pending.operationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
		setPending(undefined);
		setOpen(false);
	};

	return (
		<div className="pdf-translation-control">
			<button
				type="button"
				className="paper-reader-translate"
				disabled={!source}
				onClick={() => setOpen((current) => !current)}
			>
				翻译 PDF
			</button>
			{open && (
				<div className="pdf-translation-popover">
					<div className="pdf-translation-heading">
						<div>
							<strong>中英双语 PDF</strong>
							<small>{status?.activeModel ?? "正在检查翻译引擎"}</small>
						</div>
						<button type="button" className="icon-button" aria-label="关闭" onClick={() => void cancel()}>
							×
						</button>
					</div>
					{status && !status.available && <p className="error-text">{status.reason}</p>}
					{!pending && !jobId && (
						<button
							className="button primary"
							type="button"
							disabled={busy || !status?.available}
							onClick={() => void prepare()}
						>
							{busy ? "正在准备…" : "开始翻译"}
						</button>
					)}
					{pending && (
						<ConsentCard operation={pending} busy={busy} onConfirm={execute} onCancel={() => void cancel()} />
					)}
					{jobId && <JobProgress job={job} />}
					{result && (
						<button className="button primary" type="button" onClick={() => onOpenResult(result)}>
							打开双语版
						</button>
					)}
					{error && <p className="error-text">{error}</p>}
				</div>
			)}
		</div>
	);
}
