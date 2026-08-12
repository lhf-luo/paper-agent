# Paper Agent 接手问题记录

> 用途：记录接手/使用过程中遇到的问题、现象、根因与解决状态，持续追加。
> 每条问题包含：日期、现象、根因、涉及代码、状态、后续方向。

---

## 问题列表

| # | 日期 | 简述 | 状态 |
| --- | --- | --- | --- |
| 1 | 2026-08-12 | PDF 下载"成功"但无文件（元数据无 pdf 链接） | 已定位（设计如此） |
| 2 | 2026-08-12 | Agent 搜索结果保存到个人库报 "ids not present in the search result" | ✅ 已修复 |

---

## #1 PDF 下载任务显示成功，但 blobs/sha256 下没有 PDF 文件

- **日期**：2026-08-12
- **类别**：个人库 / PDF 下载

### 现象

在个人库中对一篇论文执行"下载 PDF"，任务中心显示 `succeeded`，但在
`.paper-agent/corpus/personal/default/blobs/sha256/` 目录下没有看到任何 PDF 文件。

### 排查过程

1. 查看任务记录（`jobs.sqlite` 的 `background_jobs` 表）发现任务结果：

   ```json
   {
     "downloaded": [],
     "failures": [{ "paperId": "doi-96f31f2bd85adb393bf7",
                    "reason": "no PDF link in provider metadata" }]
   }
   ```

2. 检查该论文记录 `records/doi-96f31f2bd85adb393bf7.json` 的 `links`：

   ```
   - kind: landing (期刊页)
   - kind: doi
   - kind: landing (openalex)
   【没有 kind: pdf 的链接】
   ```

### 根因

- 下载逻辑（`src/literature-download.ts`）只下载 `record.links` 中
  `kind === "pdf"` 的**显式链接**；没有则记录 per-record failure 并跳过。
- 该论文（清华学报）元数据只有 landing/doi 链接，无开放 PDF 链接。
- **任务 `succeeded` 是"部分失败"语义**：任务本身执行完毕（无异常），
  每篇记录的失败写进 `result.failures`，不算任务失败。
- 系统**不会**去爬 landing 页找 PDF（设计上不做爬虫式操作）。

### 涉及代码

- `src/literature-download.ts`：`pdfLink = record.links.find(kind === "pdf")`，失败记入 failures
- `src/literature-store.ts`：`putBlob()` → `blobs/sha256/<前2位>/<完整sha256>`
- 下载成功条件链：有 pdf 链接 → HTTP 请求成功 → 内容为真 PDF → 大小不超限 → 落盘

### 状态与结论

- **已定位，属设计行为而非 bug**。要能下载，需要记录里有 `kind: pdf` 链接
  （如 arXiv 论文天然带开放 PDF 链接）。
- 可尝试：用 Unpaywall provider（需配置 `UNPAYWALL_EMAIL`）补充开放获取 PDF 链接。

### 后续方向（待定）

- [ ] 改进 UI：任务成功但存在 per-record failures 时给出醒目提示（当前容易误解为下载成功）
- [ ] 评估是否允许"landing 页解析 PDF 链接"（需权衡爬虫边界与版权）
- [ ] 用一篇 arXiv 论文做一次成功下载的对照验证

---

## #2 Agent 搜索结果"保存到个人库"报错：One or more selected paper ids are not present in the search result

- **日期**：2026-08-12
- **类别**：搜索页 / 个人库导入（Agent 搜索结果联动功能）

### 现象

使用 Agent 对话搜索文献后，结果展示在搜索页，勾选论文点"保存到个人库"，
报错：`One or more selected paper ids are not present in the search result`。

### 根因

- 保存流程（前端 `prepareSave` / 后端 `recordsFromSearchJob`）只认**任务队列中的 job**
  （`searchJobId`），校验 `paperIds` 必须在 `job.result.run.results` 里。
- Agent 搜索产出的运行记录不在 job 队列，而在 `search-runs.jsonl`（journal）。
  前端展示 Agent 结果时仍把 `searchJobId`（当前 job，可能为空或不匹配）发给后端，
  校验自然失败。

### 修复

- `CorpusImportInput` 增加可选 `searchRunId`（与 `searchJobId` 二选一）。
- 新增 `recordsFromSearchRun`：从 `search-runs.jsonl` 找运行并按 paperIds 校验。
- `prepareCorpusImport` / `enqueueAuthorizedCorpusImport` / `corpus-import` 任务
  均支持两种来源。
- 前端：`selectedRun` 激活时发送 `searchRunId`，否则 `searchJobId`。
- 涉及代码：`src/paper-agent-application.ts`、`src/local-web-server.ts`、`web/src/App.tsx`

### 验证

`prepare → confirm → execute` 全流程通过，记录成功写入个人库
（`corpus-import` 任务 succeeded）。

### 状态

✅ 已修复（本地提交，未推送）
