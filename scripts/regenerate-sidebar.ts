/**
 * 重新生成指定的论文清单 md: 从现有表格提取行, 用搜索 run 补全摘要,
 * 并把富化后的 rows 元数据写回文件末尾的 paper-agent-sidebar-meta 注释。
 *
 * 用法: node scripts/regenerate-sidebar.ts <md文件路径>
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { scrapeRowsFromMarkdown, enrichSidebarRows } from "../src/literature/presentation/collection-tools.ts";

const target = process.argv[2];
if (!target) {
	console.error("用法: node scripts/regenerate-sidebar.ts <md文件路径>");
	process.exit(1);
}

const cwd = process.cwd();
const raw = await readFile(target, "utf8");

// 去掉旧的 paper-agent-sidebar-meta 注释, 只保留正文表格。
const content = raw.replace(/<!--\s*paper-agent-sidebar-meta[\s\S]*?-->\s*$/, "").trimEnd();

const scraped = scrapeRowsFromMarkdown(content) ?? [];
const enriched = (await enrichSidebarRows(cwd, undefined, scraped)) ?? [];

const headers = ["标题", "年份/venue", "标识", "focus"];
const meta = { headers, rows: enriched };
const payload = `${content}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(meta)} -->\n`;

await mkdir(dirname(target), { recursive: true });
await writeFile(target, payload, { encoding: "utf8" });

const withAbstract = enriched.filter((row) => typeof row.abstract === "string").length;
const withoutAbstract = enriched.length - withAbstract;
console.log(`已重新生成: ${target}`);
console.log(`共 ${enriched.length} 行, 有摘要 ${withAbstract} 篇, 无摘要 ${withoutAbstract} 篇`);
