import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation, LoadingBlock, PageHeading, StatusPill } from "./components";
import { ModelProvidersPanel } from "./model-providers-panel";
import { SearchProviderProbePanel } from "./search-provider-probe-panel";
import type {
	ConfirmationGrant,
	PaperAgentConfigView,
	PdfTranslationEngineStatus,
	PreparedOperation,
	TeamAccessStatus,
} from "./types";

export function configuredPdfTranslationModels(config: PaperAgentConfigView) {
	const options = new Map<string, { key: string; label: string }>();
	for (const model of [config.model, ...(config.models ?? [])]) {
		if (!model || model.api !== "openai-completions") continue;
		const key = `${model.providerId}/${model.modelId}`;
		options.set(key, { key, label: `${model.name ?? model.modelId} (${model.providerId})` });
	}
	return [...options.values()];
}

export interface SettingsPageProps {
	onConfigurationSaved: () => Promise<void>;
}

export function SettingsPage({ onConfigurationSaved }: SettingsPageProps) {
	const [config, setConfig] = useState<PaperAgentConfigView>();
	const [pdfTranslationStatus, setPdfTranslationStatus] = useState<PdfTranslationEngineStatus>();
	const [teamAccess, setTeamAccess] = useState<TeamAccessStatus>();
	const [teamInvite, setTeamInvite] = useState("");
	const [teamNamespace, setTeamNamespace] = useState("");
	const [teamPending, setTeamPending] = useState<PreparedOperation>();
	const [teamBusy, setTeamBusy] = useState(false);
	const [pending, setPending] = useState<PreparedOperation>();
	const [pendingConfig, setPendingConfig] = useState<unknown>();
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [probeRevision, setProbeRevision] = useState(0);

	const load = useCallback(async () => {
		const loaded = await api<PaperAgentConfigView>("/api/config");
		setConfig(loaded);
		void api<TeamAccessStatus>("/api/team/access")
			.then((status) => {
				setTeamAccess(status);
				setTeamNamespace(status.namespace ?? "");
			})
			.catch((reason) =>
				setTeamAccess({
					configured: true,
					connected: false,
					source: "access-file",
					reason: reason instanceof Error ? reason.message : String(reason),
				}),
			);
		void api<PdfTranslationEngineStatus>("/api/pdf-translations/status")
			.then(setPdfTranslationStatus)
			.catch((reason) =>
				setPdfTranslationStatus({
					available: false,
					engine: "pdf2zh-next",
					command: loaded.pdfTranslation.command || "pdf2zh_next",
					reason: reason instanceof Error ? reason.message : String(reason),
				}),
			);
		setDirty(false);
	}, []);

	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [load]);

	const update = (recipe: (next: PaperAgentConfigView) => void) => {
		setDirty(true);
		setConfig((current) => {
			if (!current) return current;
			const next = structuredClone(current);
			recipe(next);
			return next;
		});
	};

	/**
	 * 设置页保存的是整份配置，因此这里必须只剔除服务端派生的只读字段
	 * （`path` 和 `credentialsAvailable`）；缺少模型元数据会让服务端校验层
	 * 用默认值补齐，从而静默重置上下文窗口与 token 上限。
	 */
	const serializable = (source: PaperAgentConfigView) => {
		const next: any = structuredClone(source);
		delete next.path;
		if (next.model) delete next.model.credentialsAvailable;
		for (const model of next.models ?? []) delete model.credentialsAvailable;
		return next;
	};

	const prepareTeamAccess = async (input: Record<string, unknown>) => {
		setError("");
		setMessage("");
		try {
			setTeamPending(await api<PreparedOperation>("/api/team/access/prepare", jsonBody(input)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const executeTeamAccess = async () => {
		if (!teamPending) return;
		setTeamBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(teamPending)) as ConfirmationGrant;
			const result = await api<{ status: TeamAccessStatus }>("/api/team/access/execute", jsonBody({ grant }));
			setTeamAccess(result.status);
			setTeamNamespace(result.status.namespace ?? "");
			setTeamInvite("");
			setTeamPending(undefined);
			setMessage(result.status.connected ? "团队接入已保存并生效。" : "本地团队接入已清除。");
			await onConfigurationSaved();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setTeamBusy(false);
		}
	};

	/** 计算候选配置并准备写操作；保存按钮走这条路径。 */
	const prepareSave = async () => {
		setError("");
		setMessage("");
		try {
			const candidate = serializable(config!);
			setPendingConfig(candidate);
			setPending(await api<PreparedOperation>("/api/config/prepare", jsonBody({ config: candidate })));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	/**
	 * 模型与供应商面板的编辑需要立即落盘：界面显示的模型列表和磁盘上的配置必须
	 * 一致，否则用户以为已经切换了模型，实际下次对话还是旧模型。这里接收一个
	 * 变更函数而不是依赖 `config` 状态，避免 React 状态更新尚未生效的竞态。
	 */
	const saveNow = async (recipe: (next: PaperAgentConfigView) => void) => {
		setError("");
		setMessage("");
		const next = structuredClone(config!);
		recipe(next);
		const candidate = serializable(next);
		try {
			const prepared = await api<PreparedOperation>("/api/config/prepare", jsonBody({ config: candidate }));
			const grant = (await confirmOperation(prepared)) as ConfirmationGrant;
			const result = await api<{ restartRequired: boolean }>(
				"/api/config/execute",
				jsonBody({ config: candidate, grant }),
			);
			setConfig(next);
			setDirty(false);
			setProbeRevision((current) => current + 1);
			setMessage(
				result.restartRequired
					? "已保存。存储路径或 namespace 有变化，请重启 Paper Agent 使其生效。"
					: "已保存并立即生效。",
			);
			await load();
			await onConfigurationSaved();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			throw reason;
		}
	};

	const executePending = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const result = await api<{ restartRequired: boolean }>(
				"/api/config/execute",
				jsonBody({ config: pendingConfig, grant }),
			);
			setMessage(
				result.restartRequired
					? "设置已保存。存储路径或 namespace 已改变，请重启 Paper Agent。"
					: "设置已保存并立即生效。服务级选项会在下次启动时应用。",
			);
			setPending(undefined);
			setPendingConfig(undefined);
			setProbeRevision((current) => current + 1);
			await load();
			await onConfigurationSaved();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	if (!config)
		return (
			<>
				<PageHeading eyebrow="LOCAL ENVIRONMENT · 本地环境" title="设置与诊断" description="读取本地配置中。" />
				{error ? <div className="error-banner">{error}</div> : <LoadingBlock />}
			</>
		);

	const pdfTranslationModels = configuredPdfTranslationModels(config);
	const selectedPdfTranslationModel = config.pdfTranslation.modelKey ?? pdfTranslationModels[0]?.key ?? "";

	return (
		<>
			<PageHeading
				eyebrow="LOCAL ENVIRONMENT · 本地环境"
				title="设置与诊断"
				description="管理本地工作区、操作确认、搜索与团队连接。"
				actions={
					<button
						className="button primary"
						type="button"
						disabled={!dirty || busy}
						onClick={() => void prepareSave()}
					>
						{dirty ? "保存设置" : "设置已保存"}
					</button>
				}
			/>
			{error && <div className="error-banner">{error}</div>}
			{message && <div className="success-banner">{message}</div>}
			{pending && (
				<AccessibleModal
					title="确认保存设置"
					onClose={() => {
						if (!busy) setPending(undefined);
					}}
					maxWidth={620}
				>
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => setPending(undefined)}
						onConfirm={executePending}
					/>
				</AccessibleModal>
			)}
			{teamPending && (
				<AccessibleModal
					title="确认团队接入变更"
					onClose={() => {
						if (!teamBusy) setTeamPending(undefined);
					}}
					maxWidth={620}
				>
					<ConsentCard
						operation={teamPending}
						busy={teamBusy}
						onCancel={() => setTeamPending(undefined)}
						onConfirm={executeTeamAccess}
					/>
				</AccessibleModal>
			)}
			<div className="settings-form">
				<ModelProvidersPanel config={config} saveNow={saveNow} onSaved={load} busy={busy} />
				<section className="panel form-panel">
					<span className="eyebrow">LOCAL WORKSPACE · 界面与存储</span>
					<h2>界面与存储</h2>
					<div className="form-grid two">
						<label>
							<span>默认个人 namespace</span>
							<input
								value={config.storage.defaultNamespace}
								onChange={(event) =>
									update((next) => {
										next.storage.defaultNamespace = event.target.value;
									})
								}
							/>
						</label>
						<label>
							<span>本地 Web 端口</span>
							<input
								type="number"
								min="0"
								max="65535"
								value={config.interface.port}
								onChange={(event) =>
									update((next) => {
										next.interface.port = Number(event.target.value);
									})
								}
							/>
						</label>
						<label className="wide">
							<span>运行数据目录（留空使用项目内 .paper-agent）</span>
							<input
								value={config.storage.dataRoot ?? ""}
								onChange={(event) =>
									update((next) => {
										next.storage.dataRoot = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label className="wide">
							<span>Corpus 目录（留空跟随运行数据目录）</span>
							<input
								value={config.storage.corpusRoot ?? ""}
								onChange={(event) =>
									update((next) => {
										next.storage.corpusRoot = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label className="wide">
							<span>外部命令目录</span>
							<input
								value={config.externalTools.commandDirectories.join(";")}
								placeholder="D:\\Tools\\poppler\\Library\\bin;D:\\Tools\\tesseract"
								onChange={(event) =>
									update((next) => {
										next.externalTools.commandDirectories = event.target.value
											.split(";")
											.map((path) => path.trim())
											.filter(Boolean);
									})
								}
							/>
							<small>多个目录用分号分隔。填写可执行文件所在目录，不填写具体 exe 文件。</small>
						</label>
					</div>
					<label className="toggle-row">
						<input
							type="checkbox"
							checked={config.interface.openBrowser}
							onChange={(event) =>
								update((next) => {
									next.interface.openBrowser = event.target.checked;
								})
							}
						/>
						<span>启动时自动打开浏览器</span>
					</label>
					<p className="form-hint">
						配置文件：<code>{config.path}</code>
					</p>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">READER TRANSLATION · 选区翻译</span>
					<h2>PDF 选区翻译</h2>
					<p className="form-hint">
						选中 PDF 文字后自动请求所选服务。密钥只保存在本地配置，浏览器不直接连接翻译服务。
					</p>
					<div className="form-grid">
						<label>
							<span>默认服务</span>
							<select
								value={config.readerTranslation.defaultProvider}
								onChange={(event) =>
									update((next) => {
										next.readerTranslation.defaultProvider = event.target.value as
											| "google"
											| "deepl"
											| "youdao"
											| "baidu";
									})
								}
							>
								<option value="google">Google Cloud Translation</option>
								<option value="deepl">DeepL</option>
								<option value="youdao">有道翻译</option>
								<option value="baidu">百度通用翻译</option>
							</select>
						</label>
						<label>
							<span>Google Cloud Translation API Key</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.googleTranslateApiKey ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.googleTranslateApiKey = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label>
							<span>DeepL API Key</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.deeplApiKey ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.deeplApiKey = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label>
							<span>有道应用 ID</span>
							<input
								autoComplete="off"
								value={config.credentials?.youdaoAppId ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.youdaoAppId = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label>
							<span>有道应用密钥</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.youdaoAppSecret ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.youdaoAppSecret = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label>
							<span>百度翻译 APP ID</span>
							<input
								autoComplete="off"
								value={config.credentials?.baiduTranslateAppId ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.baiduTranslateAppId = event.target.value || undefined;
									})
								}
							/>
						</label>
						<label>
							<span>百度翻译 APP 密钥</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.baiduTranslateAppSecret ?? ""}
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.baiduTranslateAppSecret = event.target.value || undefined;
									})
								}
							/>
						</label>
					</div>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">RESEARCH WIKI · 知识库与 Obsidian</span>
					<h2>知识库与 Obsidian</h2>
					<div className="form-grid">
						<label className="wide">
							<span>Obsidian 路径</span>
							<input
								value={config.wiki.obsidianPath ?? ""}
								placeholder="D:\\Tools\\obsidian"
								onChange={(event) =>
									update((next) => {
										next.wiki.obsidianPath = event.target.value || undefined;
									})
								}
							/>
							<small>可填写 Obsidian 安装目录或可执行文件路径；Wiki 仓库仍保存在 Paper Agent 数据目录中。</small>
						</label>
					</div>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">PDF TRANSLATION · 论文翻译</span>
					<h2>PDF 翻译引擎</h2>
					<div className="form-grid">
						<label className="wide">
							<span>PDF2zh Next 命令</span>
							<input
								value={config.pdfTranslation.command ?? ""}
								placeholder="pdf2zh_next"
								onChange={(event) =>
									update((next) => {
										next.pdfTranslation.command = event.target.value || undefined;
									})
								}
							/>
							<small>可填写命令名或可执行文件的完整路径；留空时从 PATH 调用 pdf2zh_next。</small>
						</label>
					</div>
					{pdfTranslationStatus && (
						<p className={pdfTranslationStatus.available ? "form-hint" : "error-text"}>
							{pdfTranslationStatus.available ? "命令可用" : "命令不可用"}：
							<code>{pdfTranslationStatus.command}</code>
							{pdfTranslationStatus.version ? `（${pdfTranslationStatus.version}）` : ""}
							{!pdfTranslationStatus.available && pdfTranslationStatus.reason
								? `；${pdfTranslationStatus.reason}`
								: ""}
						</p>
					)}
					<div className="translation-engine-options" role="radiogroup" aria-label="PDF 翻译引擎">
						<label className={config.pdfTranslation.engine === "siliconflowfree" ? "active" : ""}>
							<input
								type="radio"
								name="pdf-translation-engine"
								value="siliconflowfree"
								checked={config.pdfTranslation.engine === "siliconflowfree"}
								onChange={() =>
									update((next) => {
										next.pdfTranslation.engine = "siliconflowfree";
									})
								}
							/>
							<strong>SiliconFlowFree</strong>
							<span>无需配置模型密钥</span>
						</label>
						<label className={config.pdfTranslation.engine === "active-model" ? "active" : ""}>
							<input
								type="radio"
								name="pdf-translation-engine"
								value="active-model"
								checked={config.pdfTranslation.engine === "active-model"}
								onChange={() =>
									update((next) => {
										next.pdfTranslation.engine = "active-model";
									})
								}
							/>
							<strong>Paper Agent 模型</strong>
							<span>使用下方指定模型的接口与密钥</span>
						</label>
					</div>
					{config.pdfTranslation.engine === "active-model" && (
						<div className="form-grid">
							<label className="wide">
								<span>PDF 翻译模型</span>
								<select
									value={selectedPdfTranslationModel}
									disabled={pdfTranslationModels.length === 0}
									onChange={(event) =>
										update((next) => {
											next.pdfTranslation.modelKey = event.target.value;
										})
									}
								>
									{pdfTranslationModels.length === 0 && <option value="">没有兼容的模型</option>}
									{pdfTranslationModels.map((model) => (
										<option key={model.key} value={model.key}>
											{model.label}
										</option>
									))}
								</select>
							</label>
						</div>
					)}
					<p className="form-hint">
						仅列出 PDF2zh Next 支持的 OpenAI Completions 兼容模型；切换只影响之后创建的翻译任务。
					</p>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">MINERU ENGINE · MinerU 解析</span>
					<h2>论文解析材料</h2>
					<div className="form-grid two">
						<label className="wide">
							<span>API 地址</span>
							<input
								value={config.mineru.baseUrl}
								onChange={(event) =>
									update((next) => {
										next.mineru.baseUrl = event.target.value;
									})
								}
							/>
						</label>
						<label>
							<span>解析模型</span>
							<select
								value={config.mineru.modelVersion}
								onChange={(event) =>
									update((next) => {
										next.mineru.modelVersion = event.target.value as "pipeline" | "vlm";
									})
								}
							>
								<option value="vlm">VLM</option>
								<option value="pipeline">Pipeline</option>
							</select>
						</label>
						<label>
							<span>文档语言</span>
							<input
								value={config.mineru.language}
								onChange={(event) =>
									update((next) => {
										next.mineru.language = event.target.value;
									})
								}
							/>
						</label>
						<label className="wide">
							<span>MinerU API Key</span>
							<input
								type="password"
								autoComplete="off"
								value={config.credentials?.mineruApiKey ?? ""}
								placeholder="在此填写 MinerU API Key"
								onChange={(event) =>
									update((next) => {
										next.credentials ??= {};
										next.credentials.mineruApiKey = event.target.value || undefined;
									})
								}
							/>
						</label>
					</div>
					<p className="form-hint">
						材料按需生成，并保存在论文 PDF 同级的 mineru 目录中。系统优先使用 unzip，缺少时回退到 tar。
					</p>
				</section>
				<section className="panel form-panel confirmation-settings-panel">
					<span className="eyebrow">CONFIRMATION POLICY · 安全确认策略</span>
					<h2>操作确认</h2>
					<p className="muted">关闭后会自动授权并执行对应操作，manifest 指纹和一次性授权校验仍然保留。</p>
					<div className="confirmation-setting-list">
						{[
							{
								key: "requireAgentWriteConfirmation" as const,
								label: "Agent 普通写入前询问",
								description: "保存论文、导入、整理、创建或调整分类以及 Zotero 传输。",
							},
							{
								key: "requirePersonalLibraryWriteConfirmation" as const,
								label: "个人库普通操作前询问",
								description: "Web 保存、导入、整理、导出以及 Zotero 传输。",
							},
							{
								key: "requirePersonalLibraryDeleteConfirmation" as const,
								label: "个人库删除前询问",
								description: "删除论文、移出分类、取消分类归属以及删除分类树。",
							},
							{
								key: "requireResearchConfirmation" as const,
								label: "调研区写入和删除前询问",
								description: "Markdown 调研笔记的创建、修改、关联和删除。",
							},
							{
								key: "requireWikiWriteConfirmation" as const,
								label: "知识库写入前询问",
								description: "Agent 向研究 Wiki 新建或更新知识页面。",
							},
							{
								key: "requirePdfArtifactConfirmation" as const,
								label: "PDF 与 Artifact 操作前询问",
								description: "PDF 下载与修正、Artifact 获取和检查。",
							},
						].map((item) => (
							<div className="confirmation-setting-row" key={item.key}>
								<div>
									<strong>{item.label}</strong>
									<p>{item.description}</p>
								</div>
								<label className="switch">
									<input
										type="checkbox"
										checked={config.confirmations[item.key]}
										onChange={(event) =>
											update((next) => {
												next.confirmations[item.key] = event.target.checked;
											})
										}
										aria-label={item.label}
									/>
									<span />
								</label>
							</div>
						))}
					</div>
					<p className="form-hint">团队操作、令牌、备份恢复、配置修改和系统文件操作始终需要确认。</p>
				</section>
				<section className="panel form-panel">
					<span className="eyebrow">LITERATURE DISCOVERY · 检索配置</span>
					<h2>搜索默认值</h2>
					<div className="form-grid two">
						<label className="wide">
							<span>默认数据源（逗号分隔）</span>
							<input
								value={config.search.providers.join(", ")}
								onChange={(event) =>
									update((next) => {
										next.search.providers = event.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean);
									})
								}
							/>
						</label>
						<label className="wide">
							<span>DOI 补全数据源（逗号分隔）</span>
							<input
								value={config.search.doiEnrichmentProviders.join(", ")}
								onChange={(event) =>
									update((next) => {
										next.search.doiEnrichmentProviders = event.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean);
									})
								}
							/>
						</label>
						<label>
							<span>每源结果上限</span>
							<input
								type="number"
								min="1"
								max="500"
								value={config.search.maxResultsPerProvider}
								onChange={(event) =>
									update((next) => {
										next.search.maxResultsPerProvider = Number(event.target.value);
									})
								}
							/>
						</label>
						<label>
							<span>每源页数</span>
							<input
								type="number"
								min="1"
								max="20"
								value={config.search.pagesPerProvider}
								onChange={(event) =>
									update((next) => {
										next.search.pagesPerProvider = Number(event.target.value);
									})
								}
							/>
						</label>
						<label className="wide">
							<span>默认查询扩展（每行一条）</span>
							<textarea
								value={config.search.queryExpansions.join("\n")}
								onChange={(event) =>
									update((next) => {
										next.search.queryExpansions = event.target.value
											.split(/\r?\n/)
											.map((value) => value.trim())
											.filter(Boolean);
									})
								}
							/>
						</label>
					</div>
					<label className="toggle-row">
						<input
							type="checkbox"
							checked={config.search.reuseCorpus}
							onChange={(event) =>
								update((next) => {
									next.search.reuseCorpus = event.target.checked;
								})
							}
						/>
						<span>检索时优先复用个人库已有记录</span>
					</label>
				</section>
				<SearchProviderProbePanel key={probeRevision} />
				<section className="panel form-panel team-access-panel">
					<span className="eyebrow">TEAM NODE · 团队接入</span>
					<h2>团队接入</h2>
					{teamAccess?.connected ? (
						<>
							<div className="team-access-summary">
								<StatusPill status="succeeded" />
								<div>
									<strong>{teamAccess.identity?.name ?? "已连接"}</strong>
									<p>{teamAccess.serverUrl}</p>
									<small>{teamAccess.identity?.roles.join("、") || "身份已验证"}</small>
								</div>
							</div>
							<div className="form-grid two">
								<label>
									<span>当前团队空间</span>
									<input
										list="team-namespace-options"
										value={teamNamespace}
										onChange={(event) => setTeamNamespace(event.target.value)}
									/>
									<datalist id="team-namespace-options">
										{[
											...new Set(
												[teamAccess.namespace, ...(teamAccess.identity?.namespaces ?? [])].filter(Boolean),
											),
										].map((namespace) => (
											<option key={namespace} value={namespace} />
										))}
									</datalist>
								</label>
								<div className="team-access-actions">
									<button
										className="button secondary"
										type="button"
										disabled={!teamNamespace.trim() || teamNamespace === teamAccess.namespace || teamBusy}
										onClick={() =>
											void prepareTeamAccess({ action: "switch", namespace: teamNamespace.trim() })
										}
									>
										切换空间
									</button>
									<button
										className="button danger"
										type="button"
										disabled={teamBusy}
										onClick={() => void prepareTeamAccess({ action: "clear" })}
									>
										断开连接
									</button>
								</div>
							</div>
						</>
					) : (
						<>
							{teamAccess?.reason && <div className="error-banner">{teamAccess.reason}</div>}
							<label className="team-invite-field">
								<span>编码接入串</span>
								<textarea
									value={teamInvite}
									placeholder="pateam1."
									onChange={(event) => setTeamInvite(event.target.value)}
								/>
							</label>
							<div className="team-access-actions">
								<button
									className="button primary"
									type="button"
									disabled={!teamInvite.trim() || teamBusy}
									onClick={() => void prepareTeamAccess({ action: "connect", invite: teamInvite.trim() })}
								>
									验证并接入
								</button>
								{teamAccess?.hasLocalAccess && (
									<button
										className="button danger"
										type="button"
										disabled={teamBusy}
										onClick={() => void prepareTeamAccess({ action: "clear" })}
									>
										清除失效接入
									</button>
								)}
							</div>
							<p className="form-hint">
								接入串包含服务器地址、团队空间、身份凭据和自签 CA；它只是编码，不是加密。
							</p>
						</>
					)}
				</section>
			</div>
		</>
	);
}

export default SettingsPage;
