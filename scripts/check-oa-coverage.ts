/**
 * 统计扩展论文中, 通过多源解析(Unpaywall / S2 / OpenAlex)能拿到 DOI 下载链接的数量。
 */

import { loadPaperAgentConfig } from "../src/config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { setProxyUrl } from "../src/shared/infrastructure/network-proxy-config.ts";
import { fetchWithRetry } from "../src/shared/infrastructure/network-security.ts";

setProxyUrl("http://127.0.0.1:7890");
const cfg = await loadPaperAgentConfig(process.cwd());
const unpaywallEmail = cfg.credentials?.unpaywallEmail ?? cfg.credentials?.openAlexMailto;
const s2Key = cfg.credentials?.semanticScholarApiKey;
console.log("Unpaywall email:", unpaywallEmail ?? "(无)");

const store = new LiteratureStore(resolveCorpusRoot(process.cwd(), "personal", "default"), "personal", "default");
const records = await store.listPapers();
// 排除已下载的
const noPdf = records.filter((r) => !r.links.some((l) => l.kind === "pdf") && r.identifiers?.doi);
console.log("无 PDF 链接且有 DOI 的论文:", noPdf.length, "/", records.length);

async function resolveByUnpaywall(doi: string): Promise<string | undefined> {
	if (!unpaywallEmail) return undefined;
	try {
		const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
		url.searchParams.set("email", unpaywallEmail);
		const r = await fetchWithRetry(url, { timeoutMs: 15000 });
		if (!r.ok) return undefined;
		const d = (await r.json()) as { best_oa_location?: { url_for_pdf?: string } };
		return d.best_oa_location?.url_for_pdf || undefined;
	} catch {
		return undefined;
	}
}

async function resolveByS2(doi: string): Promise<string | undefined> {
	try {
		const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}`);
		url.searchParams.set("fields", "openAccessPdf,externalIds");
		const r = await fetchWithRetry(url, { timeoutMs: 15000, init: { headers: s2Key ? { "x-api-key": s2Key } : {} } });
		if (!r.ok) return undefined;
		const d = (await r.json()) as {
			openAccessPdf?: { url?: string; status?: string };
			externalIds?: Record<string, string>;
		};
		if (d.openAccessPdf?.url && d.openAccessPdf.status !== "CLOSED") return d.openAccessPdf.url;
		const arxiv = d.externalIds?.ArXiv || d.externalIds?.arXiv;
		if (arxiv) return `https://arxiv.org/pdf/${arxiv.replace(/v\d+$/, "")}.pdf`;
		return undefined;
	} catch {
		return undefined;
	}
}

async function resolveByOpenAlex(doi: string): Promise<string | undefined> {
	try {
		const url = new URL("https://api.openalex.org/works");
		url.searchParams.set("filter", `doi:${doi}`);
		url.searchParams.set("per-page", "1");
		const r = await fetchWithRetry(url, { timeoutMs: 15000, init: { headers: { Accept: "application/json" } } });
		if (!r.ok) return undefined;
		const d = (await r.json()) as { results?: Array<Record<string, unknown>> };
		const w = d.results?.[0];
		if (!w) return undefined;
		const best = w.best_oa_location as Record<string, unknown> | undefined;
		const primary = w.primary_location as Record<string, unknown> | undefined;
		return (best?.pdf_url as string) || (primary?.pdf_url as string) || undefined;
	} catch {
		return undefined;
	}
}

// 统计
const sourceCounts = { unpaywall: 0, s2: 0, openalex: 0, any: 0 };
const resolved: Array<{ doi: string; title: string; source: string; url: string }> = [];
let i = 0;
for (const rec of noPdf) {
	i++;
	const doi = rec.identifiers?.doi;
	const up = await resolveByUnpaywall(doi);
	const s2 = await resolveByS2(doi);
	const oa = await resolveByOpenAlex(doi);
	const url = up || s2 || oa;
	const source = up ? "unpaywall" : s2 ? "semantic_scholar" : oa ? "openalex" : undefined;
	if (up) sourceCounts.unpaywall++;
	if (s2) sourceCounts.s2++;
	if (oa) sourceCounts.openalex++;
	if (url) {
		sourceCounts.any++;
		resolved.push({ doi, title: (rec.title || "").slice(0, 45), source: source!, url: url.slice(0, 70) });
	}
	if (i % 10 === 0) console.log(`  进度 ${i}/${noPdf.length}...`);
}

console.log("\n=== 结果 ===");
console.log(`无 PDF 且有 DOI: ${noPdf.length}`);
console.log(`能解析到下载链接: ${sourceCounts.any} (${((sourceCounts.any / noPdf.length) * 100).toFixed(0)}%)`);
console.log(`  Unpaywall: ${sourceCounts.unpaywall} | S2: ${sourceCounts.s2} | OpenAlex: ${sourceCounts.openalex}`);
console.log("\n解析到的论文:");
for (const item of resolved) console.log(`  ${item.source.padEnd(15)} ${item.title} -> ${item.url}`);
