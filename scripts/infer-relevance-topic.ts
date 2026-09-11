/**
 * 用配置的模型(DeepSeek)为论文清单 md 里每篇论文推断 relevance(切题度) + topic(主题),
 * 并把结果写回 md 文件末尾的 paper-agent-sidebar-meta 注释。
 *
 * 用法: node scripts/infer-relevance-topic.ts <md文件路径> [batchSize]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { inferSidebarRelevance } from "../src/literature/application/sidebar-relevance.ts";

const target = process.argv[2];
const batchSize = Number(process.argv[3] ?? 8);
if (!target) {
	console.error("用法: node scripts/infer-relevance-topic.ts <md文件路径> [batchSize]");
	process.exit(1);
}

const raw = await readFile(target, "utf8");
const content = raw.replace(/<!--\s*paper-agent-sidebar-meta[\s\S]*?-->\s*$/, "").trimEnd();
const metaMatch = raw.match(/paper-agent-sidebar-meta ([\s\S]*?) -->/);
if (!metaMatch) {
	console.error("md 里没有 paper-agent-sidebar-meta, 先运行 regenerate-sidebar 或由 update_literature_sidebar 生成。");
	process.exit(1);
}
const meta = JSON.parse(metaMatch[1]) as { headers?: string[]; rows?: Array<Record<string, unknown>> };
const rows = meta.rows ?? [];
if (!rows.length) {
	console.error("rows 为空");
	process.exit(1);
}

console.log(`共 ${rows.length} 行, 分批 ${batchSize}, 开始推断...`);
const projectRoot = process.cwd();
const filled = await inferSidebarRelevance(projectRoot, rows, batchSize);
console.log(`本次补全 ${filled} 行(仅补缺 relevance/topic 的行)。`);

const newMeta = { headers: meta.headers ?? ["标题", "年份/venue", "标识", "focus"], rows };
const payload = `${content}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(newMeta)} -->\n`;
await mkdir(dirname(target), { recursive: true });
await writeFile(target, payload, "utf8");

const withRel = rows.filter((r) => r.relevance).length;
const withTopic = rows.filter((r) => r.topic).length;
console.log(`完成: relevance 命中 ${withRel}/${rows.length}, topic 命中 ${withTopic}/${rows.length}。已写回 ${target}`);
