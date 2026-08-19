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

## #3 PDF 下载仍失败：arXiv 反爬挑战 + 直连不稳定

- **日期**：2026-08-12
- **类别**：个人库 / PDF 下载 / 网络代理

### 现象

为 arXiv 论文（元数据含 `kind: pdf` 链接）执行下载，任务 succeeded 但
`downloaded: []`，失败 reason 为空字符串。

### 排查过程（完整）

1. 失败 reason 为空：`downloadLiteraturePdfs` 的 catch 取 `error.message`，
   而底层抛的是 **AggregateError（空 message）**。
2. 解包 AggregateError：`errors[]` 为 `connect ETIMEDOUT 151.101.x.x:80`
   与 `ECONNREFUSED`——**arXiv 的 Fastly CDN IP 在这台机器上直连不通**
   （项目下载链路是"DNS 解析 → 固定 IP 直连"，SSRF 防护设计）。
3. 配置代理（`network.proxy`，本次新增功能）后：
   - 其他站点（Semantic Scholar 等）走代理正常 ✅
   - arXiv 通过代理返回 **JS 挑战页**（`<!DOCTYPE html>`，反爬），
     `%PDF-` 校验失败 → "response is not a PDF"。
   - 同代理下 curl 能拿到真 PDF → 是 **Node TLS 指纹**被 arXiv 反爬识别，
     与代理本身无关。
4. 直连偶尔成功（单次 fetch 能拿 `%PDF-`），并发下载时又 ETIMEDOUT——网络不稳定。

### 结论

- 代理功能已实现且对其他站点生效；**arXiv 是特殊案例**：
  直连不稳定 + 代理路径触发反爬挑战（Node 指纹）。
- 这是外部网络/反爬问题，项目侧无代码缺陷。

### 后续方向（待定）

- [x] 改进失败信息：catch 到 AggregateError 时展示 `errors[0].message`（✅ 2026-08-13 已实现）
- [ ] 评估下载重试策略：直连失败后自动切换代理（或反之）
- [ ] arXiv 反爬挑战可能需要真实浏览器指纹/headless，超出项目范围，谨慎评估
- [ ] 用户侧尝试：校园网直连、浏览器手动下载、或更换网络环境

### 关联

- 新增功能：`config.json` 的 `network.proxy`（`src/network-security.ts` setProxyUrl /
  `fetchPinnedUrl` 代理路由：http 绝对形式 / https CONNECT 隧道；
  `scripts/web-server.ts` 启动时应用）

## #4 arXiv 下载"成功但0文件"：间歇性网络，非代码缺陷（更新）

- **日期**：2026-08-12
- **类别**：网络 / PDF 下载

### 追加实测（2026-08-12 晚）

用户关代理后用浏览器直测 `https://arxiv.org/pdf/1001.2665v1.pdf`：
浏览器重定向到无后缀网页版（疑似 arXiv 反爬 interstitial 或瞬时失败）。

本机对照测试（多次重复）：

| 测试 | 结果 |
| --- | --- |
| curl 直连 .pdf ×3 | ✅ 200 application/pdf ~1.2s |
| curl 直连另一篇 | ✅ 200 application/pdf |
| curl 走代理 arXiv | ✅ 200 application/pdf（偶发 SSL 错误） |
| 项目 fetchPublicUrl 直连 | 时而 1.7s ✅ / 时而 30-68s 超时 ❌ |
| DNS 解析 | 仅 IPv4（151.101.x.x Fastly），无 IPv6 干扰 |

### 最终结论

- **网络到 arXiv Fastly CDN 间歇性不可达**：同一时段 curl/浏览器/项目路径
  三者都会间歇失败，不是项目代码缺陷。
- 失败原因恒为 `AggregateError`（空 message），内部 errors 为
  `connect ETIMEDOUT 151.101.x.x:80`。
- **真正的代码改进点**：下载失败信息是空字符串（AggregateError 没有取
  `errors[0].message`），误导排查。见 #3 后续方向第 1 条。

### 待讨论方案（用户确认后实施）

- [ ] 失败信息改进：catch AggregateError 时取 `errors[0].message`
- [ ] 自动重试回退：直连失败自动切代理 / 反之
- [ ] 下载超时/重试参数调优（当前 30s×2 次）
- [ ] 接受现实：该网络访问 arXiv 不稳定，浏览器手动下载兜底

## #5 方案A 已实施：下载快速失败 + IP 轮换

- **日期**：2026-08-13
- **状态**：✅ 已实现

### 改动（src/network-security.ts）

1. 连接阶段 socket 超时 10s（Node 的 request.setTimeout 只覆盖连接后，
   改用 socket 事件设置，让 TCP 连接阶段也能快速失败）
2. 每次重试打乱解析出的 IP 顺序（避免 3 次都卡在同一个不可达 IP）
3. fetchPublicUrl 总超时 30s → 20s

### 实测

- 全 IP 不可达的最坏情况：78s → 43s（3 次 × 10s + 重试开销）
- 失败原因可读：`connect timeout after 10000ms`
- 调试确认 socket 超时确实触发（`socket timeout FIRED` ×3）

### 待讨论

- [ ] 方案 B（同一次请求并行探测多个 IP，Happy Eyeballs 式）可进一步提速
