import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, JobProgress, useJob } from "./components";
import type { BackgroundJob, MineruMaterialView, MineruStatus, PreparedOperation } from "./types";

interface MineruSource {
	paperId: string;
	namespace: string;
}

export function MineruControl({ source, compact = false }: { source?: MineruSource; compact?: boolean }) {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<MineruStatus>();
	const [material, setMaterial] = useState<MineruMaterialView>();
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingAction, setPendingAction] = useState<"generate" | "delete">("generate");
	const [jobId, setJobId] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const job = useJob(jobId);

	const load = useCallback(async () => {
		if (!source) return;
		const query = `?namespace=${encodeURIComponent(source.namespace)}`;
		const [engine, current] = await Promise.all([
			api<MineruStatus>("/api/mineru/status"),
			api<MineruMaterialView>(`/api/papers/${encodeURIComponent(source.paperId)}/mineru${query}`),
		]);
		setStatus(engine);
		setMaterial(current);
	}, [source]);

	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [load]);
	useEffect(() => {
		if (job?.status === "succeeded") void load();
	}, [job?.status, load]);

	const prepare = async (force = false) => {
		if (!source) return;
		setBusy(true);
		setJobId(undefined);
		setError("");
		try {
			const result = await api<{
				operation?: PreparedOperation;
				reused?: boolean;
				material?: MineruMaterialView["material"];
			}>(
				`/api/papers/${encodeURIComponent(source.paperId)}/mineru/prepare?namespace=${encodeURIComponent(source.namespace)}`,
				jsonBody({ force }),
			);
			if (result.reused) await load();
			else if (result.operation) {
				setPendingAction("generate");
				setPending(result.operation);
			}
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
			const grant = await confirmOperation(pending);
			if (pendingAction === "delete") {
				await api(
					`/api/papers/${encodeURIComponent(source.paperId)}/mineru/delete/execute?namespace=${encodeURIComponent(source.namespace)}`,
					jsonBody({ grant }),
				);
				setMaterial((current) => (current ? { ...current, material: undefined } : current));
			} else {
				const queued = await api<BackgroundJob>(
					`/api/papers/${encodeURIComponent(source.paperId)}/mineru/execute?namespace=${encodeURIComponent(source.namespace)}`,
					jsonBody({ grant }),
				);
				setJobId(queued.id);
			}
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const cancel = async () => {
		if (pending) {
			await api(`/api/mineru/operations/${encodeURIComponent(pending.operationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
		setPending(undefined);
	};

	const prepareDelete = async () => {
		if (!source) return;
		setBusy(true);
		try {
			setPendingAction("delete");
			setPending(
				await api<PreparedOperation>(
					`/api/papers/${encodeURIComponent(source.paperId)}/mineru/delete/prepare?namespace=${encodeURIComponent(source.namespace)}`,
					jsonBody({}),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`mineru-control${compact ? " compact" : ""}`}>
			<button
				type="button"
				className={compact ? "mineru-compact-button" : "paper-reader-material"}
				onClick={() => setOpen((value) => !value)}
				disabled={!source}
			>
				{compact ? (
					<>
						<span>解析材料</span>
						<strong>{material?.material?.pageCount ?? 0}</strong>
						<small>{material?.stale ? "需要更新" : material?.material ? "打开或重建" : "尚未生成"}</small>
					</>
				) : material?.material ? (
					material.stale ? (
						"材料需更新"
					) : (
						"解析材料"
					)
				) : (
					"生成解析材料"
				)}
			</button>
			{open && (
				<div className="mineru-popover">
					<div className="mineru-heading">
						<div>
							<strong>MinerU 解析材料</strong>
							<small>
								{material?.material
									? `${material.material.pageCount} 页 · ${material.material.modelVersion}`
									: "尚未生成"}
							</small>
						</div>
						<button type="button" className="icon-button" aria-label="关闭" onClick={() => setOpen(false)}>
							<X size={14} aria-hidden="true" />
						</button>
					</div>
					{status && !status.available && <p className="error-text">{status.reason}</p>}
					{material?.missing && <p className="error-text">数据库记录存在，但材料目录已丢失。</p>}
					{pending ? (
						<ConsentCard operation={pending} busy={busy} onConfirm={execute} onCancel={() => void cancel()} />
					) : (
						<div className="button-row">
							<button
								type="button"
								className="button primary"
								disabled={busy || !status?.available}
								onClick={() => void prepare(Boolean(material?.material))}
							>
								{busy ? "正在准备..." : material?.material ? "重新生成" : "开始生成"}
							</button>
							{material?.material && (
								<button
									type="button"
									className="button secondary"
									onClick={() =>
										void api(
											`/api/papers/${encodeURIComponent(source!.paperId)}/mineru/open?namespace=${encodeURIComponent(source!.namespace)}`,
											jsonBody({}),
										).catch((reason) => setError(String(reason)))
									}
								>
									打开目录
								</button>
							)}
							{material?.material && (
								<button type="button" className="button danger" onClick={() => void prepareDelete()}>
									删除
								</button>
							)}
						</div>
					)}
					{jobId && <JobProgress job={job} />}
					{error && <p className="error-text">{error}</p>}
				</div>
			)}
		</div>
	);
}
