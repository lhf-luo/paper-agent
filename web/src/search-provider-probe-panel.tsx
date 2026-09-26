import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { runWithConcurrency } from "./search-provider-probe";

interface SearchProvider {
	id: string;
	label: string;
	capabilities: string[];
}

interface ProbeResult {
	providerId: string;
	status: "results" | "empty" | "partial" | "missing-key" | "auth" | "rate-limited" | "network" | "invalid-response";
	credentialMode: "configured" | "anonymous" | "not-applicable" | "missing-required";
	checkedAt: string;
	latencyMs: number;
	recordCount: number;
	sampleTitle?: string;
	httpStatus?: number;
	message: string;
}

const statusLabels: Record<ProbeResult["status"], string> = {
	results: "有结果",
	empty: "连接成功但无结果",
	partial: "部分成功",
	"missing-key": "缺少必需 Key",
	auth: "认证或权限失败",
	"rate-limited": "限流",
	network: "超时／网络故障",
	"invalid-response": "来源响应异常",
};

export function SearchProviderProbePanel() {
	const [providers, setProviders] = useState<SearchProvider[]>([]);
	const [results, setResults] = useState<Record<string, ProbeResult>>({});
	const [running, setRunning] = useState<string[]>([]);
	const [error, setError] = useState("");
	const busy = useRef(false);

	useEffect(() => {
		void api<{ providers: SearchProvider[] }>("/api/providers")
			.then((response) =>
				setProviders(response.providers.filter((provider) => provider.capabilities.includes("keyword-search"))),
			)
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);

	const probe = async (provider: SearchProvider) => {
		setRunning((current) => [...current, provider.id]);
		try {
			const result = await api<ProbeResult>("/api/search/providers/probe", jsonBody({ providerId: provider.id }));
			setResults((current) => ({ ...current, [provider.id]: result }));
		} catch {
			setResults((current) => ({
				...current,
				[provider.id]: {
					providerId: provider.id,
					status: "network",
					credentialMode: "not-applicable",
					checkedAt: new Date().toISOString(),
					latencyMs: 0,
					recordCount: 0,
					message: "本地服务请求失败，请检查服务连接。",
				},
			}));
		} finally {
			setRunning((current) => current.filter((id) => id !== provider.id));
		}
	};

	const probeAll = async () => {
		if (busy.current) return;
		busy.current = true;
		try {
			await runWithConcurrency(providers, 2, probe);
		} finally {
			busy.current = false;
		}
	};

	return (
		<section className="panel form-panel search-provider-probe-panel">
			<span className="eyebrow">LITERATURE DISCOVERY · 检索源测试</span>
			<div className="search-provider-probe-heading">
				<h2>检索源测试</h2>
				<button type="button" onClick={() => void probeAll()} disabled={!providers.length || running.length > 0}>
					测试全部
				</button>
			</div>
			<p className="form-hint">使用已保存的配置进行小规模真实搜索，不保存测试论文。修改 Key 后请先保存设置。</p>
			{error && <p role="alert">{error}</p>}
			<div className="search-provider-probe-list">
				{providers.map((provider) => {
					const result = results[provider.id];
					const isRunning = running.includes(provider.id);
					return (
						<div className="search-provider-probe-row" key={provider.id}>
							<div className="search-provider-probe-name">
								<strong>{provider.label}</strong>
							</div>
							<div className="search-provider-probe-result">
								<strong>{isRunning ? "测试中…" : result ? statusLabels[result.status] : "尚未测试"}</strong>
								{result && (
									<>
										<span>
											{result.message}
											{result.httpStatus ? ` HTTP ${result.httpStatus}` : ""}
										</span>
										<span>
											{new Date(result.checkedAt).toLocaleString()} · {result.latencyMs} ms ·{" "}
											{result.recordCount} 篇
											{result.credentialMode === "anonymous" ? " · 匿名测试（不代表 Key 有效）" : ""}
										</span>
										{result.sampleTitle && <span title={result.sampleTitle}>示例：{result.sampleTitle}</span>}
									</>
								)}
							</div>
							<button
								type="button"
								onClick={() => void probe(provider)}
								disabled={isRunning || running.length > 0}
							>
								{isRunning ? "测试中" : "测试"}
							</button>
						</div>
					);
				})}
			</div>
		</section>
	);
}
