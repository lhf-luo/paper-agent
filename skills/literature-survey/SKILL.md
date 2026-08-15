---
name: literature-survey
description: 按导师方法论文献调研：一句话定题、领域/问题/方法拆词、多轮迭代多源搜索、种子论文扩展、规则初筛，输出候选论文表。适用于"尽量不漏"的系统性文献检索、调研新方向、为论文找相关工作。调用 paper-agent 已有的搜索/语料/引用工具，不引入外部搜索服务。
---

# 文献调研（literature survey）

目标：**尽量不漏**地找到相关文献，并输出可追溯的候选论文表。搜索摘要和 AI 回答只能帮助发现论文，不能直接作为技术证据；关键结论必须打开一手来源。

## Route the request

1. **定题（一句话）**：明确研究对象、要解决的问题、应用场景和时间范围。说不清一句话，就先别搜。
2. **拆词**：把主题拆成 `领域词 + 问题词 + 方法词`，并补充中英文、缩写和同义词变体。
3. 确定本次调研是**一次性（once）**还是**可复用（persistent）**；默认 once + personal。
4. 按需阅读 [references/search-methodology.md](references/search-methodology.md)（多轮迭代方法与候选表模板）。
5. 先查已有语料，再决定搜什么：配置了团队服务用 `manage_team_literature_server` 搜共享库，否则用 `search_literature_corpus` 搜本地库；重复的略读卡/矩阵/证据图先查 `manage_literature_memory`。

## Execute

1. **首轮搜索**：用 `collect_literature`，覆盖 arXiv、OpenAlex、Crossref、Semantic Scholar、DBLP 等默认源，`queryExpansions` 传入拆词得到的中英/缩写/同义词变体，分页和条数保持有界。
2. **多轮迭代**：每轮审视结果覆盖度——
   - 新领域词/问题词/方法词组合换着搜（多轮搜索，不要一轮定生死）；
   - 某源无结果或结果异常时换源确认；
   - 直到"新轮次不再带来新相关论文"再停止；
   - 保留每轮的查询变体、来源、分页和失败记录（provenance）。
3. **种子扩展**：从结果中选 3-5 篇种子论文，用 `expand_citation_network` 沿参考文献、被引和相似论文扩展（深度保持有界，默认两层）。
4. **初筛**：按明确规则初筛（相关性、时间范围、类型），顶会或高水平期刊**只决定阅读优先级，不能代替相关性判断**。用 `manage_literature_corpus` 记录筛选状态（include/exclude/maybe）。
5. **输出候选论文表**：按下方模板整理（聊天中输出表格，可存入个人库并导出）。
6. **证据纪律**：搜索元数据是发现证据，不是 claim 证据；重要结论要求打开一手来源（`fetch_url` 验证最终 URL）。

## Handoff

汇报：

- 一句话研究问题、时间范围、纳入/排除规则；
- 拆词变体清单、执行过的每轮查询与来源、分页与日期；
- 每轮新增/合并/疑似重复数量，最终覆盖度判断；
- 种子论文与扩展的引用网络范围；
- 初筛结果（include/exclude/maybe 及理由），顶会优先级标注；
- 候选论文表（标题 | 作者 | 年份 | venue | DOI/arXiv | 来源 | 发现路径 | 初筛结果 | PDF | 代码）；
- 源失败、缺失 PDF/artifact、需要人工精读判断的点。

## 候选论文表模板

| 标题 | 作者 | 年份 | venue | DOI/arXiv | 来源 | 发现路径 | 初筛结果 | PDF | 代码 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 论文标题 | 第一作者等 | 2026 | 会议/期刊 | doi:... / arXiv:... | arxiv/openalex/... | 关键词搜索/引用扩展 | include/exclude/maybe | 有无链接 | 仓库URL |

- **发现路径**：该论文如何被找到（哪轮查询 / 哪篇种子的引用 / 相似论文），用于追溯"漏没漏"。
- **PDF/代码**：元数据中是否有开放 PDF 链接、代码仓库 URL（有则标注，无则"无"）。
- 初筛结果必须给理由，顶会只加优先级标记。

## 边界

- 数据源用 paper-agent 内置 provider（arXiv/OpenAlex/Crossref/S2/DBLP/PubMed/CORE/OpenCitations/Unpaywall/**Exa**）；
  Exa 通过 MCP 提供神经语义搜索（无需 API key），适合自然语言式的广撒网发现。
- 搜索只到"发现+初筛"；精读、gap 判断、实验评估由人负责。
