/**
 * 测速: 对比各 provider「走代理」vs「直连」的响应时间(3 次取中位数)。
 * 用于判断 NO_PROXY 白名单是否需要调整。
 * 用法: node scripts/compare-speed.ts
 */
import { ProxyAgent, fetch } from "undici";

const PROXY = "http://127.0.0.1:7890";
const proxyAgent = new ProxyAgent(PROXY);

const endpoints: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
	{ name: "arxiv", url: "https://export.arxiv.org/api/query?search_query=all:electron&max_results=1" },
	{ name: "crossref", url: "https://api.crossref.org/works?query=electron&rows=1" },
	{ name: "semanticscholar", url: "https://api.semanticscholar.org/graph/v1/paper/search?query=electron&limit=1" },
	{ name: "dblp", url: "https://dblp.org/search/publ/api?q=electron&format=json" },
	{ name: "core", url: "https://api.core.ac.uk/v3/search/works?q=electron" },
	{ name: "opencitations", url: "https://api.opencitations.net/meta/api/v1/metadata/doi:10.1145/3585386" },
	{ name: "unpaywall", url: "https://api.unpaywall.org/v2/10.1145/3585386" },
];

async function probe(url: string, dispatcher?: unknown, headers?: Record<string, string>) {
	const start = Date.now();
	try {
		const res = await fetch(url, {
			dispatcher: dispatcher as never,
			headers: { "user-agent": "paper-agent-speed-test/1.0", ...headers },
			signal: AbortSignal.timeout(15_000),
		});
		await res.arrayBuffer(); // 读完整 body 才算真实耗时
		return { ok: res.ok, status: res.status, ms: Date.now() - start };
	} catch (error) {
		return { ok: false, status: 0, ms: Date.now() - start, error: (error as Error).message };
	}
}

function median(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

console.log(`代理: ${PROXY}\n`);
console.log("provider          | 代理中位数 | 直连中位数 | 更快");
console.log("------------------|-----------|-----------|-----");

for (const ep of endpoints) {
	const viaProxy: number[] = [];
	const direct: number[] = [];
	for (let i = 0; i < 3; i++) {
		viaProxy.push((await probe(ep.url, proxyAgent, ep.headers)).ms);
		direct.push((await probe(ep.url, undefined, ep.headers)).ms);
	}
	const pm = median(viaProxy);
	const dm = median(direct);
	const faster = pm < dm ? "代理更快" : dm < pm ? "直连更快" : "持平";
	const pmStr = pm >= 15000 ? "超时" : `${pm}ms`;
	const dmStr = dm >= 15000 ? "超时" : `${dm}ms`;
	console.log(`${ep.name.padEnd(16)} | ${pmStr.padEnd(9)} | ${dmStr.padEnd(9)} | ${faster}`);
	await new Promise((r) => setTimeout(r, 500)); // 避免限流
}
