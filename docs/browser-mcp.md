# 浏览器与 MCP

Paper Agent 网页会话使用官方 MCP TypeScript SDK 连接本地 stdio 服务，再把服务工具注册为 Pi 扩展工具。通用、论文阅读和画布会话均支持。配置保存在项目 `.paper-agent/config/mcp.json`，独立于 Pi 终端和 Codex 的配置。

## 连接 Playwright Chrome 扩展

1. 在 Chrome 安装官方 Playwright MCP 扩展并打开要访问的网页。
2. 打开 Paper Agent「系统设置 → 浏览器与 MCP」，点击「添加 Playwright」并保存。
3. 点击「测试连接」。它启动 MCP 子进程、握手并读取完整工具列表，随后关闭测试连接；不会访问网页。
4. 在 Agent 会话中要求使用浏览器。确认工具调用后，Chrome 扩展会提示选择并授权标签页。由用户完成选择，不需要手动常驻运行 npx 命令。

快捷配置：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--extension"],
      "disabled": false,
      "timeoutMs": 120000
    }
  }
}
```

Windows 下应用直接使用 Node 执行 npm/npx 的 JS 入口，避免 cmd 包装进程。运行 Paper Agent 的 Node 安装需要包含 npm；也可以填写 MCP 可执行文件的绝对路径。首次启动可能需要联网下载软件包。

## 工具与权限

- 工具名称通常为 `mcp__playwright__browser_navigate` 等，特殊或过长名称会规范化并附哈希。使用 `inspect_agent_tools` 查询本次会话实际注册的名称和参数。
- 每个网页 Agent 会话持有独立 MCP 连接。Playwright 扩展负责各客户端的标签页授权与隔离。
- MCP 工具调用沿用「确认后执行／自动」权限设置。自动模式不代替 Chrome 扩展自身的首次连接授权。
- 停止任务会向 MCP SDK 传递取消信号；取消是否能停止已经产生的网页动作取决于服务实现。删除会话、结束一次性上下文或关闭应用时关闭对应连接。
- 「断开」不会中断正在运行的工具；先停止或等待该任务。后续新消息会重新连接。
- 保存配置后，新轮次重新加载工具；当前运行不重新注册工具，已修改或停用的服务会拒绝后续调用。排队消息属于原运行。
- 连接失败会显示服务错误并让其他 Agent 能力继续工作，下轮消息可以重试连接。环境变量值不返回设置接口；错误信息会清除配置中的环境变量值。

当前版本支持 `command`、`args`、`env`、`disabled`、`timeoutMs`，只连接本地 stdio，不支持 HTTP/SSE 服务、资源订阅或 MCP prompts。密钥放在 `env`，不要放入命令参数；设置页的 `********` 表示保留已有值。项目配置文件包含原始环境变量值，不应提交到 Git。

## 作者论文 → Search Run → 侧边栏

示例任务：

> 用浏览器打开这个 Google Scholar 作者主页，逐页收集实际可见的论文元数据。保存为 Search Run，并按我的研究方向筛选后显示在论文侧边栏。先不要加入个人库。遇到验证码时停止并报告已获取范围。

Agent 通过浏览器工具读取页面，再调用 `stage_browser_literature`：

- 记录网页来源、标题、作者、年份以及实际取得的摘要、DOI、链接、引用数。
- 每批最多 500 条；使用 `append_to_search_run_id` 将后续页面追加到同来源的批次，复用既有去重规则。
- 默认覆盖状态为部分结果。遍历完成后才报告 `complete=true`，并可用 `expected_count` 核对数量；报告的完整性不代表系统独立验证了网站的全量数据。
- 候选保存在个人 SQLite 的 Search Run 中，沿用完整保留策略。不会自动创建个人库论文、下载 PDF 或保存登录凭据。
- 使用现有 `filter_search_run_results` → `update_literature_sidebar` 生成表格，用户选择后才通过既有确认流程入库。追加页面会使旧的筛选快照失效，应在采集完成后重新筛选。

Google Scholar 页面可能限制自动访问或出现验证码。连接浏览器不保证能够取得作者全部论文，更不保证能获取全文；不要绕过验证码或访问限制。

官方说明：[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Chrome 扩展连接](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)。


## Google Scholar 作者论文与画布图谱

在画布 Agent 中可直接发送：

> 打开 https://scholar.google.com/citations?user=NuzUkMEAAAAJ&hl=zh-CN ，通过浏览器 MCP 获取该作者 2024–2026 年的论文，保存为作者 Search Run 并展示图谱。

年份仅为示例；未指定时间时不添加年份限制。Agent 使用当前已连接的浏览器，读取主页真实作者名，按年份排序、翻页/显示更多，然后调用 `stage_browser_literature`：

- `source_url`：实际访问的作者主页，`label`：页面显示的作者名。
- `year_from` / `year_to`：含边界的出版年份范围。
- `records`：实际读到的标题、作者、年份、论文详情链接，可选摘要、DOI、被引数。
- `append_to_search_run_id`：后续页追加到同一批次，年份范围保持一致；不同语言或排序的同一 Scholar user 主页可追加。
- `complete`、`expected_count`、`note`：说明实际遍历范围；expected_count 是读到的论文列表数量，不是被引次数。验证码、访问拒绝和分页不完整必须报告部分覆盖。

返回包含 `searchRunId`、`resultCount`、`authorExpansion`、`yearRange`、`observedCount`、`excludedYearCount`、`unknownYearCount`。年份缺失的记录在有时间限制时不视为命中，并使覆盖保持部分状态。仅保存候选 Search Run，不写个人库。主页 user ID 保留为作者来源身份，不依靠同名匹配。

画布中随后调用 `show_search_run_graph`。这是作者图谱，不需要个人库起点；作者归属本身不产生引用或相似连线。普通关键词检索默认显示普通搜索结果，仅在用户明确要求时生成图谱。Google Scholar 可能阻止自动访问，浏览器 MCP 也不能保证绕过该限制；遇到验证码时由用户正常处理后再继续。
