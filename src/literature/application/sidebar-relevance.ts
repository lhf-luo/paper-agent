/**
 * 为论文清单 rows 推断 relevance(切题度) + topic(主题)。
 * 使用拆分配置中的模型(如 DeepSeek)批量推断, 供 update_literature_sidebar 工具自动补全,
 * 也供 scripts/infer-relevance-topic.ts 复用。
 */
import { fetch, ProxyAgent } from "undici";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";

export interface SidebarRow {
	title?: string;
	abstract?: string;
	relevance?: string;
	topic?: string;
	[key: string]: unknown;
}

async function proxyUrlFor(projectRoot: string): Promise<string | undefined> {
	try {
		const cfg = await loadPaperAgentConfig(projectRoot);
		return cfg.network?.proxyEnabled && cfg.network.proxyUrl ? cfg.network.proxyUrl : undefined;
	} catch {
		return undefined;
	}
}

async function chat(
	projectRoot: string,
	dispatcher: ProxyAgent | undefined,
	messages: Array<{ role: string; content: string }>,
): Promise<string> {
	const cfg = await loadPaperAgentConfig(projectRoot);
	const model = cfg.model;
	if (!model?.apiKey || !model.baseUrl) throw new Error("No configured model with apiKey for relevance inference");
	const res = await fetch(`${model.baseUrl}/chat/completions`, {
		dispatcher,
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${model.apiKey}` },
		body: JSON.stringify({
			model: model.modelId,
			messages,
			temperature: 0,
			response_format: { type: "json_object" },
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
	return data.choices[0]?.message?.content ?? "";
}

function buildPrompt(batch: SidebarRow[]): Array<{ role: string; content: string }> {
	const items = batch
		.map((row, index) => {
			const label = `[${index}] ${row.title ?? ""}`;
			const abs = row.abstract ? ` 摘要: ${row.abstract.slice(0, 700)}` : " 摘要: (无)";
			return `${label}。${abs}`;
		})
		.join("\n\n");
	return [
		{
			role: "user",
			content:
				"你是论文筛选助手。下面列出若干篇论文(每条带可选摘要)。请为每篇输出两个字段(用中文):\n" +
				'- relevance(对摘要的总结+相关性判读): 用一段自然语言(约20-40字)概括这篇论文讲什么, 并指出它与你研究问题相关的角度。例如 "直接研究二进制程序漏洞检测, 适合了解反编译伪代码与序列模型方法。"。不要用 "高/中/低" 这样的等级词。\n' +
				'- topic(主题): 1-3 个技术关键词, 用分号分隔, 例如 "机器学习;反编译代码"。\n' +
				'只返回 JSON, 格式为 {"items":[{"index":0,"relevance":"一段中文总结","topic":"机器学习;反编译代码"}, ...]}。' +
				"index 用我给出的编号, 不要遗漏任何一篇。\n\n" +
				"论文列表:\n" +
				items,
		},
	];
}

/**
 * 为缺 relevance/topic 的行推断并原地补全。
 * 返回补全的行数; 失败时静默返回 0(不阻断工具主流程)。
 */
export async function inferSidebarRelevance(
	projectRoot: string,
	rows: SidebarRow[] | undefined,
	batchSize = 8,
): Promise<number> {
	if (!rows?.length) return 0;
	const missing = rows.filter((row) => typeof row.relevance !== "string" || typeof row.topic !== "string");
	if (!missing.length) return 0;
	const proxy = await proxyUrlFor(projectRoot);
	const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
	let filled = 0;
	for (let offset = 0; offset < rows.length; offset += batchSize) {
		const batch = rows.slice(offset, offset + batchSize);
		try {
			const text = await chat(projectRoot, dispatcher, buildPrompt(batch));
			const parsed = JSON.parse(text) as { items?: Array<{ index: number; relevance?: string; topic?: string }> };
			for (const item of parsed.items ?? []) {
				const row = rows[offset + item.index];
				if (!row) continue;
				if (item.relevance && typeof row.relevance !== "string") row.relevance = item.relevance;
				if (item.topic && typeof row.topic !== "string") row.topic = item.topic;
				if (item.relevance || item.topic) filled++;
			}
		} catch {
			// 单批失败不阻断: 保留已有字段, 继续下一批。
		}
	}
	return filled;
}
