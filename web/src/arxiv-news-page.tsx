import type { ArxivNewsPaper } from "../../src/literature/domain/arxiv-news.ts";
import { BookOpen, Folder, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation, JobProgress, useJob } from "./components";
import type { BackgroundJob, ConfirmationGrant, PreparedOperation } from "./types";

interface NewsBatch {
	id: string;
	name: string;
	startDate: string;
	endDate: string;
	categories: string[];
	fetchedAt: string;
	count: number;
}
interface NewsState {
	categories: string[];
	filterGroups: unknown[];
	nextStartDate?: string;
	lastEndDate?: string;
	lastSuccessAt?: string;
	batches: NewsBatch[];
}
interface NewsBatchDetail {
	batch: NewsBatch;
	papers: ArxivNewsPaper[];
	screening: {
		matchedIds: string[];
		unresolvedIds: string[];
		labelsByPaper: Record<string, string[]>;
		filteredCount: number;
	};
}

const SUBJECTS: Array<[string, string]> = [
	["cs.AI", "人工智能"],
	["cs.LG", "机器学习"],
	["cs.CL", "自然语言处理"],
	["cs.CV", "计算机视觉"],
	["cs.SE", "软件工程"],
	["cs.CR", "安全"],
	["cs.RO", "机器人"],
	["cs.IR", "信息检索"],
	["cs.PL", "编程语言"],
	["cs.DC", "分布式计算"],
	["cs.NI", "网络"],
	["cs.MA", "多智能体系统"],
	["stat.ML", "统计机器学习"],
	["eess.IV", "图像与视频"],
];

const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateTime = (value?: string) => (value ? new Date(value).toLocaleString("zh-CN") : "尚未拉取");
const sortedCategories = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort();
const parseFilterGroups = (text: string): unknown => {
	const parsed: unknown = JSON.parse(text);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) && "groups" in parsed ? parsed.groups : parsed;
};

export default function ArxivNewsPage({ onTask }: { onTask: (job: BackgroundJob) => void }) {

	const [state, setState] = useState<NewsState>();
	const [categories, setCategories] = useState<string[]>([]);
	const [filterText, setFilterText] = useState("");
	const [view, setView] = useState<"matched" | "unresolved" | "all">("matched");
	const [customCategory, setCustomCategory] = useState("");
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState(todayUtc);
	const [selectedBatchId, setSelectedBatchId] = useState<string>();
	const [detail, setDetail] = useState<NewsBatchDetail>();
	const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set());
	const [jobId, setJobId] = useState<string>();
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingPaperIds, setPendingPaperIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const job = useJob(jobId);
	const categoriesDirty = useMemo(
		() => sortedCategories(categories).join(",") !== sortedCategories(state?.categories ?? []).join(","),
		[categories, state?.categories],
	);
	const filterDirty = filterText.trim() !== JSON.stringify(state?.filterGroups ?? [], null, 2);
	const matchedIds = useMemo(() => new Set(detail?.screening.matchedIds ?? []), [detail]);
	const unresolvedIds = useMemo(() => new Set(detail?.screening.unresolvedIds ?? []), [detail]);
	const retainedIds = useMemo(() => new Set([...matchedIds, ...unresolvedIds]), [matchedIds, unresolvedIds]);
	const visiblePapers = useMemo(
		() =>
			detail?.papers.filter(
				(paper) => view === "all" || (view === "matched" ? matchedIds.has(paper.id) : unresolvedIds.has(paper.id)),
			) ?? [],
		[detail, view, matchedIds, unresolvedIds],
	);

	useEffect(() => {
		let active = true;
		setState(undefined);
		setDetail(undefined);
		setSelectedBatchId(undefined);
		setJobId(undefined);
		setPending(undefined);
		setPendingPaperIds([]);
		setSelectedPapers(new Set());
		setError("");
		void api<NewsState>("/api/arxiv-news")
			.then((next) => {
				if (!active) return;
				setState(next);
				setCategories(next.categories);
				setFilterText(JSON.stringify(next.filterGroups, null, 2));
				setStartDate(next.nextStartDate ?? next.lastEndDate ?? "");
				setSelectedBatchId(next.batches[0]?.id);
			})
			.catch((reason) => {
				if (active) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (!selectedBatchId) {
			setDetail(undefined);
			return;
		}
		let active = true;
		setDetail(undefined);
		setSelectedPapers(new Set());
		setPending(undefined);
		setPendingPaperIds([]);
		void api<NewsBatchDetail>(`/api/arxiv-news/batches/${encodeURIComponent(selectedBatchId)}`)
			.then((next) => {
				if (active) setDetail(next);
			})
			.catch((reason) => {
				if (active) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			active = false;
		};
	}, [selectedBatchId]);

	useEffect(() => {
		if (!job || !["succeeded", "failed", "cancelled"].includes(job.status) || job.type !== "arxiv-news-pull") return;
		let active = true;
		void api<NewsState>("/api/arxiv-news")
			.then((next) => {
				if (!active) return;
				setState(next);
				setStartDate(next.nextStartDate ?? next.lastEndDate ?? "");
				const result = job.result as { batches?: NewsBatch[]; count: number } | undefined;
				const selected = result?.batches?.at(-1) ?? next.batches[0];
				if (selected) {
					setSelectedBatchId(selected.id);
					void api<NewsBatchDetail>(`/api/arxiv-news/batches/${encodeURIComponent(selected.id)}`)
						.then((fresh) => {
							if (active) setDetail(fresh);
						})
						.catch((reason) => {
							if (active) setError(reason instanceof Error ? reason.message : String(reason));
						});
				} else {
					setSelectedBatchId(undefined);
					if (job.status === "succeeded") setNotice("拉取完成；每日表格已保存。");
				}
			})
			.catch((reason) => {
				if (active) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			active = false;
		};
	}, [job]);

	function toggleCategory(code: string) {
		setCategories((current) =>
			current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
		);
		setStartDate("");
	}

	async function saveSettings() {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const filterGroups = parseFilterGroups(filterText);
			const next = await api<NewsState>(
				"/api/arxiv-news/settings",
				jsonBody(
					{
						categories: sortedCategories(categories),
						filterGroups,
						...(startDate ? { nextStartDate: startDate } : {}),
					},
					"PUT",
				),
			);
			setState(next);
			setFilterText(JSON.stringify(next.filterGroups, null, 2));
			setDetail(undefined);
			if (selectedBatchId)
				setDetail(await api<NewsBatchDetail>(`/api/arxiv-news/batches/${encodeURIComponent(selectedBatchId)}`));
			setSelectedPapers(new Set());
			setNotice("已保存关注学科、筛选规则和下次拉取起点。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function pull() {
		if (!categories.length || !startDate || !endDate) {
			setError("请选择学科及完整的起止日期。");
			return;
		}
		if (startDate >= endDate) {
			setError("结束日需晚于起始日；结束日当天不拉取。");
			return;
		}
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const normalized = sortedCategories(categories);
			if (categoriesDirty || filterDirty || startDate !== (state?.nextStartDate ?? state?.lastEndDate ?? "")) {
				const filterGroups = parseFilterGroups(filterText);
				const next = await api<NewsState>(
					"/api/arxiv-news/settings",
					jsonBody({ categories: normalized, nextStartDate: startDate, filterGroups }, "PUT"),
				);
				setState(next);
				setFilterText(JSON.stringify(next.filterGroups, null, 2));
			}
			const created = await api<BackgroundJob>(
				"/api/arxiv-news/pulls",
				jsonBody({
					categories: normalized,
					startDate,
					endDate,
				}),
			);
			setJobId(created.id);
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function removeBatch(batch: NewsBatch) {
		if (!window.confirm(`删除资讯文件夹“${batch.name}”？这不会删除个人文献库中的论文。`)) return;
		setBusy(true);
		setError("");
		try {
			await api(`/api/arxiv-news/batches/${encodeURIComponent(batch.id)}`, { method: "DELETE" });
			const next = await api<NewsState>("/api/arxiv-news");
			setState(next);
			if (selectedBatchId === batch.id) setSelectedBatchId(next.batches[0]?.id);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function prepareImport(paperIds: string[]) {
		if (!detail || !paperIds.length) return;
		if (paperIds.some((id) => !retainedIds.has(id))) {
			setError("仅当前筛选保留的论文可以加入个人库。");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const operation = await api<PreparedOperation>(
				"/api/library/import/prepare",
				jsonBody({
					newsBatchId: detail.batch.id,
					paperIds,
				}),
			);
			setPendingPaperIds(paperIds);
			setPending(operation);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function confirmImport() {
		if (!pending || !detail) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/library/import/execute",
				jsonBody({
					newsBatchId: detail.batch.id,
					paperIds: pendingPaperIds,

					grant,
				}),
			);
			onTask(created);
			setPending(undefined);
			setSelectedPapers(new Set());
			setNotice("已提交到个人文献库入库任务。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<h1 className="sr-only">最新资讯</h1>
			<div className="news-controls">
				<div className="news-controls-top">
					<span>上次成功拉取：{dateTime(state?.lastSuccessAt)}</span>
					{state?.nextStartDate && <span>下次拉取起点：{state.nextStartDate} UTC</span>}
				</div>
				<fieldset className="news-subjects">
					<legend>关注学科</legend>
					<div className="news-subject-grid">
						{SUBJECTS.map(([code, label]) => (
							<label key={code}>
								<input
									type="checkbox"
									checked={categories.includes(code)}
									onChange={() => toggleCategory(code)}
								/>
								<span>{label}</span>
								<code>{code}</code>
							</label>
						))}
					</div>
					<div className="news-custom-subject">
						<input
							value={customCategory}
							onChange={(event) => setCustomCategory(event.target.value)}
							placeholder="其他 arXiv 学科代码，如 math.OC"
						/>
						<button
							className="button secondary"
							type="button"
							onClick={() => {
								if (customCategory.trim()) {
									setCategories((current) => [...current, customCategory.trim()]);
									setCustomCategory("");
									setStartDate("");
								}
							}}
						>
							<Plus size={15} /> 添加
						</button>
					</div>
					{categories
						.filter((code) => !SUBJECTS.some(([preset]) => preset === code))
						.map((code) => (
							<button
								key={code}
								className="news-custom-chip"
								type="button"
								onClick={() => toggleCategory(code)}
								title="移除学科"
							>
								{code} ×
							</button>
						))}
				</fieldset>
				<details className="news-filter-settings">
					<summary>
						筛选设置 · {state?.filterGroups.length ?? 0} 组规则{filterDirty ? "（未保存）" : ""}
					</summary>
					<p>
						支持粘贴 <code>filter_search_run_results</code> 的完整参数对象或 <code>groups</code> 数组；组内关键词
						OR，组间 AND，多组规则取并集。有摘要按标题和摘要筛选；无摘要仅按标题筛选，命中后标记为待核验。
					</p>
					<p>粘贴完整参数时只保存 groups；search_run_id 不用于资讯筛选。</p>
					<textarea
						aria-label="资讯筛选规则 JSON"
						spellCheck={false}
						value={filterText}
						onChange={(event) => setFilterText(event.target.value)}
						rows={15}
					/>
					<p>修改后点击“保存设置与下次起点”。年份和排除词均可调整；原始每日表不会被删除。</p>
				</details>
				<div className="news-pull-row">
					<label>
						起始日（UTC）
						<input
							type="date"
							value={startDate}
							max={todayUtc()}
							onChange={(event) => setStartDate(event.target.value)}
						/>
					</label>
					<label>
						结束日（UTC，不包含）
						<input
							type="date"
							value={endDate}
							max={todayUtc()}
							onChange={(event) => setEndDate(event.target.value)}
						/>
					</label>
					<button className="button secondary" type="button" disabled={busy} onClick={() => void saveSettings()}>
						保存设置与下次起点
					</button>
					<button
						className="button primary"
						type="button"
						disabled={busy || job?.status === "queued" || job?.status === "running"}
						onClick={() => void pull()}
					>
						<RefreshCw size={15} /> 拉取更新
					</button>
				</div>
				<p className="news-date-note">
					起始日包含、结束日不包含；每天合并所选学科查询并生成一张表，重复拉取同一天会合并论文。首次提交日可能早于论文在
					arXiv 每日公告中出现的日期。
				</p>
				<JobProgress job={job} />
				{error && <p className="error-text">{error}</p>}
				{notice && <p className="news-notice">{notice}</p>}
			</div>
			<div className={`news-layout${!state?.batches.length ? " news-layout-empty" : ""}`}>
				<aside className="news-folders">
					<h2>
						<Folder size={18} /> 拉取文件夹
					</h2>
					{!state?.batches.length && <p className="news-muted">还没有文件夹。选择学科和日期后点击“拉取更新”。</p>}
					{state?.batches.map((batch) => (
						<div key={batch.id} className={`news-folder${batch.id === selectedBatchId ? " active" : ""}`}>
							<button type="button" className="news-folder-main" onClick={() => setSelectedBatchId(batch.id)}>
								<FolderOpen size={18} />
								<span>
									<strong>{batch.name}</strong>
									<small>
										{batch.categories.join(" · ")} · 原始 {batch.count} 篇
									</small>
									<small>拉取于 {dateTime(batch.fetchedAt)}</small>
								</span>
							</button>
							<button
								type="button"
								className="news-folder-delete"
								title="删除文件夹"
								aria-label={`删除 ${batch.name}`}
								disabled={busy}
								onClick={() => void removeBatch(batch)}
							>
								<Trash2 size={15} />
							</button>
						</div>
					))}
				</aside>
				<main className="news-papers">
					{detail ? (
						<>
							<div className="news-paper-head">
								<div>
									<span className="eyebrow">PULL FOLDER · 资讯文件夹</span>
									<h2>{detail.batch.name}</h2>
									<p>
										{detail.batch.categories.join(" · ")} · 原始 {detail.papers.length} 篇 · 命中{" "}
										{detail.screening.matchedIds.length} 篇 · 待核验 {detail.screening.unresolvedIds.length}{" "}
										篇
									</p>
								</div>
								<button
									className="button secondary"
									type="button"
									disabled={!selectedPapers.size || busy}
									onClick={() => void prepareImport([...selectedPapers])}
								>
									加入个人文献库（{selectedPapers.size}）
								</button>
							</div>
							<fieldset className="news-screen-tabs">
								<legend className="sr-only">论文筛选状态</legend>
								<button
									type="button"
									className={view === "matched" ? "active" : ""}
									onClick={() => setView("matched")}
								>
									筛选命中（{detail.screening.matchedIds.length}）
								</button>
								<button
									type="button"
									className={view === "unresolved" ? "active" : ""}
									onClick={() => setView("unresolved")}
								>
									无摘要待核验（{detail.screening.unresolvedIds.length}）
								</button>
								<button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
									全部原始论文（{detail.papers.length}）
								</button>
							</fieldset>
							<div className="news-table-scroll">
								<table className="news-results-table">
									<thead>
										<tr>
											<th scope="col">选择</th>
											<th scope="col">论文</th>
											<th scope="col">作者</th>
											<th scope="col">首次提交（UTC）</th>
											<th scope="col">摘要</th>
											<th scope="col">操作</th>
										</tr>
									</thead>
									<tbody>
										{visiblePapers.map((paper) => (
											<tr key={paper.id}>
												<td>
													<input
														type="checkbox"
														aria-label={`选择 ${paper.title}`}
														checked={selectedPapers.has(paper.id)}
														disabled={!retainedIds.has(paper.id)}
														onChange={(event) =>
															setSelectedPapers((current) => {
																const next = new Set(current);
																if (event.target.checked) next.add(paper.id);
																else next.delete(paper.id);
																return next;
															})
														}
													/>
												</td>
												<td className="news-table-title">
													<a
														href={`https://arxiv.org/abs/${encodeURIComponent(paper.identifiers.arxivId ?? "")}`}
														target="_blank"
														rel="noopener noreferrer"
													>
														{paper.title} <BookOpen size={14} aria-hidden="true" />
													</a>
													<small>arXiv:{paper.identifiers.arxivId}</small>
													{detail.screening.labelsByPaper[paper.id]?.length ? (
														<small>
															{detail.screening.labelsByPaper[paper.id].join(" · ")}
															{unresolvedIds.has(paper.id) ? " · 待核验" : ""}
														</small>
													) : null}
												</td>
												<td className="news-table-authors">{paper.authors.join("、") || "—"}</td>
												<td className="news-table-date">{paper.firstSubmittedAt?.slice(0, 10) ?? "—"}</td>
												<td className="news-table-abstract">
													{paper.abstract ? (
														<details>
															<summary>
																{paper.abstract.slice(0, 160)}
																{paper.abstract.length > 160 ? "…" : ""}
															</summary>
															<p>{paper.abstract}</p>
														</details>
													) : (
														"暂无摘要"
													)}
												</td>
												<td>
													<button
														type="button"
														className="news-table-import"
														disabled={busy || !retainedIds.has(paper.id)}
														onClick={() => void prepareImport([paper.id])}
													>
														{matchedIds.has(paper.id)
															? "加入个人库"
															: unresolvedIds.has(paper.id)
																? "待核验入库"
																: "未通过筛选"}
													</button>
												</td>
											</tr>
										))}
										{visiblePapers.length === 0 && (
											<tr>
												<td colSpan={6} className="news-screen-empty">
													{view === "matched"
														? "当前规则没有命中论文；可检查筛选设置或查看全部原始论文。"
														: view === "unresolved"
															? "没有无摘要且标题通过筛选的论文。"
															: "这一天没有拉取到论文。"}
												</td>
											</tr>
										)}
									</tbody>
								</table>
							</div>
						</>
					) : (
						<div className="news-empty">
							<FolderOpen size={30} />
							<p>选择左侧日期文件夹查看论文。</p>
						</div>
					)}
				</main>
			</div>
			{pending && (
				<AccessibleModal
					title="确认加入个人文献库"
					maxWidth={640}
					onClose={() => {
						if (!busy) setPending(undefined);
					}}
				>
					<ConsentCard
						operation={pending}
						busy={busy}
						onConfirm={confirmImport}
						onCancel={() => setPending(undefined)}
					/>
				</AccessibleModal>
			)}
		</>
	);
}
