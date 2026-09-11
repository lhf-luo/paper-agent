/**
 * Provider 连通性测试: 对每个 provider 分别测「走代理」和「直连」,
 * 并验证已配置的 API key 是否有效。
 * 用法: node scripts/test-connectivity.ts
 */
import { ProxyAgent, fetch } from "undici";
import { loadPaperAgentConfig } from "../src/config/application/config-service.ts";

const cfg = await loadPaperAgentConfig(process.cwd());
const proxyUrl = cfg.network?.proxyEnabled ? cfg.network.proxyUrl : undefined;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const TIMEOUT = 20_000;

const endpoints: Array<{ name: string; url: string; testKey?: (resp: Response) => boolean }> = [
	{ name: "arxiv", url: "https://export.arxiv.org/api/query?search_query=all:electron&max_results=1" },
	{ name: "openalex", url: "https://api.openalex.org/works?search=electron&per-page=1" },
	{ name: "crossref", url: "https://api.crossref.org/works?query=electron&rows=1" },
	{ name: "semanticscholar", url: "https://api.semanticscholar.org/graph/v1/paper/search?query=electron&limit=1" },
];

async function probe(url: string, dispatcher?: typeof proxyAgent, headers?: Record<string, string>) {
	const start = Date.now();
	try {
		const res = await fetch(url, {
			dispatcher,
			headers: headers ? { "user-agent": "paper-agent-connectivity-test/1.0", ...headers } : { "user-agent": "paper-agent-connectivity-test/1.0" },
			signal: AbortSignal.timeout(TIMEOUT),
		});
		const ms = Date.now() - start;
		return { ok: res.ok, status: res.status, ms, body: (await res.text()).slice(0, 120) };
	} catch (error) {
		const ms = Date.now() - start;
		return { ok: false, status: 0, ms, error: (error as Error).message };
	}
}

function fmt(r: { ok: boolean; status: number; ms: number; error?: string; body?: string }) {
	if (r.ok) return `✅ ${r.status} ${r.ms}ms`;
	if (r.status) return `⚠️ HTTP ${r.status} ${r.ms}ms`;
	return `❌ ${r.ms}ms ${(r.error ?? "").slice(0, 60)}`;
}

console.log(`代理: ${proxyUrl ?? "(无)"}\n`);

// 1. 各 provider 连通性（代理 vs 直连）
for (const ep of endpoints) {
	const viaProxy = await probe(ep.url, proxyAgent);
	const direct = await probe(ep.url);
	console.log(`[${ep.name}]`);
	console.log(`  走代理: ${fmt(viaProxy)}`);
	console.log(`  直连:   ${fmt(direct)}`);
}

// 2. key 有效性
console.log("\n=== API Key 有效性 ===");
const cred = (cfg.credentials ?? {}) as NonNullable<typeof cfg.credentials> & { openAlexApiKey?: string };

if (cred.exaApiKey) {
	const r = await probe("https://mcp.exa.ai/mcp", proxyAgent, {
		"x-api-key": cred.exaApiKey,
		"content-type": "application/json",
	});
	console.log(`exaApiKey: ${fmt(r)}${r.status === 404 || r.status === 405 ? " (端点需POST, 但代理连通正常)" : ""}`);
}

if (cred.openAlexApiKey || cred.openAlexMailto) {
	const mailto = cred.openAlexMailto ? `&mailto=${encodeURIComponent(cred.openAlexMailto)}` : "";
	const r = await probe(`https://api.openalex.org/works?search=electron&per-page=1${mailto}`, proxyAgent, cred.openAlexApiKey ? { "api-key": cred.openAlexApiKey } : undefined);
	console.log(`openAlex (mailto=${cred.openAlexMailto ? "已配置" : "无"}): ${fmt(r)}`);
}

if (cred.semanticScholarApiKey) {
	const r = await probe("https://api.semanticscholar.org/graph/v1/paper/search?query=electron&limit=1", proxyAgent, { "x-api-key": cred.semanticScholarApiKey });
	console.log(`semanticScholarApiKey: ${fmt(r)}${r.status === 401 || r.status === 403 ? " ⚠️ key 可能无效" : ""}`);
}

if (cred.coreApiKey) {
	const r = await probe("https://api.core.ac.uk/v3/search/works?q=electron", proxyAgent, { "Authorization": `Bearer ${cred.coreApiKey}` });
	console.log(`coreApiKey: ${fmt(r)}${r.status === 401 || r.status === 403 ? " ⚠️ key 可能无效" : ""}`);
}

// 3. 模型 key（DeepSeek）
const model = cfg.model;
if (model?.apiKey) {
	const r = await probe(`${model.baseUrl}/models`, proxyAgent, { Authorization: `Bearer ${model.apiKey}` });
	console.log(`\n=== 模型 key ===`);
	console.log(`deepseek (${model.modelId}): ${fmt(r)}`);
}
