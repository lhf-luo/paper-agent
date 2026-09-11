# ssh文献调研最佳实践

# 文献调研最佳实践

> 核心流程：**文献搜索 → 获取原文与 artifact → 略读 → 精读 → 实验 → 形成 idea**。

## 1\. 文献搜索

先用一句话明确研究对象、问题、场景和时间范围，再开始检索。

1. 将关键词拆成“领域词 \+ 问题词 \+ 方法词”，补充中英文、缩写和同义词。

2. 同时使用领域数据库、Google Scholar、Semantic Scholar、OpenAlex、arXiv 等来源。

3. 找到 3 至 5 篇种子论文后，沿参考文献、被引论文、作者主页和相似论文扩展。

4. AI 可用于扩展检索式、整理元数据、去重和按明确规则初筛。

5. 顶会或高水平期刊只决定阅读优先级，不能代替相关性判断。

输出候选论文表：

```Plaintext
标题 | 作者 | 年份 | venue | DOI/arXiv | 来源 | 发现路径 | 初筛结果 | PDF | 代码
```

搜索阶段的目标是尽量不漏。搜索摘要和 AI 回答只能帮助发现论文，不能直接作为技术证据。

## 2\. 获取原文与 artifact

每篇论文应形成一个可追踪的材料包（pdf、arxiv、artifact）

- 优先获取正式版，同时保留 arXiv 版并记录版本关系；

- 收集作者代码、数据、配置、补充材料和项目主页；

- 记录代码仓库 URL、commit、release、许可证和获取时间；

- 优先用 DOI 去重，没有 DOI 时组合题名、作者和年份判断；

- 用 Zotero、CSV、SQLite 或自建系统维护本地论文数据库；

- 让脚本负责元数据拉取、文件命名、版本关联、去重和引用扩展。

本地数据库至少保存：

```Plaintext
paper_id | 元数据 | 版本 | PDF | artifact | 发现来源 | 筛选状态 | 阅读状态 | 更新时间
```

自动化 todo：使用 Crossref、OpenAlex、Semantic Scholar 等 API；本地建立论文数据库；写脚本爬。（更新 2026-08-30：这三项 paper-agent 已内建为 `collect_literature` 多源采集、个人 corpus 论文数据库和 `expand_citation_network` 引用扩展，对照见第 6 节。）

## 3\. 读论文

### 3\.1 略读：判断 research gap 与创新点

略读标题、摘要、引言、方法概览、主要结果、局限和结论，回答：

1. 它解决什么具体问题？

2. 现有方法为什么不够？

3. 它提出了什么核心机制？

4. 哪个实验最直接支持该机制？

5. 它留下了什么边界？

输出简短阅读卡：

```Plaintext
问题 | research gap | 核心创新 | 关键证据 | 主要局限 | 精读/保留/排除
```

AI 可以生成初稿，但 gap 和创新点必须回到原文确认。作者声称的 novelty 也可能只是换模型、换数据或扩大规模。

### 3\.2 精读：找问题

精读不是重新总结论文，而是检查“问题 → 方法 → 实验 → 结论”的链条是否成立：

- 问题、场景、威胁模型和适用边界是否清楚；

- 哪个核心假设最脆弱，失效后会破坏什么结论；

- 论文方法与代码实现是否一致，论文artifacts与论文宣称需求是否一致；

- 数据是否代表真实场景，baseline 和预算是否公平；

- 指标是否真正测量目标，数字是否包含单位、误差和条件；

- 消融和反例是否排除了其他解释；

- 代码、数据、参数和环境是否足以复现。

所有重要结论都标记来源：

```Plaintext
[论文] 页码、图、表或公式
[代码] commit 与文件位置
[公开资料] 作者项目页或正式文档
[推断] 依据哪些证据推导
[未知] 材料未报告，不能自行补全
```

### 3\.3 实验：弹性选择深度

不是每篇论文都要完整复现。根据重要性和研究目标选择实验深度：

|层级|目标|
|---|---|
|L0 配置核验|对齐代码、数据、参数、commit 和命令|
|L1 运行验证|跑通官方示例或最小数据|
|L2 核心复现|复现一项核心结果或消融|
|L3 反例实验|改变关键假设、数据分布、预算或威胁模型|
|L4 自动化复现|AI 批量搭环境、执行、解析日志并统一比较|

AI 自动化复现可处理环境识别、依赖安装、配置抽取、命令生成、日志解析和结果对比，但必须：

- 保存环境、commit、配置、随机种子、输出和错误日志；

- 不允许静默修改数据、指标或失败条件；

- 结果不一致时先检查版本和设置，不让 AI 编造原因；

- 优先验证一个核心机制，而不是盲目复现整张主表。

实验最终要回答：**核心结论在什么条件下成立，又在什么条件下开始失效？**

## 4\. 形成 idea 与创新点

idea 应从精读和实验发现的问题出发：

```Plaintext
已有结论
→ 关键假设
→ 未覆盖或失效的真实条件
→ 新研究问题
→ 与现有方法本质不同的机制
→ 最小可证伪实验
```

一个值得继续的 idea 应满足：

1. 问题真实，不是为了使用某个模型而制造；

2. gap 来自论文、代码或实验，而不是“似乎没人做”；

3. 改变了问题定义、观测信号、关键假设或系统边界；

4. 能用一个小实验判断核心假设是否错误；

5. 一周内可以完成最小验证，失败也能得到明确结论。

只换 backbone、扩大数据、增加 loss、拼接两个模块或无条件迁移数据集，通常不构成足够强的创新。

每个候选 idea 只需记录：

```Plaintext
现有证据 | 发现的问题 | 最脆弱假设 | 新机制 | 本质差异 | 最小实验 | 成败判据
```

## 5\. 组内讨论的工具与 Skill

|环节|工具或 Skill|主要用途|
|---|---|---|
|搜索|Elicit、Consensus、ResearchRabbit<br>|语义检索、相关工作发现和初步归纳|
|搜索|[citation\-assistant](https://github.com/ZhangNy301/citation-assistant)<br>|调用 Semantic Scholar API 检索论文并获取作者、venue 等信息|
|搜索|`security-se-lit-review`|面向安全/软件工程，按 venue 和年份从 DBLP、会议目录等来源检索|
|搜索与归档|`Research Superpowers`<br>|从种子论文出发，做前向/后向引文扩展、开放全文获取和去重归档|
|跨站补充|[Exa MCP](https://mcp.exa.ai/mcp)<br>|语义网页搜索、抓取已知页面，补充传统数据库之外的材料|
|引文图谱|Connected Papers、Litmaps<br>|查看相似论文、前后继工作和研究脉络；图谱结果仍需回原文核对|
|元数据|Semantic Scholar API、OpenAlex、Crossref|批量获取题名、作者、年份、DOI、引用关系并辅助去重|
|文献管理|Zotero 及同步、翻译、GPT、Style 类插件|管理元数据、PDF、笔记、引用和格式|
|PDF 处理|arXiv HTML、ar5iv、MinerU|将论文转为更适合检索和 Agent 阅读的 HTML/Markdown|
|本地分析|Codex、Claude Code 等本地 Agent<br>|读取论文文本、代码与配置，生成结构化阅读卡和比较表|
|深度精读|[paper\-agent](https://github.com/A6y55/paper-agent)<br>|核验完整 PDF、图表、代码 artifact 与公开资料，建立可审计证据链|
|知识组织|[LLM Wiki](https://lmspl3ndid.github.io/LLM-wiki)|拆分文献概念、建立索引和知识关系，辅助跨论文综合|

推荐组合：

- **收集：** `Research Superpowers + Exa MCP` 扩大覆盖；安全/软件工程主题可加 `security-se-lit-review`。

- **入库：** `citation-assistant/开放 API + Zotero + 本地 CSV/SQLite`，同时保存来源与版本。

- **阅读：** `arXiv HTML/ar5iv/MinerU + 本地 Agent`；关键论文再用 `paper-agent` 深度核验。

- **综合：** 比较矩阵作为事实底座，Litmaps/Connected Papers 和 LLM Wiki 用于发现关系。

这些工具负责发现、转换和组织，不能代替人工判断；平台配额、接口和可用性以实际使用时为准。

## 6\. paper-agent 内建能力对照（2026-08-30）

上表中的外部工具不少能力已在组内的 paper-agent 落地（本组主仓库：`github.com/jiankwm/paper_agent`，基于 pi agent 框架的 extension 架构，23 个 agent 工具 + 2 个 skill）。逐一对照后，可以优先用内建路径，外部工具只做补充：

|环节|本文档提到的外部工具|paper-agent 内建等价物|状态|
|---|---|---|---|
|搜索|Elicit、Consensus、citation\-assistant、`security-se-lit-review`|`search_literature`（快速发现）与 `collect_literature`（多来源分页采集、去重、断点续搜）；provider：arXiv、Semantic Scholar、OpenAlex、Crossref、DBLP、ACL Anthology、USENIX；AI/CSEC/软件安全领域 preset 含顶会清单|已内建|
|引文扩展|`Research Superpowers`（前向/后向引文）|`expand_citation_network`（基于 OpenAlex）|已内建|
|全文获取与归档|`Research Superpowers`、citation\-assistant|`download_literature_pdfs`（并发受限下载，按题名生成 `download/<题名>/` 工作区，artifact 自动落在论文旁）；blob 按 SHA-256 内容寻址，天然去重|已内建|
|本地数据库|Zotero、CSV、SQLite|个人 corpus（records/papers/derived/exports + 全文检索 `search_literature_corpus`）；`import_literature_corpus` 支持 BibTeX/JSON/PDF 批量导入|已内建；Zotero 经 BibTeX 导入打通|
|元数据与去重|Semantic Scholar API、OpenAlex、Crossref|同名 providers + 标识符去重（DOI 优先，题名/作者/年份组合）|已内建|
|PDF 处理|arXiv HTML、ar5iv、MinerU|pdftotext 布局解析 + 扫描件 OCR 增强（文本层优先路线）；`parse_pdf_layout_mineru` 云端复杂版式解析（`PAPER_AGENT_MINERU_API_KEY` 门控，Web 设置页可配置 key 环境变量名与中转站 Base URL；2026-08-31 真实 key 端到端验证通过：提交/轮询/结果包公式表格图片完整重建）|已内建并真实验证；注意传带版本号的规范 PDF URL（裸 arXiv id 曾在服务端读取失败）|
|本地分析|Codex、Claude Code|pi agent 本体 + `paper-research` skill（按自然语言目标渐进决定阅读深度）|已内建|
|深度精读与图表核验|paper\-agent|本项目即此工具：`list_paper_assets`（caption 检测 + 正文 mention 坐标映射）、`extract_pdf_region`/`extract_pdf_table` 对象级核验、Web 端人工裁剪修正并按论文 SHA-256 回灌；104 Gold 固定评测集把关|已内建；旋转/扫描/出版社版式等复杂版式指标未达标（knownGaps 显式登记）|
|artifact 获取|—|`discover_paper_artifacts`（PDF 注释 + 正文链接提取，GitHub/Zenodo/OSF/HuggingFace 等白名单）→ `acquire_paper_artifacts`（shallow clone、hash 校验、不执行不解压）|已内建；ACM badges/artifact evaluator 徽章链接解析未实现|
|会议论文集|按 venue 检索|`collect_conference_proceedings`（NDSS、ACL Anthology 12 个 NLP 会议；DBLP 后端的 CCS 1996+、IEEE S&P 2020+、USENIX Security 1993+）|已内建；S&P 2020 前的年份 DBLP venue 命名不可达，走通用检索 provider|
|知识组织|LLM Wiki|研究工作区三类记录（略读卡/比较矩阵/证据图，`docs/research-workspace.md`）+ 分析缓存复用（`manage_literature_memory` 按材料 hash 复用，避免重复分析）|部分内建|
|团队共享|—|个人库与团队库分离（scope personal/team），个人→团队仅能显式提议并经审核，团队服务带 RBAC/token/备份|已内建；真实多人 HTTPS 部署待验收|

**仍需外部工具的环节**（2026-08-30 更新：Consensus 语义检索已经 pi-mcp-adapter 桥接入 agent——安装 `pi install npm:pi-mcp-adapter` 后重启，首次调用走 OAuth 授权即可，Elicit 因组内网络不可达暂缓）：Zotero（组内现有的管理与同步习惯，经 BibTeX 与 corpus 互通，本地桥已接入）；Connected Papers/Litmaps（引文图谱可视化，内建只有数据没有图）；Exa MCP（数据库之外的站外语义搜索）；MinerU（复杂版式论文解析；ar5iv HTML 读取已内建为 read_paper_html 工具）；LLM Wiki（概念级知识组织方法论）。

**证据标注对照**：本文档 §3.2 与 paper-agent `src/SYSTEM.md` 统一使用 `[论文] [代码] [公开资料] [推断] [未知]`；缺失材料不得由模型猜测补齐。

**流程对照**：本文档的六段核心流程在 paper-research skill 中展开为 8 个子任务契约（搜索与复用 → 获取一手材料 → 略读筛选 → 精读与图表核验 → 跨论文比较 → artifact 审计 → 复现计划 → 人工 idea gate）；literature-corpus-manager skill 再补 11 阶段的采集与库管理契约。精读、实验决策与 idea 判断保留给人，与本文档 §3、§4 的人工边界一致。



