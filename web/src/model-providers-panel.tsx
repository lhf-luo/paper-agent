import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PiModelsView, PiProviderView } from "../../src/agent/domain/pi-models";
import { api, jsonBody } from "./api";
import { PiCredentialDialog } from "./pi-credential-dialog";
import type { PaperAgentConfigView } from "./types";

export interface ModelProvidersPanelProps {
	config: PaperAgentConfigView;
	saveNow: (recipe: (next: PaperAgentConfigView) => void) => Promise<void>;
	onSaved: () => Promise<void>;
	busy: boolean;
}

function usePiModelSettings(onSaved: () => Promise<void>) {
	const [view, setView] = useState<PiModelsView>();
	const [providerId, setProviderId] = useState("");
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const load = useCallback(async (refresh = false) => {
		setBusy(true);
		setError("");
		try {
			const next = await api<PiModelsView>(
				refresh ? "/api/pi/models/refresh" : "/api/pi/models",
				refresh ? jsonBody({}) : undefined,
			);
			setView(next);
			setProviderId(
				(current) =>
					current ||
					next.providers.find((p) => next.activeKey?.startsWith(`${p.id}/`))?.id ||
					next.providers.find((p) => p.configured)?.id ||
					"deepseek",
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	const selected = view?.providers.find((p) => p.id === providerId);
	const saved = async () => {
		setEditing(false);
		await load();
		await onSaved();
	};
	return { view, providerId, setProviderId, editing, setEditing, busy, error, load, selected, saved };
}

export function ModelProvidersPanel({ onSaved }: ModelProvidersPanelProps) {
	const state = usePiModelSettings(onSaved);
	return (
		<section className="panel form-panel model-providers-panel">
			<ProviderPicker state={state} />
			{state.selected && (
				<ProviderSettings
					provider={state.selected}
					view={state.view!}
					busy={state.busy}
					onConfigure={() => state.setEditing(true)}
					onSaved={state.load}
				/>
			)}
			{state.view && <FileModels view={state.view} onSaved={state.load} />}
			{state.view && (
				<p className="form-hint">
					项目 Pi 配置：<code>{state.view.directory}</code>。中转站请编辑此目录的 models.json；凭据保存在
					auth.json，模型缓存由 Pi 管理。OAuth 登录请运行 paper-agent agent，使用 /login。
				</p>
			)}
			{state.editing && state.selected && (
				<PiCredentialDialog
					provider={state.selected}
					directory={state.view!.directory}
					onClose={() => state.setEditing(false)}
					onSaved={state.saved}
				/>
			)}
		</section>
	);
}

function ProviderPicker({ state }: { state: ReturnType<typeof usePiModelSettings> }) {
	return (
		<div className="form-grid">
			<div className="model-providers-heading">
				<h2>模型与供应商</h2>
				<button
					className="button secondary"
					type="button"
					disabled={state.busy}
					onClick={() => void state.load(true)}
				>
					<RefreshCw size={14} />
					{state.busy ? "正在刷新…" : "刷新模型目录"}
				</button>
			</div>
			{state.error && (
				<div className="error-banner" role="alert">
					{state.error}
				</div>
			)}
			{state.view?.error && (
				<div className="error-banner" role="alert">
					Pi 模型文件有误，请检查 models.json。
				</div>
			)}
			<label>
				提供商
				<select
					value={state.providerId}
					disabled={!state.view || state.busy}
					onChange={(e) => state.setProviderId(e.target.value)}
				>
					{!state.view && <option value="">正在读取 Pi 提供商…</option>}
					{state.view?.providers.map((p) => (
						<option value={p.id} key={p.id}>
							{p.name} · {p.configured ? "已配置" : "未配置"}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}

function ProviderSettings({
	provider,
	view,
	busy,
	onConfigure,
	onSaved,
}: {
	provider: PiProviderView;
	view: PiModelsView;
	busy: boolean;
	onConfigure: () => void;
	onSaved: () => Promise<void>;
}) {
	const models = view.models.filter((m) => m.providerId === provider.id);
	return (
		<div className="model-provider-card">
			<div className="model-provider-head">
				<div>
					<strong>{provider.name}</strong> <span className="chip">{provider.modelCount} 个聊天模型</span>
				</div>
				<button
					className="button secondary"
					type="button"
					disabled={busy || !provider.apiKeyLogin}
					onClick={onConfigure}
				>
					<KeyRound size={14} />
					{provider.configured ? "更新凭据" : "配置凭据"}
				</button>
			</div>
			{provider.customized && <p className="form-hint">此提供商包含 models.json 中的自定义配置。</p>}
			{!provider.apiKeyLogin && (
				<p className="form-hint">请使用项目 Pi 目录在终端登录，或设置此提供商要求的环境凭据，然后刷新。</p>
			)}
			<ModelChoice models={models} activeKey={view.activeKey} onSaved={onSaved} />
		</div>
	);
}

function FileModels({ view, onSaved }: { view: PiModelsView; onSaved: () => Promise<void> }) {
	const builtins = new Set(view.providers.map((p) => p.id));
	const models = view.models.filter((m) => !builtins.has(m.providerId));
	if (!models.length) return null;
	return (
		<div className="model-provider-card">
			<strong>模型文件中的中转站</strong>
			<ModelChoice models={models} activeKey={view.activeKey} onSaved={onSaved} />
		</div>
	);
}

function ModelChoice({
	models,
	activeKey,
	onSaved,
}: {
	models: PiModelsView["models"];
	activeKey?: string;
	onSaved: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const select = async (key: string) => {
		setBusy(true);
		setError("");
		try {
			await api("/api/agent/config/apply", jsonBody({ key }));
			await onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="form-grid">
			{error && (
				<p className="error-text" role="alert">
					{error}
				</p>
			)}
			<label>
				对话模型
				<select
					value={models.some((m) => m.key === activeKey) ? activeKey : ""}
					disabled={busy || !models.length}
					onChange={(e) => void select(e.target.value)}
				>
					<option value="" disabled>
						{models.length ? "选择模型" : "配置凭据后显示可用模型"}
					</option>
					{models.map((m) => (
						<option key={m.key} value={m.key}>
							{m.name} · {m.modelId}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}
