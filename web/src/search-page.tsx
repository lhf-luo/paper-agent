import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import {
	ConsentCard,
	confirmOperation,
	EmptyState,
	JobProgress,
	PageHeading,
	PaperCard,
	PaperDetailDrawer,
	SearchResultTable,
	StatusPill,
	timeLabel,
	useJob,
} from "./components";
import type {
	AgentSearchRun,
	AgentSearchRunSummary,
	BackgroundJob,
	ConfirmationGrant,
	PaperAgentConfigView,
	PaperRecord,
	PreparedOperation,
} from "./types";

export interface SearchPageProps {
	onTask: (job: BackgroundJob) => void;
}

export function SearchPage({ onTask }: SearchPageProps) {
	const [query, setQuery] = useState("");
	const [providers, setProviders] = useState<string[]>([]);
	const [yearFrom, setYearFrom] = useState("");
	const [yearTo, setYearTo] = useState("");
	const [maxResults, setMaxResults] = useState("20");
	const [pagesPerProvider, setPagesPerProvider] = useState("1");
	const [queryExpansions, setQueryExpansions] = useState("");
	const [authors, setAuthors] = useState("");
	const [venues, setVenues] = useState("");
	const [publicationTypes, setPublicationTypes] = useState("");
	const [openAccess, setOpenAccess] = useState("any");
	const [reuseCorpus, setReuseCorpus] = useState(true);
	const [namespace, setNamespace] = useState("default");
	const [namespaces, setNamespaces] = useState<string[]>(["default"]);
	const [searchJobId, setSearchJobId] = useState<string>();
	const [agentRuns, setAgentRuns] = useState<AgentSearchRunSummary[]>([]);
	const [selectedRun, setSelectedRun] = useState<AgentSearchRun>();
	const [selectedRunId, setSelectedRunId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detailPaper, setDetailPaper] = useState<PaperRecord | undefined>();
	const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
	const [pending, setPending] = useState<PreparedOperation>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const runRequestSequence = useRef(0);
	const [providerCatalog, setProviderCatalog] = useState<
		Array<{
			id: string;
			label: string;
			description: string;
			capabilities: string[];
			searchConstraints?: {
				exactYear?: boolean;
				singleVenue?: boolean;
				supportedVenues?: string[];
			};
			requiresEnvironmentVariable?: string;
			credentialsAvailable: boolean;
		}>
	>([]);
	const job = useJob(searchJobId);
	const jobRun = job?.status === "succeeded" ? (job.result?.run as AgentSearchRun | undefined) : undefined;
	const run = selectedRun ?? jobRun;
	const results: PaperRecord[] = run?.results ?? [];
	const providerHealth: Record<
		string,
		{ status: string; recordCount: number; failureCount: number; message?: string }
	> = run?.providerHealth ?? {};

	const loadAgentRun = async (id: string) => {
		if (!id) {
			setSelectedRun(undefined);
			return;
		}
		const requestSequence = ++runRequestSequence.current;
		setBusy(true);
		setError("");
		try {
			const response = await api<{ run: AgentSearchRun }>(
				`/api/search/runs/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`,
			);
			if (requestSequence === runRequestSequence.current) setSelectedRun(response.run);
		} catch (reason) {
			if (requestSequence === runRequestSequence.current) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		} finally {
			if (requestSequence === runRequestSequence.current) setBusy(false);
		}
	};

	useEffect(() => {
		void Promise.all([
			api<{ providers: typeof providerCatalog }>("/api/providers"),
			api<PaperAgentConfigView>("/api/config"),
			api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces"),
		])
			.then(([catalogResponse, config, namespaceResponse]) => {
				setProviderCatalog(catalogResponse.providers);
				const available = new Set(
					catalogResponse.providers
						.filter(
							(provider) => provider.credentialsAvailable && provider.capabilities.includes("keyword-search"),
						)
						.map((provider) => provider.id),
				);
				setProviders(config.search.providers.filter((provider) => available.has(provider)));
				setMaxResults(String(config.search.maxResultsPerProvider));
				setPagesPerProvider(String(config.search.pagesPerProvider));
				setQueryExpansions(config.search.queryExpansions.join("\n"));
				setReuseCorpus(config.search.reuseCorpus);
				setNamespace(namespaceResponse.defaultNamespace);
				setNamespaces(namespaceResponse.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		runRequestSequence.current += 1;
		setAgentRuns([]);
		setSelectedRun(undefined);
		setSelectedRunId("");
		setSelected(new Set());
		setDetailPaper(undefined);
		setPending(undefined);
		setSearchJobId(undefined);
		setBusy(false);
		setError("");
		void api<{ runs: AgentSearchRunSummary[] }>(`/api/search/runs?namespace=${encodeURIComponent(namespace)}`, {
			signal: controller.signal,
		})
			.then((response) => {
				if (!controller.signal.aborted) setAgentRuns(response.runs);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [namespace]);

	const listValues = (value: string) =>
		value
			.split(/\r?\n|,/)
			.map((item) => item.trim())
			.filter(Boolean);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError("");
		try {
			if (!providers.length) throw new Error("请至少选择一个当前可用的文献源");
			const selectedVenues = listValues(venues);
			for (const providerId of providers) {
				const constraints = providerCatalog.find((provider) => provider.id === providerId)?.searchConstraints;
				if (constraints?.exactYear && (!yearFrom || yearFrom !== yearTo)) {
					throw new Error("ACL Anthology 需要填写相同的起始年份和结束年份");
				}
				if (constraints?.singleVenue && selectedVenues.length !== 1) {
					throw new Error("ACL Anthology 需要且只能填写一个会议，例如 ACL 或 EMNLP");
				}
				if (
					constraints?.supportedVenues?.length &&
					selectedVenues.length === 1 &&
					!constraints.supportedVenues.includes(selectedVenues[0].toLowerCase())
				) {
					throw new Error(`ACL Anthology 不支持会议：${selectedVenues[0]}`);
				}
			}
			const created = await api<BackgroundJob>(
				"/api/search",
				jsonBody({
					query,
					providers,
					queryExpansions: listValues(queryExpansions),
					filters: {
						yearFrom: yearFrom ? Number(yearFrom) : undefined,
						yearTo: yearTo ? Number(yearTo) : undefined,
						authors: listValues(authors),
						venues: selectedVenues,
						types: listValues(publicationTypes),
						openAccess: openAccess === "any" ? undefined : openAccess === "yes",
					},
					pagesPerProvider: Number(pagesPerProvider),
					maxResultsPerProvider: Number(maxResults),
					namespace,
					reuseCorpus,
				}),
			);
			setSearchJobId(created.id);
			setSelected(new Set());
			onTask(created);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const toggleProvider = (provider: string) =>
		setProviders((current) =>
			current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider],
		);

	const prepareSave = async () => {
		if (!job && !selectedRun) return;
		if (!selected.size) return;
		setBusy(true);
		setError("");
		try {
			setPending(
				await api(
					"/api/library/import/prepare",
					jsonBody({
						...(selectedRun ? { searchRunId: selectedRun.id } : { searchJobId: job?.id }),
						paperIds: [...selected],
						namespace,
					}),
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const confirmSave = async () => {
		if (!pending || (!job && !selectedRun)) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const created = await api<BackgroundJob>(
				"/api/library/import/execute",
				jsonBody({
					...(selectedRun ? { searchRunId: selectedRun.id } : { searchJobId: job?.id }),
					paperIds: [...selected],
					namespace,
					grant,
				}),
			);
			onTask(created);
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHeading
				eyebrow="LITERATURE DISCOVERY · 检索发现"
				title="搜索与收集论文"
				description="组合多个文献源，保存每次查询、过滤、失败和去重来源。"
			/>
			<section className="search-workbench">
				<form className="search-form" onSubmit={submit}>
					<label className="search-input">
						<span>研究问题或检索式</span>
						<div>
							<Search size={18} className="search-input-icon" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="例如：stateful protocol fuzzing with learned state models"
								required
							/>
							<button type="submit" disabled={busy}>
								开始检索
							</button>
						</div>
					</label>
					<div className="filter-row">
						<div>
							<span className="field-label">数据源</span>
							<div className="chip-row">
								{(providerCatalog.length
									? providerCatalog.filter((provider) => provider.capabilities.includes("keyword-search"))
									: ["arxiv", "openalex", "crossref", "semanticscholar"].map((id) => ({
											id,
											label: id,
											description: id,
											capabilities: ["keyword-search"],
											credentialsAvailable: true,
											requiresEnvironmentVariable: undefined,
										}))
								).map((provider) => (
									<button
										className={`${providers.includes(provider.id) ? "chip active" : "chip"}${provider.credentialsAvailable ? "" : " unavailable"}`}
										type="button"
										key={provider.id}
										disabled={!provider.credentialsAvailable}
										onClick={() => toggleProvider(provider.id)}
										title={`${provider.description}${provider.requiresEnvironmentVariable && !provider.credentialsAvailable ? `；未找到 ${provider.requiresEnvironmentVariable}` : ""}`}
									>
										{provider.label}
									</button>
								))}
							</div>
						</div>
						<label>
							<span className="field-label">个人库 namespace</span>
							<select value={namespace} onChange={(event) => setNamespace(event.target.value)}>
								{namespaces.map((item) => (
									<option value={item} key={item}>
										{item}
									</option>
								))}
							</select>
						</label>
						<label>
							<span className="field-label">起始年份</span>
							<input
								type="number"
								value={yearFrom}
								onChange={(event) => setYearFrom(event.target.value)}
								placeholder="2019"
							/>
						</label>
						<label>
							<span className="field-label">结束年份</span>
							<input
								type="number"
								value={yearTo}
								onChange={(event) => setYearTo(event.target.value)}
								placeholder="2026"
							/>
						</label>
						<label>
							<span className="field-label">每源上限</span>
							<input
								type="number"
								min="1"
								max="500"
								value={maxResults}
								onChange={(event) => setMaxResults(event.target.value)}
							/>
						</label>
						<label>
							<span className="field-label">每源页数</span>
							<input
								type="number"
								min="1"
								max="20"
								value={pagesPerProvider}
								onChange={(event) => setPagesPerProvider(event.target.value)}
							/>
						</label>
					</div>
					<details className="advanced-filters">
						<summary>高级检索选项</summary>
						<div className="filter-row">
							<label>
								<span className="field-label">查询扩展（逗号或换行分隔）</span>
								<textarea
									value={queryExpansions}
									onChange={(event) => setQueryExpansions(event.target.value)}
									placeholder="state model inference&#10;protocol state learning"
								/>
							</label>
							<label>
								<span className="field-label">作者</span>
								<input
									value={authors}
									onChange={(event) => setAuthors(event.target.value)}
									placeholder="Alice, Bob"
								/>
							</label>
							<label>
								<span className="field-label">会议 / 期刊</span>
								<input
									value={venues}
									onChange={(event) => setVenues(event.target.value)}
									placeholder="USENIX Security"
								/>
							</label>
							<label>
								<span className="field-label">论文类型</span>
								<input
									value={publicationTypes}
									onChange={(event) => setPublicationTypes(event.target.value)}
									placeholder="journal-article, proceedings-article"
								/>
							</label>
							<label>
								<span className="field-label">开放获取</span>
								<select value={openAccess} onChange={(event) => setOpenAccess(event.target.value)}>
									<option value="any">不限</option>
									<option value="yes">仅开放获取</option>
									<option value="no">仅非开放获取</option>
								</select>
							</label>
							<label className="checkbox-field">
								<input
									type="checkbox"
									checked={reuseCorpus}
									onChange={(event) => setReuseCorpus(event.target.checked)}
								/>
								<span>复用个人库已有记录，避免重复请求和重复分析</span>
							</label>
						</div>
					</details>
				</form>
			</section>
			{error && <div className="error-banner">{error}</div>}
			<JobProgress job={job} />
			{Object.keys(providerHealth).length > 0 && (
				<div className="provider-health">
					{Object.entries(providerHealth).map(([provider, health]) => (
						<div key={provider} title={health.message}>
							<StatusPill status={health.status} />
							<strong>{provider}</strong>
							<span>{health.recordCount} 条</span>
							{health.failureCount > 0 && <small>{health.failureCount} 个失败</small>}
						</div>
					))}
				</div>
			)}
			{pending && (
				<ConsentCard
					operation={pending}
					busy={busy}
					onCancel={() => setPending(undefined)}
					onConfirm={confirmSave}
				/>
			)}
			{agentRuns.length > 0 && (
				<div className="agent-run-picker">
					<label htmlFor="agent-run-select">
						<span>当前空间的搜索记录</span>
					</label>
					<div className="agent-run-row">
						<select
							id="agent-run-select"
							value={selectedRunId}
							onChange={(event) => setSelectedRunId(event.target.value)}
						>
							<option value="">-- 选择一次 Agent 搜索 --</option>
							{agentRuns.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{(entry.queries[0] ?? "").slice(0, 40)} · {entry.resultCount} 条 ·{" "}
									{timeLabel(entry.completedAt)}
								</option>
							))}
						</select>
						<button
							className="button secondary"
							type="button"
							disabled={busy || !selectedRunId}
							onClick={() => void loadAgentRun(selectedRunId)}
						>
							{selectedRunId === selectedRun?.id ? "展示中" : "展示结果"}
						</button>
					</div>
				</div>
			)}
			{!results.length && !busy && !job && (
				<EmptyState
					title="输入研究主题开启多源文献检索"
					text="支持并发检索 arXiv、OpenAlex、CrossRef 与 Semantic Scholar，自动完成数据清洗与可追溯去重。"
					tips={[
						"尝试精确研究课题：如 speculative decoding in large language models",
						"直接输入目标论文 DOI (例如 10.1145/...) 或 arXiv ID 即可一键精确定位",
						"在展开的筛选器中指定 CCF 等级、年份范围或开放获取状态"
					]}
				/>
			)}
			{results.length > 0 && (
				<section className="results-section" aria-label="检索结果" aria-busy={busy}>
					<div className="results-toolbar">
						<div>
							<strong>{results.length}</strong> 篇去重结果 · 已选择 {selected.size} 篇
						</div>
						<div className="button-row">
							<button
								className={`button ${viewMode === "table" ? "primary" : "secondary"}`}
								type="button"
								onClick={() => setViewMode("table")}
							>
								表格视图
							</button>
							<button
								className={`button ${viewMode === "cards" ? "primary" : "secondary"}`}
								type="button"
								onClick={() => setViewMode("cards")}
							>
								卡片视图
							</button>
							<button
								className="button secondary"
								type="button"
								onClick={() => setSelected(new Set(results.map((paper) => paper.id)))}
							>
								全选
							</button>
							<button
								className="button primary"
								type="button"
								disabled={!selected.size || busy}
								onClick={() => void prepareSave()}
							>
								保存到个人库
							</button>
						</div>
					</div>
					{viewMode === "table" ? (
						<SearchResultTable
							papers={results}
							selected={selected}
							onSelect={(id, checked) =>
								setSelected((current) => {
									const next = new Set(current);
									if (checked) next.add(id);
									else next.delete(id);
									return next;
								})
							}
							onOpenAbstract={(paper) => setDetailPaper(paper)}
						/>
					) : (
						<div className="paper-list">
							{results.map((paper) => (
								<PaperCard
									key={paper.id}
									paper={paper}
									selected={selected.has(paper.id)}
									truncateAbstract
									onSelect={(checked) =>
										setSelected((current) => {
											const next = new Set(current);
											if (checked) next.add(paper.id);
											else next.delete(paper.id);
											return next;
										})
									}
									onOpen={() => setDetailPaper(paper)}
								/>
							))}
						</div>
					)}
				</section>
			)}
			{detailPaper && <PaperDetailDrawer paper={detailPaper} onClose={() => setDetailPaper(undefined)} />}
		</>
	);
}

export default SearchPage;
