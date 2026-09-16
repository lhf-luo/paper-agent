# 研究 Wiki

研究 Wiki 与调研笔记是两个独立仓库：

- `.paper-agent/notes/{namespace}/` 保存仍在整理的个人 Markdown 笔记。
- `.paper-agent/wiki/{namespace}/` 保存已主动沉淀的可复用知识页面。
- `.paper-agent/wiki/wiki.sqlite` 只保存可重建的页面、证据、claim、链接、分块和全文检索索引，不保存正文副本。

Markdown 是 Wiki 的唯一事实来源。学习、查询、lint 或外部编辑后，系统会先扫描 Markdown 并重建当前 namespace 的索引。

Paper Agent 启动、首次配置或执行安装命令时，会提前创建 `.paper-agent/wiki/{defaultNamespace}/` 和可重建的 `wiki.sqlite`，不需要先打开知识库页面。

每个 namespace 会预先建立以下 Wiki 结构：

```text
topics/
concepts/
methods/
systems/
datasets/
syntheses/
questions/
```

namespace 根目录还包含两个管理文件：

- `index.md`：由代码根据 Markdown 页面生成，按对象类型提供 Obsidian 导航。它不是证据，也不会参与 Wiki 查询或 lint。
- `log.md`：追加式记录 Wiki page 的创建、更新及其页面 ID。它不记录普通查询，也不会被索引成知识页面。

## 声明级证据

新页面使用 `evidence` frontmatter。每个稳定 claim 在正文使用 `[E1]` 引用，可同时使用 `[E1][E2][推断]`。论文证据至少需要 paper ID、PDF SHA-256 和物理页码；笔记证据需要 revision/hash；Artifact 证据需要论文 ID 和 commit、路径或 URL；公开资料需要最终 HTTP(S) URL。

旧页面仍可读取 `paper_ids` 和 `source_notes`，但会收到 `legacy-source-granularity` warning。再次沉淀时，Agent 应把旧式页面级来源升级为声明级证据。

## Agent 使用方式

在 Agent 对话中可以要求：

- “把这些论文的共同方法沉淀到 Wiki”进入 Ingest，先调用 `inspect_agent_tools` 查询实际可用工具，再提取证据、更新已有页面并生成批量预览。
- “查询 Wiki 中关于 UAF 检测的内容”进入 Query，只使用已沉淀页面和其中的声明级证据回答。
- “检查 Wiki”调用只读的 `lint_research_wiki`，报告 frontmatter、证据、来源版本、链接、重复页面和索引问题。

Ingest 不会在论文阅读或普通搜索后自动触发。多页面更新必须先 preview，再用同一个 `preview_fingerprint` apply；默认需要用户确认，关闭 Wiki 写入确认开关后由本地策略授权，仍须校验预览指纹。来源或页面在预览后变化时拒绝写入并要求重新预览。用户明确要求等待确认时，Agent 仍应遵守。

材料分工：

| 材料 | 主要用途 | 证据地位 |
| --- | --- | --- |
| PDF 正文、图表、公式 | 技术 claim 核验 | 一手论文证据 |
| 渲染页、区域、表格 | 视觉对象核验 | 原始 PDF 的检查方式 |
| MinerU | 章节、页码、关键词定位 | 派生导航材料 |
| Artifact 代码 | 实现、配置和复现核验 | 取得并检查后才是代码证据 |
| 调研笔记 | 工作综合和用户观点 | 工作来源或显式推断来源 |
| 官方公开页面 | 外部一手背景 | 公开资料证据 |

论文或笔记删除后 Wiki 页面不会被删除；lint 会报告 `missing-source`。来源更新后报告 `stale-source`，页面等待重新 preview。

## Web 知识库

Web 的“知识库”页面只读，用于浏览页面、查看来源和证据、查看 lint 问题、重建索引以及打开 Wiki 文件夹或 Obsidian。正文编辑仍通过 Agent 的批量 preview/apply 流程完成。

“Obsidian”按钮会先把当前 namespace 注册为 Obsidian vault（或复用已有注册项），再通过 vault ID 打开对应仓库，因此不会落到 Obsidian 的最近仓库，也不会要求再次选择文件夹。

第一版使用 SQLite FTS5 的页面元数据和正文分块检索。代码预留 `WikiSearchBackend`，未来可以在不改变 Markdown、证据和写入契约的前提下增加 QMD 等可选语义后端；当前不安装 QMD，也不依赖约 2GB 的本地模型。
