import { ArrowUpRight, Clock, FileText, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import {
	AccessibleModal,
	ConsentCard,
	confirmOperation,
	JobProgress,
	PageHeading,
	PdfViewer,
	StatusPill,
	useJob,
} from "./components";
import { useRouterContext } from "./router";
import type { BackgroundJob, ConfirmationGrant, PaperAsset, PaperRecord, PreparedOperation } from "./types";
import { useWorkspace } from "./workspace-context";

export interface PdfWorkspacePageProps {
	onTask: (job: BackgroundJob) => void;
}

export function PdfWorkspacePage({ onTask }: PdfWorkspacePageProps) {
	const { lastTask } = useWorkspace();
	const { navigate } = useRouterContext();
	const [path, setPath] = useState("");
	const [availablePdfs, setAvailablePdfs] = useState<
		Array<{
			paperId: string;
			title: string;
			sha256: string;
			blobPath: string;
			sourceUrl?: string;
			hasPdf: boolean;
		}>
	>([]);
	const [jobId, setJobId] = useState<string>();
	const [mode, setMode] = useState<"analysis" | "artifacts" | "acquisition">("analysis");
	const [selectedArtifacts, setSelectedArtifacts] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<PreparedOperation>();
	const [correctionPending, setCorrectionPending] = useState<PreparedOperation>();
	const [correctionAsset, setCorrectionAsset] = useState<PaperAsset>();
	const [correctionRegion, setCorrectionRegion] = useState<PaperAsset["candidateRegion"]>();
	const [correctionNote, setCorrectionNote] = useState("");
	const [artifactDetails, setArtifactDetails] = useState<any>();
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [teamPending, setTeamPending] = useState<PreparedOperation>();
	const [teamPaperId, setTeamPaperId] = useState("");
	const [personalNamespace, setPersonalNamespace] = useState("default");
	const [personalNamespaces, setPersonalNamespaces] = useState<string[]>(["default"]);
	const [personalPapers, setPersonalPapers] = useState<PaperRecord[]>([]);

	useEffect(() => {
		void api<{ pdfs: typeof availablePdfs }>("/api/library/pdfs")
			.then((value) => setAvailablePdfs(value.pdfs))
			.catch(() => setAvailablePdfs([]));
	}, []);

	const [pdfPickerOpen, setPdfPickerOpen] = useState(false);
	const pdfPickerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (pdfPickerRef.current && !pdfPickerRef.current.contains(event.target as Node)) setPdfPickerOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, []);

	const job = useJob(jobId);

	useEffect(() => {
		void api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces")
			.then((value) => {
				setPersonalNamespace(value.defaultNamespace);
				setPersonalNamespaces(value.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);

	useEffect(() => {
		void api<{ hits: Array<{ record: PaperRecord }> }>(
			`/api/library?namespace=${encodeURIComponent(personalNamespace)}&limit=300`,
		)
			.then((value) => {
				const records = value.hits.map((hit) => hit.record);
				setPersonalPapers(records);
				setTeamPaperId((current) =>
					current && records.some((record) => record.id === current) ? current : (records[0]?.id ?? ""),
				);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [personalNamespace]);

	const resolvePdfValue = useCallback(
		(value: string): { pdfPath: string; pdf?: (typeof availablePdfs)[number] } => {
			const trimmed = value.trim();
			if (!trimmed) return { pdfPath: "" };
			const byPath = availablePdfs.find((pdf) => pdf.hasPdf && pdf.blobPath === trimmed);
			if (byPath) return { pdfPath: byPath.blobPath, pdf: byPath };
			const byTitle = availablePdfs.find((pdf) => pdf.title === trimmed);
			if (byTitle) return { pdfPath: byTitle.hasPdf ? byTitle.blobPath : "", pdf: byTitle };
			const byId = availablePdfs.find((pdf) => pdf.paperId === trimmed);
			if (byId) return { pdfPath: byId.hasPdf ? byId.blobPath : "", pdf: byId };
			return { pdfPath: trimmed };
		},
		[availablePdfs],
	);

	const resolvePdfHint = useCallback(
		(value: string): string => {
			const { pdfPath, pdf } = resolvePdfValue(value);
			if (pdf && !pdf.hasPdf) return "该论文尚未下载 PDF，请先到个人库下载后再分析。";
			if (pdf && pdfPath) return `将使用个人库 PDF：${pdf.paperId}`;
			if (pdfPath) return "将作为本地路径直接使用。";
			return "";
		},
		[resolvePdfValue],
	);

	const run = async (kind: "analysis" | "artifacts") => {
		setBusy(true);
		setError("");
		setMessage("");
		setMode(kind);
		setJobId(undefined);
		if (kind === "artifacts") {
			setSelectedArtifacts(new Set());
			setPending(undefined);
			setArtifactDetails(undefined);
		}
		try {
			const resolved = resolvePdfValue(path);
			if (!resolved.pdfPath) {
				setError(resolved.pdf ? "该论文尚未下载 PDF，请先到个人库下载后再分析。" : "请输入本地 PDF 路径或选择论文");
				return;
			}
			const created = await api<BackgroundJob>(
				kind === "analysis" ? "/api/pdf/analyze" : "/api/artifacts/discover",
				jsonBody(kind === "analysis" ? { pdfPath: resolved.pdfPath, refine: true } : { pdfPath: resolved.pdfPath }),
			);
			setJobId(created.id);
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const assets: PaperAsset[] = mode === "analysis" && job?.status === "succeeded" ? (job.result?.assets ?? []) : [];
	const candidates: any[] = mode === "artifacts" && job?.status === "succeeded" ? (job.result?.candidates ?? []) : [];

	useEffect(() => {
		if (mode !== "acquisition" || job?.status !== "succeeded") return;
		void api(`/api/artifacts/jobs/${encodeURIComponent(job.id)}`)
			.then(setArtifactDetails)
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [job, mode]);

	const prepareAcquire = async () => {
		setBusy(true);
		setError("");
		try {
			const value = await api<{ prepared: PreparedOperation }>(
				"/api/artifacts/prepare",
				jsonBody({ pdfPath: path, candidateIds: [...selectedArtifacts] }),
			);
			setPending(value.prepared);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const executeAcquire = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/artifacts/execute",
				jsonBody({ pdfPath: path, candidateIds: [...selectedArtifacts], grant }),
			);
			onTask(created);
			setPending(undefined);
			setJobId(created.id);
			setMode("acquisition");
			setArtifactDetails(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const prepareTeamManifest = async () => {
		if (!job || !teamPaperId) return;
		setBusy(true);
		setError("");
		try {
			setTeamPending(
				await api<PreparedOperation>(
					"/api/team/artifacts/prepare",
					jsonBody({ artifactJobId: job.id, paperId: teamPaperId, personalNamespace }),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const executeTeamManifest = async () => {
		if (!job || !teamPending || !teamPaperId) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(teamPending)) as ConfirmationGrant;
			await api(
				"/api/team/artifacts/execute",
				jsonBody({ artifactJobId: job.id, paperId: teamPaperId, personalNamespace, grant }),
			);
			setTeamPending(undefined);
			setMessage("Artifact manifest 已提交到团队审核队列；团队服务不会自动接收本地文件。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const selectCorrection = (asset: PaperAsset, region = asset.candidateRegion) => {
		setCorrectionAsset(asset);
		setCorrectionRegion(region);
		setCorrectionNote("");
	};

	const prepareCorrection = async () => {
		if (!job || !correctionAsset || !correctionRegion) return;
		setBusy(true);
		setError("");
		try {
			setCorrectionPending(
				await api<PreparedOperation>(
					"/api/pdf/corrections/prepare",
					jsonBody({
						analysisJobId: job.id,
						assetId: correctionAsset.id,
						correctedRegion: correctionRegion,
						note: correctionNote,
					}),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const executeCorrection = async () => {
		if (!job || !correctionPending || !correctionAsset || !correctionRegion) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(correctionPending)) as ConfirmationGrant;
			await api(
				"/api/pdf/corrections/execute",
				jsonBody({
					analysisJobId: job.id,
					assetId: correctionAsset.id,
					correctedRegion: correctionRegion,
					note: correctionNote,
					grant,
				}),
			);
			setCorrectionPending(undefined);
			setCorrectionAsset(undefined);
			setCorrectionRegion(undefined);
			await run("analysis");
			setMessage("图表区域校正已保存，并已重新分析应用最新校正。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeading
				eyebrow="EVIDENCE & ARTIFACTS · 原文与证据"
				title="PDF 与 Artifact 工作台"
				description="输入本地 PDF 路径，建立图表、正文 mention、section 和公开 artifact 的可追溯关联。"
			/>
			{lastTask &&
				(lastTask.type.includes("pdf") ||
					lastTask.type.includes("mineru") ||
					lastTask.type.includes("translate") ||
					lastTask.type.includes("import")) && (
					<div className="task-dock-banner">
						<div className="task-dock-info">
							<Clock size={14} />
							<span>
								当前关联后台任务：<strong>{lastTask.type}</strong> ({lastTask.status})
							</span>
						</div>
						<button type="button" className="button secondary sm" onClick={() => navigate("tasks")}>
							查看任务中心详情 <ArrowUpRight size={12} style={{ marginLeft: 4 }} />
						</button>
					</div>
				)}
			<section className="path-workbench">
				<label>
					<span>本地 PDF 路径（可直接输入，或从个人库选择论文）</span>
					<div className="pdf-combobox" ref={pdfPickerRef}>
						<input
							value={path}
							onChange={(event) => setPath(event.target.value)}
							onFocus={() => setPdfPickerOpen(true)}
							placeholder="输入路径，或点击选择已入库论文…"
							role="combobox"
							aria-expanded={pdfPickerOpen}
							aria-controls="pdf-combobox-options"
							aria-autocomplete="list"
						/>
						{pdfPickerOpen && availablePdfs.length > 0 && (
							<ul className="pdf-combobox-list" id="pdf-combobox-options" aria-label="可选择的论文 PDF">
								{availablePdfs.map((pdf) => (
									<li key={pdf.paperId}>
										<button
											type="button"
											className="pdf-combobox-option"
											title={pdf.title}
											onClick={() => {
												setPath(pdf.hasPdf ? pdf.blobPath : "");
												setError(pdf.hasPdf ? "" : "该论文尚未下载 PDF，请先到个人库下载后再分析。");
												setPdfPickerOpen(false);
											}}
										>
											<span className="pdf-combobox-title">{pdf.title}</span>
											<span className="pdf-combobox-meta">
												{pdf.hasPdf ? "已下载" : "未下载PDF"} · {pdf.paperId}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					{path && <small className="path-resolved-hint">{resolvePdfHint(path)}</small>}
				</label>
				<div className="button-row">
					<button
						className="button primary"
						disabled={!path || busy}
						type="button"
						onClick={() => void run("analysis")}
					>
						分析图表与正文
					</button>
					<button
						className="button secondary"
						disabled={!path || busy}
						type="button"
						onClick={() => void run("artifacts")}
					>
						发现 Artifact
					</button>
				</div>
			</section>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			<JobProgress job={job} />
			{pending && (
				<AccessibleModal
					title="确认获取 PDF"
					onClose={() => {
						if (!busy) setPending(undefined);
					}}
					maxWidth={620}
				>
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => setPending(undefined)}
						onConfirm={executeAcquire}
					/>
				</AccessibleModal>
			)}
			{correctionPending && (
				<AccessibleModal
					title="确认保存 PDF 标注修正"
					onClose={() => {
						if (!busy) setCorrectionPending(undefined);
					}}
					maxWidth={620}
				>
					<ConsentCard
						operation={correctionPending}
						busy={busy}
						onCancel={() => setCorrectionPending(undefined)}
						onConfirm={executeCorrection}
					/>
				</AccessibleModal>
			)}
			{teamPending && (
				<AccessibleModal
					title="确认团队材料提交"
					onClose={() => {
						if (!busy) setTeamPending(undefined);
					}}
					maxWidth={640}
				>
					<ConsentCard
						operation={teamPending}
						busy={busy}
						onCancel={() => setTeamPending(undefined)}
						onConfirm={executeTeamManifest}
					/>
				</AccessibleModal>
			)}
			{path && mode === "analysis" && job?.status === "succeeded" && (
				<div className="reader-grid">
					<PdfViewer
						url={`/api/local-pdf?path=${encodeURIComponent(path)}`}
						assets={assets}
						pageMetrics={job.result?.pages ?? []}
						editable
						onAssetSelect={(asset) => selectCorrection(asset)}
						onRegionChange={(asset, region) => selectCorrection(asset, region)}
					/>
					<aside className="asset-details">
						<span className="eyebrow">DETECTED ASSETS · 结构化资产</span>
						<h2>{assets.length} 个图表资产</h2>
						<p className="muted">拖动框移动区域，拖动右下角控制点改变大小；保存前会显示 exact-plan 确认。</p>
						{correctionAsset && correctionRegion && (
							<div className="crop-editor">
								<strong>
									校正 {correctionAsset.type} {correctionAsset.identifier}
								</strong>
								<div className="crop-grid">
									{(["x", "y", "width", "height"] as const).map((key) => (
										<label key={key}>
											<span>{key}</span>
											<input
												type="number"
												step="0.1"
												value={Math.round(correctionRegion[key] * 10) / 10}
												onChange={(event) =>
													setCorrectionRegion({ ...correctionRegion, [key]: Number(event.target.value) })
												}
											/>
										</label>
									))}
								</div>
								<textarea
									rows={2}
									value={correctionNote}
									onChange={(event) => setCorrectionNote(event.target.value)}
									placeholder="校正原因（可选）"
								/>
								<div className="button-row">
									<button
										type="button"
										className="button secondary"
										onClick={() => {
											setCorrectionAsset(undefined);
											setCorrectionRegion(undefined);
										}}
									>
										取消
									</button>
									<button
										type="button"
										className="button primary"
										disabled={busy}
										onClick={() => void prepareCorrection()}
									>
										保存校正
									</button>
								</div>
							</div>
						)}
						{assets.map((asset) => (
							<article className={correctionAsset?.id === asset.id ? "selected" : ""} key={asset.id}>
								<button className="asset-select-button" type="button" onClick={() => selectCorrection(asset)}>
									<strong>
										{asset.type} {asset.identifier}
									</strong>
									<StatusPill status={asset.manualCorrection ? "high" : asset.regionConfidence} />
									<p>{asset.caption}</p>
									<small>
										{asset.mentions[0]?.section || "Section 未识别"} · {asset.mentions.length} 个正文引用
										{asset.subfigureRegions?.length ? ` · ${asset.subfigureRegions.length} 个子图` : ""}
										{asset.continuationRegions?.length ? ` · ${asset.continuationRegions.length} 个续页` : ""}
									</small>
									{asset.manualCorrection && (
										<small>
											人工校正：{asset.manualCorrection.author} ·{" "}
											{new Date(asset.manualCorrection.createdAt).toLocaleString()}
										</small>
									)}
								</button>
								{asset.mentions.slice(0, 2).map((mention, index) => (
									<blockquote key={`${asset.id}-${index}`}>
										<strong>{mention.matchedText}</strong> · {mention.context}
									</blockquote>
								))}
							</article>
						))}
					</aside>
				</div>
			)}
			{candidates.length > 0 && (
				<section className="panel">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">ARTIFACT CANDIDATES · 候选代码与模型</span>
							<h2>发现 {candidates.length} 个候选</h2>
						</div>
						<button
							className="button primary"
							disabled={!selectedArtifacts.size || busy}
							type="button"
							onClick={() => void prepareAcquire()}
						>
							获取所选 Artifact
						</button>
					</div>
					<div className="artifact-list">
						{candidates.map((candidate) => (
							<label key={candidate.id}>
								<input
									type="checkbox"
									checked={selectedArtifacts.has(candidate.id)}
									onChange={(event) =>
										setSelectedArtifacts((current) => {
											const next = new Set(current);
											event.target.checked ? next.add(candidate.id) : next.delete(candidate.id);
											return next;
										})
									}
								/>
								<div>
									<strong>{candidate.kind}</strong>
									<code>{candidate.url}</code>
									<small>
										{candidate.confidence} ·{" "}
										{candidate.sources
											?.map((source: any) => (source.page ? `p.${source.page}` : source.method))
											.join(" · ")}
									</small>
								</div>
							</label>
						))}
					</div>
				</section>
			)}
			{mode !== "analysis" && job?.status === "succeeded" && (
				<section className="panel team-manifest-share">
					<div>
						<span className="eyebrow">PROPOSAL PIPELINE · 团队提案</span>
						<h2>提交到团队审核队列</h2>
						<p>只提交来源链接、PDF hash、commit/hash、失败原因和获取记录；本地 artifact 文件不会自动上传。</p>
					</div>
					<div className="team-manifest-controls">
						<select value={personalNamespace} onChange={(event) => setPersonalNamespace(event.target.value)}>
							{personalNamespaces.map((namespace) => (
								<option key={namespace} value={namespace}>
									{namespace}
								</option>
							))}
						</select>
						<select value={teamPaperId} onChange={(event) => setTeamPaperId(event.target.value)}>
							{personalPapers.map((paper) => (
								<option key={paper.id} value={paper.id}>
									{paper.title}
								</option>
							))}
						</select>
						<button
							className="button primary"
							type="button"
							disabled={!teamPaperId || busy}
							onClick={() => void prepareTeamManifest()}
						>
							预览并提议
						</button>
					</div>
				</section>
			)}
			{mode === "acquisition" && artifactDetails && (
				<section className="artifact-result-grid">
					<div className="panel">
						<span className="eyebrow">ACQUISITIONS · 关联产物清单</span>
						<h2>Artifact 获取结果</h2>
						<p>
							<code>{artifactDetails.manifestPath}</code>
						</p>
						<div className="artifact-snapshots">
							{artifactDetails.manifest.acquisitions.map((snapshot: any, index: number) => (
								<article key={`${snapshot.candidateId}-${index}`}>
									<StatusPill status={snapshot.status === "failed" ? "failed" : "succeeded"} />
									<div>
										<strong>{snapshot.candidateId}</strong>
										<code>{snapshot.finalUrl ?? snapshot.sourceUrl}</code>
										<small>
											{snapshot.commit
												? `commit ${snapshot.commit}`
												: snapshot.sha256
													? `sha256 ${snapshot.sha256}`
													: (snapshot.failureReason ?? "无额外证据")}
										</small>
										<small>
											{snapshot.bytes ? `${Math.round(snapshot.bytes / 1024)} KB` : ""}
											{snapshot.licenseFiles?.length
												? ` · license: ${snapshot.licenseFiles.map((item: string) => item.split(/[\\/]/).at(-1)).join(", ")}`
												: ""}
										</small>
									</div>
								</article>
							))}
						</div>
					</div>
					<div className="panel">
						<span className="eyebrow">FILE TREE · 源码树状目录</span>
						<h2>本地文件结构</h2>
						<p className="muted">为避免泄露和性能问题，最多显示 1500 项、6 层，并跳过 .git 与 node_modules。</p>
						<div className="file-tree">
							{artifactDetails.tree.map((entry: any) => (
								<div key={entry.path} className={`tree-${entry.type}`}>
									<span className="tree-icon">
										{entry.type === "directory" ? <Folder size={14} /> : <FileText size={14} />}
									</span>
									<code>{entry.path}</code>
									<small>{entry.bytes === undefined ? "" : `${Math.round(entry.bytes / 1024)} KB`}</small>
								</div>
							))}
						</div>
						{artifactDetails.truncated && <div className="error-banner">文件树已按安全上限截断。</div>}
					</div>
				</section>
			)}
		</>
	);
}

export default PdfWorkspacePage;
