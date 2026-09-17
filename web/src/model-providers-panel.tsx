import { Loader2, Plus, RefreshCw, Server, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api";
import { AccessibleModal, confirmOperation } from "./components";
import {
	addProvider,
	configuredModels,
	MODEL_API_KINDS,
	type ModelApiKind,
	modelKey,
	providerGroups,
	removeModel,
	removeProvider,
	replaceConfig,
	setActiveModel,
	suggestProviderId,
	supportsModelDiscovery,
	validateProviderInput,
} from "./model-providers";
import type { ModelConfigView, PaperAgentConfigView, PreparedOperation } from "./types";

interface DiscoveredModel {
	id: string;
	name: string;
}

interface DiscoveryResponse {
	providerId: string;
	models: DiscoveredModel[];
}

interface AddProviderSubmission {
	providerId: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKey?: string;
	apiKeyEnvironmentVariable?: string;
	modelIds: string[];
	existing: ModelConfigView[];
}

type AddProviderDialogSubmit = (input: AddProviderSubmission) => Promise<void>;

export interface ModelProvidersPanelProps {
	config: PaperAgentConfigView;
	/**
	 * 应用一次配置变更并立即走"prepare → 确认 → execute"保存链路。传入变更函数
	 * 而不是结果，是为了不依赖设置页尚未刷新的 `config` 状态。
	 */
	saveNow: (recipe: (next: PaperAgentConfigView) => void) => Promise<void>;
	/** 保存成功后刷新设置页数据。 */
	onSaved: () => Promise<void>;
	busy: boolean;
}

export function ModelProvidersPanel({ config, saveNow, onSaved, busy }: ModelProvidersPanelProps) {
	const [editing, setEditing] = useState<{ providerId?: string }>();
	const [probeBusy, setProbeBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const groups = providerGroups(config);
	const active = config.model;
	const activeKey = active ? modelKey(active) : undefined;

	const probe = async () => {
		setError("");
		setNotice("");
		setProbeBusy(true);
		try {
			// 探测计划由服务端签发：准备后确认，才会向上游发出一次真实请求。
			const prepared = await api<PreparedOperation>("/api/model-probe/prepare", jsonBody({}));
			const grant = await confirmOperation(prepared);
			const result = await api<{ supported: boolean; reason: string; latencyMs: number }>(
				"/api/model-probe/execute",
				jsonBody({ grant }),
			);
			setNotice(
				result.supported ? `工具调用探测通过（${result.latencyMs} ms）。` : `工具调用探测未通过：${result.reason}`,
			);
			await onSaved();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setProbeBusy(false);
		}
	};

	const apply = (recipe: (next: PaperAgentConfigView) => void) => {
		setError("");
		void saveNow(recipe).catch((reason) => {
			setError(reason instanceof Error ? reason.message : String(reason));
		});
	};

	/** 对话框提交需要等待保存结果：失败时保持对话框打开并显示错误。 */
	const submitProvider = async (input: Parameters<AddProviderDialogSubmit>[0]) => {
		setError("");
		await saveNow((next) => replaceConfig(next, addProvider(next, input)));
		setEditing(undefined);
	};

	return (
		<section className="panel form-panel model-providers-panel">
			<div className="model-providers-heading">
				<div>
					<span className="eyebrow">MODEL PROVIDERS · 模型与供应商</span>
					<h2>模型与供应商</h2>
				</div>
				<button className="button secondary" type="button" onClick={() => setEditing({})}>
					<Plus size={14} strokeWidth={2.4} />
					添加供应商
				</button>
			</div>
			<p className="muted">
				这里配置的模型会出现在 <strong>Agent 对话</strong> 的模型选择器里。密钥保存在
				<code>.paper-agent/config/auth.json</code>，不会随配置视图回传浏览器。
			</p>
			{notice && <div className="success-banner">{notice}</div>}
			{error && <div className="error-banner">{error}</div>}

			{groups.length === 0 ? (
				<p className="form-hint">
					还没有配置供应商。点击"添加供应商"填写 Base URL 与 API key，或使用命令行
					<code>paper-agent models add</code>。
				</p>
			) : (
				<div className="model-provider-list">
					{groups.map((group) => (
						<div className="model-provider-card" key={group.providerId}>
							<div className="model-provider-head">
								<div className="model-provider-title">
									<Server size={15} strokeWidth={2} />
									<strong>{group.providerId}</strong>
									<span className="chip">{group.api}</span>
									{group.credentialsAvailable ? (
										<span className="chip active">凭据可用</span>
									) : (
										<span className="chip unavailable">缺少密钥</span>
									)}
								</div>
								<div className="model-provider-actions">
									<button
										className="text-button"
										type="button"
										onClick={() => setEditing({ providerId: group.providerId })}
									>
										重新配置
									</button>
									<button
										className="text-button danger"
										type="button"
										disabled={busy}
										onClick={() =>
											apply((next) => replaceConfig(next, removeProvider(next, group.providerId)))
										}
									>
										删除供应商
									</button>
								</div>
							</div>
							<code className="model-provider-url">{group.baseUrl}</code>
							<div className="model-provider-models">
								{group.models.map((model) => {
									const key = modelKey(model);
									const isActive = key === activeKey;
									return (
										<div className="model-row" key={key}>
											<div className="model-row-name">
												<strong>{model.name ?? model.modelId}</strong>
												<code>{model.modelId}</code>
												{isActive && <span className="chip active">当前对话模型</span>}
											</div>
											<div className="model-row-actions">
												<button
													className="text-button"
													type="button"
													disabled={busy || isActive}
													onClick={() => apply((next) => replaceConfig(next, setActiveModel(next, key)))}
												>
													{isActive ? "已选中" : "设为对话模型"}
												</button>
												<button
													className="text-button danger"
													type="button"
													disabled={busy}
													aria-label={`删除模型 ${key}`}
													onClick={() => apply((next) => replaceConfig(next, removeModel(next, key)))}
												>
													<Trash2 size={13} strokeWidth={2} />
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>
			)}

			{active && (
				<div className="model-probe-row">
					<div>
						<strong>工具调用能力</strong>
						<p className="form-hint">
							{active.toolCallingVerifiedAt
								? `已于 ${new Date(active.toolCallingVerifiedAt).toLocaleString()} 验证。`
								: supportsModelDiscovery(active.api)
									? "尚未验证。发送一次极小的工具调用请求来确认中转站支持 function calling。"
									: `${active.api} 无法自动探测，请从 paper-agent agent 用真实任务验证。`}
						</p>
					</div>
					<button
						className="button secondary"
						type="button"
						disabled={probeBusy || busy || !supportsModelDiscovery(active.api)}
						onClick={() => void probe()}
					>
						{probeBusy ? (
							<Loader2 size={14} className="agent-spinning" />
						) : (
							<Zap size={14} strokeWidth={2} />
						)}
						探测
					</button>
				</div>
			)}

			<p className="form-hint">
				新增或删除模型会立即反映到 Agent 对话的模型选择器里；切换当前模型时，正在生成的回答结束后生效。
			</p>

			{editing && (
				<AddProviderDialog
					config={config}
					providerId={editing.providerId}
					onClose={() => setEditing(undefined)}
					onSubmit={submitProvider}
				/>
			)}
		</section>
	);
}

interface AddProviderDialogProps {
	config: PaperAgentConfigView;
	providerId?: string;
	onClose: () => void;
	onSubmit: AddProviderDialogSubmit;
}

function AddProviderDialog({ config, providerId, onClose, onSubmit }: AddProviderDialogProps) {
	const existingModels = configuredModels(config).filter((model) => model.providerId === providerId);
	const existing = existingModels[0];
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
	const [provider, setProvider] = useState(providerId ?? "");
	const [providerTouched, setProviderTouched] = useState(Boolean(providerId));
	const [apiKind, setApiKind] = useState<ModelApiKind>(existing?.api ?? "openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [environmentVariable, setEnvironmentVariable] = useState(existing?.apiKeyEnvironmentVariable ?? "");
	const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
	const [selected, setSelected] = useState<string[]>(existingModels.map((model) => model.modelId));
	const [manual, setManual] = useState("");
	const [discovering, setDiscovering] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	// 供应商 ID 默认由 Base URL 推断，用户手改后不再覆盖。
	useEffect(() => {
		if (providerTouched || !baseUrl.trim()) return;
		setProvider(suggestProviderId(baseUrl));
	}, [baseUrl, providerTouched]);

	const discoveryAvailable = supportsModelDiscovery(apiKind);
	const canDiscover = discoveryAvailable && Boolean(apiKey.trim()) && Boolean(baseUrl.trim());
	const manualIds = manual
		.split(/[\n,]/)
		.map((value) => value.trim())
		.filter(Boolean);
	const modelIds = [...new Set([...selected, ...manualIds])];

	const discover = useCallback(async () => {
		setError("");
		setDiscovering(true);
		try {
			const result = await api<DiscoveryResponse>(
				"/api/models/discover",
				jsonBody({ providerId: provider.trim() || undefined, baseUrl, api: apiKind, apiKey }),
			);
			setDiscovered(result.models);
			if (!providerTouched && result.providerId) setProvider(result.providerId);
			setSelected((current) => current.filter((id) => result.models.some((model) => model.id === id)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setDiscovering(false);
		}
	}, [apiKind, apiKey, baseUrl, provider, providerTouched]);

	const submit = async () => {
		const validation = validateProviderInput({ providerId: provider, baseUrl });
		if (validation) {
			setError(validation);
			return;
		}
		if (!modelIds.length) {
			setError(
				discoveryAvailable
					? "请先读取模型列表并勾选至少一个模型，或手动填写模型 ID。"
					: "请至少填写一个模型 ID。",
			);
			return;
		}
		setError("");
		setSubmitting(true);
		try {
			await onSubmit({
				providerId: provider.trim(),
				baseUrl,
				api: apiKind,
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
				...(environmentVariable.trim() ? { apiKeyEnvironmentVariable: environmentVariable.trim() } : {}),
				modelIds,
				existing: existingModels,
			});
		} catch (reason) {
			setSubmitting(false);
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	return (
		<AccessibleModal
			title={providerId ? `重新配置 ${providerId}` : "添加供应商"}
			description="填写中转站或供应商的 OpenAI 兼容端点；密钥只随本次保存写入本地配置。"
			onClose={() => {
				if (!submitting) onClose();
			}}
			maxWidth={680}
		>
			<div className="form-grid two">
				<label className="wide">
					<span>Base URL</span>
					<input
						value={baseUrl}
						placeholder="https://relay.example.com/v1"
						onChange={(event) => setBaseUrl(event.target.value)}
					/>
				</label>
				<label>
					<span>供应商 ID</span>
					<input
						value={provider}
						placeholder="research-relay"
						onChange={(event) => {
							setProviderTouched(true);
							setProvider(event.target.value);
						}}
					/>
				</label>
				<label>
					<span>API 类型</span>
					<select value={apiKind} onChange={(event) => setApiKind(event.target.value as ModelApiKind)}>
						{MODEL_API_KINDS.map((kind) => (
							<option key={kind} value={kind}>
								{kind}
							</option>
						))}
					</select>
				</label>
				<label>
					<span>API key</span>
					<input
						type="password"
						autoComplete="off"
						value={apiKey}
						placeholder={existing ? "留空表示沿用已保存的密钥" : "sk-…"}
						onChange={(event) => setApiKey(event.target.value)}
					/>
				</label>
				<label>
					<span>或使用环境变量名</span>
					<input
						value={environmentVariable}
						placeholder="PAPER_AGENT_RELAY_API_KEY"
						onChange={(event) => setEnvironmentVariable(event.target.value)}
					/>
				</label>
			</div>

			{discoveryAvailable ? (
				<fieldset className="model-discovery">
					<legend>模型列表</legend>
					<div className="model-discovery-head">
						<button
							className="button secondary"
							type="button"
							disabled={!canDiscover || discovering}
							onClick={() => void discover()}
						>
							{discovering ? (
								<Loader2 size={14} className="agent-spinning" />
							) : (
								<RefreshCw size={14} strokeWidth={2} />
							)}
							读取模型列表
						</button>
					</div>
					{!canDiscover && (
						<p className="form-hint">读取列表需要先填写 API key；也可以直接在下方手动填写模型 ID。</p>
					)}
					{discovered.length > 0 && (
						<div className="model-discovery-list">
							{discovered.map((model) => (
								<label key={model.id} className="checkbox-field">
									<input
										type="checkbox"
										checked={selected.includes(model.id)}
										onChange={(event) =>
											setSelected((current) =>
												event.target.checked
													? [...current, model.id]
													: current.filter((id) => id !== model.id),
											)
										}
									/>
									<span>{model.id}</span>
								</label>
							))}
						</div>
					)}
				</fieldset>
			) : (
				<p className="form-hint">
					{apiKind} 无法自动发现模型，请在下方手动填写模型 ID。
				</p>
			)}

			<label className="model-manual-models">
				<span>手动填写模型 ID（每行一个，可选）</span>
				<textarea
					rows={3}
					value={manual}
					placeholder={"your-model-id\nanother-model-id"}
					onChange={(event) => setManual(event.target.value)}
				/>
			</label>

			{error && <div className="error-banner">{error}</div>}
			<div className="button-row">
				<span className="muted">
					{modelIds.length
						? `将保存 ${modelIds.length} 个模型：${modelIds.join("、")}`
						: "尚未选择任何模型"}
				</span>
				<button className="button secondary" type="button" disabled={submitting} onClick={onClose}>
					取消
				</button>
				<button className="button primary" type="button" disabled={submitting} onClick={() => void submit()}>
					{submitting ? "正在保存…" : "添加并保存"}
				</button>
			</div>
		</AccessibleModal>
	);
}
