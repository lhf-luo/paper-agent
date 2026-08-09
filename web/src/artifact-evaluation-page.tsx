import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation, EmptyState, LoadingBlock, PdfViewer, StatusPill } from "./components";
import type {
	ArtifactCandidate,
	ArtifactKind,
	ArtifactReviewDetail,
	ArtifactReviewQueueItem,
	ConfirmationGrant,
	PreparedOperation,
} from "./types";

interface CandidateDraft {
	candidateId: string;
	disposition: "pending" | "expected" | "ignored";
	artifactId: string;
	kind: ArtifactKind;
	acceptedUrls: string;
	pages: string;
	note: string;
	reason: string;
}

interface ManualArtifactDraft {
	key: string;
	id: string;
	urls: string;
	kind: ArtifactKind;
	pages: string;
	note: string;
}

interface LocalReviewDraft {
	version: 1;
	pdfSha256: string;
	reviewer: string;
	notes: string;
	reviewedPages: number[];
	candidateReviews: CandidateDraft[];
	manualArtifacts: ManualArtifactDraft[];
}

const artifactKinds: ArtifactKind[] = ["repository", "dataset", "supplement", "project", "unknown"];

function draftStorageKey(slug: string, pdfSha256: string): string {
	return `paper-agent:artifact-review:${slug}:${pdfSha256}`;
}

function splitLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function parsePages(value: string): number[] {
	return [
		...new Set(
			value
				.split(/[\s,;]+/)
				.map((item) => Number(item))
				.filter((item) => Number.isInteger(item) && item > 0),
		),
	].sort((left, right) => left - right);
}

function candidatePages(candidate: ArtifactCandidate): number[] {
	return [
		...new Set(
			candidate.sources.map((source) => source.page).filter((page): page is number => Number.isInteger(page)),
		),
	].sort((left, right) => left - right);
}

function newManualKey(): string {
	return globalThis.crypto?.randomUUID?.() ?? `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function serverDraft(detail: ArtifactReviewDetail): Omit<LocalReviewDraft, "version" | "pdfSha256"> {
	const states = new Map(detail.reviewState.candidateReviews.map((review) => [review.candidateId, review]));
	return {
		reviewer: detail.reviewState.reviewer,
		notes: detail.reviewState.notes,
		reviewedPages: detail.reviewState.reviewedPages,
		candidateReviews: detail.candidates.map((candidate) => {
			const review = states.get(candidate.id);
			return {
				candidateId: candidate.id,
				disposition: review?.disposition ?? "pending",
				artifactId: review?.artifactId ?? candidate.id,
				kind: review?.kind ?? candidate.kind,
				acceptedUrls: (review?.acceptedUrls ?? [candidate.url]).join("\n"),
				pages: (review?.pages ?? candidatePages(candidate)).join(", "),
				note: review?.note ?? "",
				reason: review?.reason ?? "",
			};
		}),
		manualArtifacts: detail.reviewState.manualArtifacts.map((artifact) => ({
			key: newManualKey(),
			id: artifact.id,
			urls: artifact.urls.join("\n"),
			kind: artifact.kind ?? "unknown",
			pages: artifact.pages?.join(", ") ?? "",
			note: artifact.note ?? "",
		})),
	};
}

function PageHeading() {
	return (
		<header className="page-heading">
			<div>
				<span className="eyebrow">Human evaluation</span>
				<h1>Artifact 质量评估</h1>
				<p>逐页检查固定 PDF，独立判断每个候选，并在代码级确认后保存真正的人工 gold annotation。</p>
			</div>
		</header>
	);
}

export function ArtifactEvaluationPage() {
	const [queue, setQueue] = useState<{ papers: ArtifactReviewQueueItem[]; totals: Record<string, number> }>();
	const [selectedSlug, setSelectedSlug] = useState("");
	const [detail, setDetail] = useState<ArtifactReviewDetail>();
	const [reviewer, setReviewer] = useState("");
	const [notes, setNotes] = useState("");
	const [reviewedPages, setReviewedPages] = useState<Set<number>>(new Set());
	const [candidateReviews, setCandidateReviews] = useState<Record<string, CandidateDraft>>({});
	const [manualArtifacts, setManualArtifacts] = useState<ManualArtifactDraft[]>([]);
	const [currentPage, setCurrentPage] = useState(1);
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingSubmission, setPendingSubmission] = useState<Record<string, unknown>>();
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [draftReady, setDraftReady] = useState(false);
	const [dirty, setDirty] = useState(false);

	const loadQueue = useCallback(async () => {
		const value = await api<{ papers: ArtifactReviewQueueItem[]; totals: Record<string, number> }>(
			"/api/evaluation/artifacts",
		);
		setQueue(value);
		setSelectedSlug((current) =>
			current && value.papers.some((paper) => paper.slug === current)
				? current
				: (value.papers.find((paper) => !paper.humanReviewed)?.slug ?? value.papers[0]?.slug ?? ""),
		);
	}, []);

	useEffect(() => {
		void loadQueue()
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setLoading(false));
	}, [loadQueue]);

	useEffect(() => {
		if (!selectedSlug) {
			setDetail(undefined);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError("");
		setMessage("");
		setPending(undefined);
		setPendingSubmission(undefined);
		setDraftReady(false);
		setDirty(false);
		void api<ArtifactReviewDetail>(`/api/evaluation/artifacts/${encodeURIComponent(selectedSlug)}`)
			.then((value) => {
				if (cancelled) return;
				const fromServer = serverDraft(value);
				let restored: LocalReviewDraft | undefined;
				try {
					const raw = localStorage.getItem(draftStorageKey(value.source.slug, value.pdfSha256));
					const parsed = raw ? (JSON.parse(raw) as LocalReviewDraft) : undefined;
					if (
						parsed?.version === 1 &&
						parsed.pdfSha256 === value.pdfSha256 &&
						Array.isArray(parsed.candidateReviews) &&
						Array.isArray(parsed.manualArtifacts)
					) {
						restored = parsed;
					}
				} catch {
					// Ignore malformed browser-only recovery state.
				}
				const source = restored ?? { version: 1 as const, pdfSha256: value.pdfSha256, ...fromServer };
				const restoredByCandidate = new Map(source.candidateReviews.map((review) => [review.candidateId, review]));
				const mergedReviews = Object.fromEntries(
					fromServer.candidateReviews.map((review) => [
						review.candidateId,
						restoredByCandidate.get(review.candidateId) ?? review,
					]),
				);
				const validPages = source.reviewedPages.filter((page) => page >= 1 && page <= value.pageCount);
				setDetail(value);
				setReviewer(source.reviewer);
				setNotes(source.notes);
				setReviewedPages(new Set(validPages));
				setCandidateReviews(mergedReviews);
				setManualArtifacts(source.manualArtifacts);
				setCurrentPage(
					Array.from({ length: value.pageCount }, (_item, index) => index + 1).find(
						(page) => !validPages.includes(page),
					) ?? 1,
				);
				setDraftReady(true);
				setDirty(Boolean(restored));
				if (restored) setMessage("已恢复该 PDF 的本机浏览器草稿；它还不是 gold annotation。");
			})
			.catch((reason) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedSlug]);

	useEffect(() => {
		if (!detail || !draftReady || !dirty) return;
		const draft: LocalReviewDraft = {
			version: 1,
			pdfSha256: detail.pdfSha256,
			reviewer,
			notes,
			reviewedPages: [...reviewedPages].sort((left, right) => left - right),
			candidateReviews: detail.candidates.map((candidate) => candidateReviews[candidate.id]).filter(Boolean),
			manualArtifacts,
		};
		try {
			localStorage.setItem(draftStorageKey(detail.source.slug, detail.pdfSha256), JSON.stringify(draft));
		} catch {
			// The final write still works when browser storage is unavailable.
		}
	}, [candidateReviews, detail, dirty, draftReady, manualArtifacts, notes, reviewedPages, reviewer]);

	const touch = () => setDirty(true);
	const updateCandidate = (candidateId: string, recipe: (draft: CandidateDraft) => CandidateDraft) => {
		touch();
		setCandidateReviews((current) => ({ ...current, [candidateId]: recipe(current[candidateId]) }));
	};
	const updateManual = (key: string, recipe: (draft: ManualArtifactDraft) => ManualArtifactDraft) => {
		touch();
		setManualArtifacts((current) => current.map((artifact) => (artifact.key === key ? recipe(artifact) : artifact)));
	};
	const togglePage = (page: number, checked: boolean) => {
		touch();
		setReviewedPages((current) => {
			const next = new Set(current);
			if (checked) next.add(page);
			else next.delete(page);
			return next;
		});
	};

	const classifiedCount = detail
		? detail.candidates.filter((candidate) => candidateReviews[candidate.id]?.disposition !== "pending").length
		: 0;
	const ready = Boolean(
		detail &&
			reviewer.trim() &&
			reviewedPages.size === detail.pageCount &&
			detail.candidates.every((candidate) => {
				const review = candidateReviews[candidate.id];
				return (
					review &&
					(review.disposition === "expected"
						? Boolean(review.artifactId.trim())
						: review.disposition === "ignored" && Boolean(review.reason.trim()))
				);
			}) &&
			manualArtifacts.every((artifact) => artifact.id.trim() && splitLines(artifact.urls).length),
	);

	const buildSubmission = () => {
		if (!detail) throw new Error("Select an artifact evaluation paper first");
		return {
			reviewer: reviewer.trim(),
			reviewedAt: new Date().toISOString(),
			reviewedPages: [...reviewedPages].sort((left, right) => left - right),
			notes: notes.trim() || undefined,
			candidateReviews: detail.candidates.map((candidate) => {
				const review = candidateReviews[candidate.id];
				if (review?.disposition === "expected") {
					return {
						candidateId: candidate.id,
						disposition: "expected",
						artifactId: review.artifactId.trim(),
						kind: review.kind,
						acceptedUrls: splitLines(review.acceptedUrls),
						pages: parsePages(review.pages),
						note: review.note.trim() || undefined,
					};
				}
				return {
					candidateId: candidate.id,
					disposition: review?.disposition ?? "pending",
					reason: review?.reason.trim() || undefined,
				};
			}),
			manualArtifacts: manualArtifacts.map((artifact) => ({
				id: artifact.id.trim(),
				urls: splitLines(artifact.urls),
				kind: artifact.kind,
				pages: parsePages(artifact.pages),
				note: artifact.note.trim() || undefined,
			})),
		};
	};

	const prepareSave = async () => {
		setError("");
		setMessage("");
		if (!detail || !ready) {
			setError("请先逐页检查 PDF、填写真实 reviewer，并处理每一个候选。忽略项必须说明原因。");
			return;
		}
		setBusy(true);
		try {
			const submission = buildSubmission();
			setPendingSubmission(submission);
			setPending(
				await api<PreparedOperation>(
					`/api/evaluation/artifacts/${encodeURIComponent(detail.source.slug)}/prepare`,
					jsonBody({ submission }),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const executeSave = async () => {
		if (!detail || !pending || !pendingSubmission) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			await api(
				`/api/evaluation/artifacts/${encodeURIComponent(detail.source.slug)}/execute`,
				jsonBody({ submission: pendingSubmission, grant }),
			);
			try {
				localStorage.removeItem(draftStorageKey(detail.source.slug, detail.pdfSha256));
			} catch {
				// Browser recovery cleanup is best-effort.
			}
			setDirty(false);
			setPending(undefined);
			setPendingSubmission(undefined);
			setMessage("人工 gold annotation 已保存。它记录了 PDF hash、逐页检查、候选决策和 reviewer provenance。");
			await loadQueue();
			const refreshed = await api<ArtifactReviewDetail>(
				`/api/evaluation/artifacts/${encodeURIComponent(detail.source.slug)}`,
			);
			const normalized = serverDraft(refreshed);
			setDetail(refreshed);
			setReviewer(normalized.reviewer);
			setNotes(normalized.notes);
			setReviewedPages(new Set(normalized.reviewedPages));
			setCandidateReviews(
				Object.fromEntries(normalized.candidateReviews.map((review) => [review.candidateId, review])),
			);
			setManualArtifacts(normalized.manualArtifacts);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const queuePapers = queue?.papers ?? [];
	const firstUnchecked = detail
		? Array.from({ length: detail.pageCount }, (_item, index) => index + 1).find((page) => !reviewedPages.has(page))
		: undefined;
	const completion = detail
		? Math.round(
				((reviewedPages.size + classifiedCount) / Math.max(1, detail.pageCount + detail.candidates.length)) * 100,
			)
		: 0;

	return (
		<>
			<PageHeading />
			<div className="human-boundary artifact-review-boundary">
				<strong>真实性边界</strong>
				<p>
					候选快照只是 detector 输出，不能直接晋升为 gold。只有真实研究者逐页检查固定 PDF、独立处理所有候选并确认
					exact plan 后，服务才会写入 <code>eval-data/artifacts/annotations</code>。
				</p>
			</div>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => {
						setPending(undefined);
						setPendingSubmission(undefined);
					}}
					onConfirm={() => void executeSave()}
				/>
			)}
			<div className="metric-grid artifact-review-metrics">
				<div className="metric-card accent">
					<span>人工已复核</span>
					<strong>{queue?.totals.humanReviewed ?? "—"}</strong>
					<small>/ {queue?.totals.papers ?? 0} 篇固定 PDF</small>
				</div>
				<div className="metric-card">
					<span>待复核</span>
					<strong>{queue?.totals.pending ?? "—"}</strong>
					<small>不能由模型自动补齐</small>
				</div>
				<div className="metric-card">
					<span>Detector candidates</span>
					<strong>{queue?.totals.candidates ?? "—"}</strong>
					<small>每一项都必须明确归类</small>
				</div>
				<div className="metric-card">
					<span>当前进度</span>
					<strong>{detail ? `${completion}%` : "—"}</strong>
					<small>页检查 + 候选处理</small>
				</div>
			</div>
			{loading && !detail ? (
				<LoadingBlock text="正在读取 Artifact 评估队列…" />
			) : queuePapers.length === 0 ? (
				<EmptyState title="没有评估源" text="先准备 eval-data/artifacts/sources.json 与 candidate snapshots。" />
			) : (
				<div className="artifact-review-layout">
					<aside className="artifact-review-queue panel">
						<div className="panel-heading">
							<div>
								<span className="eyebrow">Review queue</span>
								<h2>固定论文集</h2>
							</div>
							<small>{queuePapers.length} 篇</small>
						</div>
						<div className="artifact-review-paper-list">
							{queuePapers.map((paper) => (
								<button
									className={selectedSlug === paper.slug ? "active" : ""}
									type="button"
									key={paper.slug}
									onClick={() => setSelectedSlug(paper.slug)}
								>
									<StatusPill
										status={paper.humanReviewed ? "succeeded" : paper.issues.length ? "failed" : "queued"}
									/>
									<div>
										<strong>{paper.title}</strong>
										<small>
											{paper.candidateCount} candidates · {paper.expectedArtifactCount} gold
										</small>
										{paper.reviewer && <small>{paper.reviewer}</small>}
									</div>
								</button>
							))}
						</div>
					</aside>
					{detail ? (
						<>
							<section className="artifact-review-document">
								<div className="panel artifact-review-document-heading">
									<div>
										<span className="eyebrow">Pinned primary source</span>
										<h2>{detail.source.title}</h2>
										<p>
											{detail.source.paperId} · {Math.round(detail.pdfBytes / 1024)} KB · SHA-256{" "}
											<code>{detail.pdfSha256.slice(0, 16)}…</code>
										</p>
									</div>
									{firstUnchecked && (
										<button
											className="button secondary"
											type="button"
											onClick={() => setCurrentPage(firstUnchecked)}
										>
											下一未检查页
										</button>
									)}
								</div>
								<PdfViewer
									url={`/api/evaluation/artifacts/${encodeURIComponent(detail.source.slug)}/pdf`}
									selectedPage={currentPage}
									onPageChange={setCurrentPage}
								/>
								<div className="panel page-review-checklist">
									<div className="panel-heading">
										<div>
											<span className="eyebrow">Physical pages</span>
											<h2>逐页检查清单</h2>
										</div>
										<small>
											{reviewedPages.size} / {detail.pageCount}
										</small>
									</div>
									<p className="muted">只在你真正看完该物理页、检查正文与注释链接后勾选。</p>
									<div className="page-check-grid">
										{Array.from({ length: detail.pageCount }, (_item, index) => index + 1).map((page) => (
											<div className={currentPage === page ? "current" : ""} key={page}>
												<button type="button" onClick={() => setCurrentPage(page)}>
													P{page}
												</button>
												<input
													aria-label={`确认已人工检查第 ${page} 页`}
													type="checkbox"
													checked={reviewedPages.has(page)}
													onChange={(event) => togglePage(page, event.target.checked)}
												/>
											</div>
										))}
									</div>
								</div>
							</section>
							<aside className="artifact-review-editor panel">
								<div className="panel-heading">
									<div>
										<span className="eyebrow">Independent decisions</span>
										<h2>候选与遗漏项</h2>
									</div>
									<small>
										{classifiedCount} / {detail.candidates.length}
									</small>
								</div>
								<label className="artifact-review-field">
									<span>真实 reviewer 身份</span>
									<input
										value={reviewer}
										onChange={(event) => {
											touch();
											setReviewer(event.target.value);
										}}
										placeholder="姓名、GitHub ID 或实验室账号"
									/>
								</label>
								<label className="artifact-review-field">
									<span>整体复核备注</span>
									<textarea
										rows={3}
										value={notes}
										onChange={(event) => {
											touch();
											setNotes(event.target.value);
										}}
										placeholder="记录不确定性、版本差异或检查方法"
									/>
								</label>
								<div className="artifact-candidate-review-list">
									{detail.candidates.length ? (
										detail.candidates.map((candidate, index) => {
											const review = candidateReviews[candidate.id];
											const pages = candidatePages(candidate);
											const context = candidate.sources.find((source) => source.context?.trim())?.context;
											return (
												<article key={candidate.id}>
													<div className="artifact-candidate-heading">
														<div>
															<StatusPill status={candidate.confidence} />
															<strong>
																#{index + 1} {candidate.kind}
															</strong>
														</div>
														{pages[0] && (
															<button type="button" onClick={() => setCurrentPage(pages[0])}>
																跳到 P{pages[0]}
															</button>
														)}
													</div>
													<code>{candidate.url}</code>
													{context && <blockquote>{context}</blockquote>}
													<label>
														<span>人工判断</span>
														<select
															value={review?.disposition ?? "pending"}
															onChange={(event) => {
																const disposition = event.target.value as CandidateDraft["disposition"];
																updateCandidate(candidate.id, (current) => ({
																	...current,
																	disposition,
																	artifactId: current.artifactId || candidate.id,
																	kind: current.kind || candidate.kind,
																	acceptedUrls: current.acceptedUrls || candidate.url,
																	pages: current.pages || pages.join(", "),
																}));
															}}
														>
															<option value="pending">尚未判断</option>
															<option value="expected">属于本文 Artifact</option>
															<option value="ignored">引用/无关链接</option>
														</select>
													</label>
													{review?.disposition === "expected" && (
														<div className="artifact-decision-fields">
															<label>
																<span>Gold artifact ID（同一 artifact 可共用 ID）</span>
																<input
																	value={review.artifactId}
																	onChange={(event) =>
																		updateCandidate(candidate.id, (current) => ({
																			...current,
																			artifactId: event.target.value,
																		}))
																	}
																/>
															</label>
															<div className="artifact-inline-fields">
																<label>
																	<span>类型</span>
																	<select
																		value={review.kind}
																		onChange={(event) =>
																			updateCandidate(candidate.id, (current) => ({
																				...current,
																				kind: event.target.value as ArtifactKind,
																			}))
																		}
																	>
																		{artifactKinds.map((kind) => (
																			<option value={kind} key={kind}>
																				{kind}
																			</option>
																		))}
																	</select>
																</label>
																<label>
																	<span>物理页（逗号分隔）</span>
																	<input
																		value={review.pages}
																		onChange={(event) =>
																			updateCandidate(candidate.id, (current) => ({
																				...current,
																				pages: event.target.value,
																			}))
																		}
																	/>
																</label>
															</div>
															<label>
																<span>接受的 URL / 别名（每行一个）</span>
																<textarea
																	rows={2}
																	value={review.acceptedUrls}
																	onChange={(event) =>
																		updateCandidate(candidate.id, (current) => ({
																			...current,
																			acceptedUrls: event.target.value,
																		}))
																	}
																/>
															</label>
															<label>
																<span>备注</span>
																<textarea
																	rows={2}
																	value={review.note}
																	onChange={(event) =>
																		updateCandidate(candidate.id, (current) => ({
																			...current,
																			note: event.target.value,
																		}))
																	}
																/>
															</label>
														</div>
													)}
													{review?.disposition === "ignored" && (
														<label>
															<span>忽略原因（必填）</span>
															<textarea
																rows={2}
																value={review.reason}
																onChange={(event) =>
																	updateCandidate(candidate.id, (current) => ({
																		...current,
																		reason: event.target.value,
																	}))
																}
															/>
														</label>
													)}
												</article>
											);
										})
									) : (
										<p className="muted">Detector 没有发现候选；仍需逐页检查并在下方补录遗漏项。</p>
									)}
								</div>
								<div className="manual-artifact-section">
									<div className="panel-heading">
										<div>
											<span className="eyebrow">Detector misses</span>
											<h2>手工补录 Artifact</h2>
										</div>
										<button
											className="button secondary"
											type="button"
											onClick={() => {
												touch();
												setManualArtifacts((current) => [
													...current,
													{ key: newManualKey(), id: "", urls: "", kind: "unknown", pages: "", note: "" },
												]);
											}}
										>
											添加遗漏项
										</button>
									</div>
									{manualArtifacts.map((artifact) => (
										<article className="manual-artifact-card" key={artifact.key}>
											<div className="artifact-inline-fields">
												<label>
													<span>Artifact ID</span>
													<input
														value={artifact.id}
														onChange={(event) =>
															updateManual(artifact.key, (current) => ({
																...current,
																id: event.target.value,
															}))
														}
													/>
												</label>
												<label>
													<span>类型</span>
													<select
														value={artifact.kind}
														onChange={(event) =>
															updateManual(artifact.key, (current) => ({
																...current,
																kind: event.target.value as ArtifactKind,
															}))
														}
													>
														{artifactKinds.map((kind) => (
															<option value={kind} key={kind}>
																{kind}
															</option>
														))}
													</select>
												</label>
											</div>
											<label>
												<span>URL / 别名（每行一个）</span>
												<textarea
													rows={2}
													value={artifact.urls}
													onChange={(event) =>
														updateManual(artifact.key, (current) => ({
															...current,
															urls: event.target.value,
														}))
													}
												/>
											</label>
											<div className="artifact-inline-fields">
												<label>
													<span>物理页（逗号分隔）</span>
													<input
														value={artifact.pages}
														onChange={(event) =>
															updateManual(artifact.key, (current) => ({
																...current,
																pages: event.target.value,
															}))
														}
													/>
												</label>
												<label>
													<span>备注</span>
													<input
														value={artifact.note}
														onChange={(event) =>
															updateManual(artifact.key, (current) => ({
																...current,
																note: event.target.value,
															}))
														}
													/>
												</label>
											</div>
											<button
												className="text-button danger-text"
												type="button"
												onClick={() => {
													touch();
													setManualArtifacts((current) =>
														current.filter((item) => item.key !== artifact.key),
													);
												}}
											>
												删除此项
											</button>
										</article>
									))}
								</div>
								<div className="artifact-review-save">
									<div>
										<strong>{ready ? "可以准备保存" : "尚未满足保存关卡"}</strong>
										<small>
											逐页 {reviewedPages.size}/{detail.pageCount} · 候选 {classifiedCount}/
											{detail.candidates.length}
										</small>
										{dirty && <small>草稿已自动保存在当前浏览器本机。</small>}
									</div>
									<button
										className="button primary"
										type="button"
										disabled={!ready || busy}
										onClick={() => void prepareSave()}
									>
										检查 exact plan 并保存
									</button>
								</div>
							</aside>
						</>
					) : (
						<LoadingBlock text="正在验证固定 PDF、SHA-256 和 candidate snapshot…" />
					)}
				</div>
			)}
		</>
	);
}
