import type { PaperLink, ProviderPage } from "../domain/literature-types.ts";
import {
	LiteratureProviderHttpError,
	type ProviderSearchOptions,
	passesFilters,
	providerCredentials,
	withId,
} from "./provider-common.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

async function exaMCPCall(method: string, params: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			// 可选: 设置 EXA_API_KEY 环境变量走自有配额; 未设置则匿名(配额较低)
			...((providerCredentials.exaApiKey ?? process.env.EXA_API_KEY)
				? { "x-api-key": providerCredentials.exaApiKey ?? process.env.EXA_API_KEY }
				: {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal,
	});
	if (!response.ok) throw new LiteratureProviderHttpError("Exa", response);
	const raw = await response.text();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data: ")) continue;
		try {
			const payload = JSON.parse(line.slice(6)) as {
				result?: Record<string, unknown>;
				error?: { message?: string };
			};
			if (payload.error) throw new Error(`Exa MCP error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
			if (payload.result !== undefined) return payload.result;
		} catch (error) {
			if (error instanceof SyntaxError) continue; // 跳过非 JSON 的 SSE 行
			throw error;
		}
	}
	throw new Error("Exa MCP returned no result");
}

function parseExaResults(
	text: string,
): Array<{ title: string; url: string; published?: string; author?: string; highlights?: string }> {
	const chunks = text.split(/\r?\n(?=Title: )/);
	const results: Array<{ title: string; url: string; published?: string; author?: string; highlights?: string }> = [];
	for (const chunk of chunks) {
		const title = /^Title: (.*)$/m.exec(chunk)?.[1]?.trim();
		const url = /^URL: (.*)$/m.exec(chunk)?.[1]?.trim();
		if (!title || !url) continue;
		if (!/^https?:\/\//i.test(url)) continue;
		const published = /^Published: (.*)$/m.exec(chunk)?.[1]?.trim();
		const author = /^Author: (.*)$/m.exec(chunk)?.[1]?.trim();
		const highlights = chunk
			.split(/^Highlights:/m)[1]
			?.trim()
			.slice(0, 2_000);
		results.push({
			title,
			url,
			...(published && published !== "N/A" ? { published } : {}),
			...(author && author !== "N/A" ? { author } : {}),
			...(highlights ? { highlights } : {}),
		});
	}
	return results;
}

export async function searchExaPage(options: ProviderSearchOptions): Promise<ProviderPage> {
	try {
		await exaMCPCall(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "paper-agent", version: "0.2" },
			},
			options.signal,
		);
	} catch {
		// 部分部署无需 initialize; 失败忽略, 后续 tools/call 会暴露真实错误。
	}
	const numResults = Math.min(Math.max(options.limit, 1), 10);
	const result = await exaMCPCall(
		"tools/call",
		{
			name: "web_search_exa",
			arguments: { query: options.query, numResults },
		},
		options.signal,
	);
	const content = result.content;
	const text = Array.isArray(content)
		? content
				.map((entry) =>
					entry && typeof entry === "object" ? String((entry as { text?: unknown }).text ?? "") : "",
				)
				.join("\n")
		: "";
	const retrievedAt = new Date().toISOString();
	const records = parseExaResults(text)
		.map((entry) => {
			const year = entry.published ? Number.parseInt(entry.published.slice(0, 4), 10) : undefined;
			const links: PaperLink[] = [{ url: entry.url, kind: "landing" }];
			// arXiv URL(abs/html/pdf) → 生成可下载的 pdf 链接(kind: pdf), 让下载流程可用
			const arxivMatch =
				/(?:arxiv\.org\/(?:abs|html|pdf)\/|export\.arxiv\.org\/pdf\/)(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(entry.url);
			if (arxivMatch) {
				links[0].openAccess = true;
				links.push({
					url: `https://arxiv.org/pdf/${arxivMatch[1]}.pdf`,
					kind: "pdf",
					openAccess: true,
				});
			} else if (entry.url.endsWith(".pdf") || entry.url.includes(".pdf?")) {
				links[0].openAccess = true;
				links.push({ url: entry.url, kind: "pdf", openAccess: true });
			}
			return withId({
				title: entry.title,
				...(entry.highlights ? { abstract: entry.highlights } : {}),
				authors: entry.author ? [entry.author] : [],
				...(Number.isInteger(year) && year ? { year } : {}),
				publicationType: "unknown",
				identifiers: {},
				links,
				provenance: [
					{
						provider: "exa",
						query: options.query,
						retrievedAt,
						providerRecordId: entry.url,
						rawUrl: entry.url,
					},
				],
				mergedFrom: [],
			});
		})
		.filter((record) => passesFilters(record, options.filters));
	return {
		provider: "exa",
		query: options.query,
		records,
		nextCursor: undefined,
		requestUrl: EXA_MCP_URL,
	};
}
