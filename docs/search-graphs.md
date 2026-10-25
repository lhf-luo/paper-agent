# 搜索图谱的起点与引文网络

一个图谱对应一个 Search Run。图谱管理、整个图谱的画布节点、论文列表和按需摘要继续沿用原入口。候选论文不会自动入库，也不会被拆成画布论文节点。

## 引用扩展结果

`expand_citation_network` 返回 `expansionRunId`、`seedPaperIds`、`seedCount`、`neighborCount` 和 `resultCount`。结果按输入起点顺序排列，再接邻居；通过 DOI、arXiv、提供商 ID 和已确认的合并 ID 去重，保留起点 ID。年份及邻居配额不排除起点。零邻居或提供商失败仍保存真实起点，失败与截断分别报告。扩展表以“起点论文”标识起点，不构造自引。

历史结果通过 seedSnapshots（缺失时读取仍存在的个人库起点）生成兼容投影，不改写原 Search Run 或筛选指纹。筛选命中与上下文起点分别计数。关键词、作者检索不虚构起点。

## 关系与覆盖

引用箭头方向是引用方 → 被引用方。文献耦合比较共享参考文献，共被引比较共享施引论文。图外 ID 只作为证据，不成为新节点。同作者、同年份和同批次不构成关联。

版本 `citation-idf-1` 使用倒排索引、IDF 加权余弦：`idf(t)=log((N+1)/(df(t)+1))`。每通道至少需要两项正权重共享证据；所有已观测论文共有的证据权重为零。两通道均可计算时使用 0.6/0.4 权重，否则使用单个可计算通道，另一通道显示未知。关联阈值 0.12；真实引用始终保留。

所有证据保存在独立 SQLite 表 `canvas_search_graph_features`，含采集来源、时间、完整/部分/缺失状态、分页游标、错误、请求尝试和计算指纹。完整查询返回空集合与尚未读取不同。不同提供商未能可靠匹配的图外 ID 保持分离，覆盖仍可能不完整。

右侧详情的“引文关系依据”按需读取共享 ID、分项分数、来源与覆盖。分数不代表方法相似或结论已核验。

## 主动补全

图谱管理中先点击“补全关系”查看提供商、完整缓存、待补数量、身份未解析和采集上限，再确认执行。优先 OpenAlex ID，否则通过 Semantic Scholar ID / DOI / arXiv 解析；复用项目代理与 Semantic Scholar 凭据、OpenAlex 联系邮箱，支持环境变量 OPENALEX_API_KEY。

每轮最多 100 次 HTTP 尝试，重试也计数；参考和施引集合分别最多保存 500 个 ID。先轮询首批，再继续分页。遵守 Retry-After；较长限流保存期限并结束本轮，之后可继续。取消保留已取得集合和分页检查点；恢复或下一轮不重复抓取完整集合。任务与进度使用现有 `/api/jobs` 和 `/api/events`。不会自动增加展示论文或改写 Search Run。

## 布局

最大生成森林保留骨架，再优先真实引用、每个节点最强六条关联，默认最多绘制 1200 条边。选择节点时补显隐藏邻边。完整关系依据仍保存。

独立 Worker 内固定随机源执行 360 次 d3-force 迭代后停止。分量独立布局并确定性打包，起点分量优先居中，孤点保留。采用实际 SVG 容器尺寸、40px 适配留白、被引数对数半径、固定年份渐变和屏幕空间标签避让。

筛选、打开摘要、选择节点不重新模拟。拖动位置会固定供下一次自动布局使用。旧坐标与视口继续使用；“应用新布局”才升级布局，保存前一份坐标/视口，可“恢复上次布局”。普通、全屏与窄窗口使用相同组件。

## HTTP

- GET `/api/canvases/:id/search-graphs/:runId`：轻量节点、起点标识、稀疏边、完整关系分数、覆盖、算法版本、输入指纹与视图状态。
- GET `.../:runId/papers/:paperId`：按需摘要与覆盖。
- GET `.../:runId/evidence?edgeId=...`：一条关系的证据详情。
- GET `.../:runId/enrich`：补全预检与最近任务。
- POST `.../:runId/enrich`：`{budget:100}`；返回后台任务，重复启动复用当前任务。
- POST `.../:runId/layout` / `.../:runId/restore-layout`：应用或恢复布局；不改变画布内容版本。
- PATCH `.../:runId/state`：带 revision 的视图保存。

复制画布复制图谱特征及布局，不复制任务；删除画布只清理专属图谱记录，不删除 Search Run 或个人论文。


## 浏览器作者扩展

Google Scholar 作者主页可通过已配置的浏览器 MCP 采集。`stage_browser_literature` 支持 `year_from` / `year_to`，识别主页 user ID，保存为 `author-expansion`，随后可用 `show_search_run_graph`。无需个人库种子。网页出版年份缺失时单独报告，不推测匹配时间范围；被引数不当作作者论文总数。详见 [浏览器 MCP](browser-mcp.md)。


## 无需 Agent 的扩展入口

对画布中已入个人库的论文右键，选择“生成引用图谱”或“生成作者图谱”。图谱管理仅用于浏览和管理已有图谱，不提供创建入口。

填写方向/作者、可选年份范围和数量上限，点击“开始扩展并生成图谱”。引用扩展固定一层、最多三页、最多 100 篇邻居；作者扩展按提供商各最多 100 篇。留空年份表示不限。请求直接交给后台任务，不创建 Agent 会话、不调用模型。完成后保存 Search Run 并打开图谱。关闭面板不停止任务，进度与取消也可从任务调度中心操作。部分来源失败仍展示已取得结果及错误；取消尚未完成的查询不自动发布图谱。

POST `/api/canvases/:id/expansions` 输入 `paperId`、`kind: citation|author`、`requestId`，可选 `direction: references|citations|both`、`authorName`、`yearFrom`、`yearTo`、`limit`。返回 202 后台任务；任务结果包含 `searchRunId`、`resultCount`、`failures`、`graphOpened`。`requestId` 用于请求重试去重，同一标识不能复用于不同参数。

网页和 `expand_citation_network` 共用 `literature-citation-expansion` 应用服务，作者 API 与 `find_author_papers` 共用 `collectAuthorPapers`。图谱关系计算、布局和渲染沿用原实现。Google Scholar 采集仍由 Agent 使用浏览器 MCP 完成。
