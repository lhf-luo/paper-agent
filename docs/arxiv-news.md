# arXiv 最新资讯与通用检索

通用检索和资讯拉取分别实现，只有公共 HTTP、代理、重试、XML 与标识工具可以复用。

```text
collect_literature / search_literature / POST /api/search
  → collectLiterature → provider-arxiv（关键词、相关性排序）

POST /api/arxiv-news/pull
  → pullArxivNews → arxiv-news-source（分类、UTC 日期、提交时间排序）
```

## 通用检索

必须提供非空查询词。年份、作者、期刊、开放获取和论文类型仍是普通筛选条件；多个来源可以一起查询，查询扩展照常执行。`reuse_corpus`（HTTP 中为 `reuseCorpus`）决定是否复用已有个人库，结果统一按查询相关性排序。

例如，检索 2026 年 LLM 漏洞检测综述：

```json
{
  "query": "large language model vulnerability detection static analysis survey",
  "query_expansions": ["LLM static analysis vulnerability detection review"],
  "year_from": 2026,
  "year_to": 2026,
  "providers": ["arxiv", "openalex", "crossref", "semanticscholar", "dblp", "core", "exa", "usenix"],
  "mode": "once",
  "reuse_corpus": false
}
```

通用接口和工具不接受 arXiv 提交日期或分类参数。未声明的参数会明确报错；旧任务若包含已移除参数，需要重新发起。HTTP 搜索的筛选项位于 `filters` 中，使用 `yearFrom`、`yearTo` 等驼峰命名。

通用 arXiv 适配器使用 `all:<query>`，按相关性排序，单次请求超时 10 秒；offset 根据原始返回条数推进，不因本地筛选后条数减少而提前结束。

## 最新资讯

资讯页面继续使用现有接口、分类设置、批次和筛选。日期按 UTC 解释，开始日期包含，结束日期不包含；拉取器将日期区间逐天拆开，每页 100 条，按首次提交时间倒序获取，再校验日期并按归一化 arXiv ID 去重。

资讯专用请求超时为 60 秒，每次 HTTP 尝试（包括重试）遵守至少 3 秒的调度间隔，并复用公共重试及 `Retry-After` 处理。单日结果达到 arXiv 可查询上限且仍未拉完时，该日不保存为完整批次。

每个完整日期单独保存。取消、网络失败或超过上限时保留已完成日期，未完成日期不推进游标，可从下次起点继续。资讯论文使用独立的 `ArxivNewsPaper` 类型保存 `firstSubmittedAt`，列表继续展示首次提交日期。

资讯数据仍保存在 `.paper-agent/runtime/arxiv-news.sqlite`；拉取不创建 Search Run，也不自动加入个人库。主动选择入库时，只传递通用论文元数据。此次拆分不改写已有个人库、资讯批次、Search Run 或图谱。
