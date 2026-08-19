# Paper Agent 系统说明

> 本文档覆盖：系统架构、全部工具、Skills、Web 界面、配置文件。
> 更新日期：2026-08-15（含 Exa 数据源、CCF 分级、BibTeX 导出、会话持久化、Python 下载等新增能力）

---

## 一、系统概览

Paper Agent 是一个**以证据和可追溯性为中心**的论文调研工作区。AI 负责搜索、整理、记忆、证据关联；**深度理解、实验判断和 Idea 由人负责**。

### 核心流程

```
文献搜索 → 获取一手 PDF 与公开 Artifact → 略读筛选 → 精读方法/图表/实验
→ 组织可复用证据与知识库 → 人做实验判断、创新评估和 Idea
```

### 两种使用入口

| 入口 | 说明 |
| --- | --- |
| **Web 工作区**（`paper-agent`） | 图形界面：搜索/个人库/Agent对话/PDF工作台/团队库/研究工作区 |
| **Pi 终端**（`paper-agent agent`） | 对话式：`/paper`、`/collect`、`/library`、`/team` 命令 |

### 架构分层

```
Pi 终端 / Web Agent 对话（AI 决策层）
  ↓ 调用
22 个注册工具（确定性代码执行层，无 LLM）
  ↓
Provider 层（10 个数据源） + Poppler 工具链 + 个人库/团队服务
```

---

## 二、全部工具清单（22 个）

### 文献搜索（8 个）

| 工具 | 描述 |
| --- | --- |
| `collect_literature` | 系统化搜集：先查已有库，再跨 arXiv/OpenAlex/Crossref/S2/DBLP/PubMed/CORE/OpenCitations/Unpaywall/**Exa** 多源搜索，含查询扩展、过滤、分页、去重、部分失败报告、可选中持久化与 provenance |
| `search_literature` | 兼容性快速搜索（arXiv/OpenAlex/Crossref），DOI/arXiv/标题去重 + 部分源失败报告 |
| `search_literature_corpus` | 只搜本地/团队已有语料（无网络、无写入），支持标题/摘要/作者/venue/标签/年份/筛选状态 |
| `expand_citation_network` | 从已存 OpenAlex 记录扩展参考文献/被引/相似论文（有界、保留 provenance） |
| `download_literature_pdfs` | 批量下载选中的开放 PDF 链接到内容寻址库；arXiv 走 Python 通道（防反爬），重定向再校验、私网拒绝 |
| `import_literature_corpus` | 导入本地 PDF（单个/目录）、BibTeX、JSON 导出到个人库；PDF 文件本体同时入 blob 并记录版本 |
| `manage_literature_corpus` | 审计/导出/标注/审核个人库，或显式提案个人记录到团队库（单向、保真） |
| `manage_literature_memory` | 按"输入哈希+工具/模型/配置版本"查/记派生结果（略读卡等），精确命中直接复用 |

### PDF 分析（7 个）

| 工具 | 描述 |
| --- | --- |
| `read_pdf` | 提取指定页文本（默认 1-4 页，可逐页覆盖全文），带页码标记 |
| `render_pdf_page` | 渲染物理页为 PNG，用于图表/公式/扫描文本的视觉核验 |
| `inspect_pdf_layout` | 查看 PDF 块/行/词的精确左上角坐标（PDF points），定位图表/caption/公式 |
| `list_paper_assets` | 索引带 caption 的 figure/table/algorithm/listing，估算布局感知裁剪区域，关联正文 mention/节/页码 |
| `extract_pdf_region` | 裁剪精确 PDF 区域为 PNG 并返回其中的文本层（整图/公式/图例/caption 核验） |
| `extract_pdf_table` | 裁剪表格区域并重建为 Markdown/CSV（行列是启发式，图像为准） |
| `evaluate_pdf_asset_detection` | 用本地 gold 标注 JSON 评测图表检测的 precision/recall/crop IoU |

### Artifact（3 个）

| 工具 | 描述 |
| --- | --- |
| `discover_paper_artifacts` | 从 PDF URL 注释 + 提取文本发现代码仓库/数据集/补充材料/项目页（只读，报告页码与置信度） |
| `acquire_paper_artifacts` | 安全获取候选：HTTPS 文件下载或浅克隆 Git（无子模块/LFS），记录最终 URL/hash/commit/license/失败 |
| `inspect_paper_artifacts` | 盘点 PDF 旁的本地文件与仓库（不改动），报告 remote/commit/脏状态 |

### 研究与证据（2 个）

| 工具 | 描述 |
| --- | --- |
| `fetch_url` | 抓取公开 HTTP(S) 一手来源（HTML→文本、JSON/XML 直返、PDF 存临时文件） |
| `paper_progress` | 审计当前会话：PDF 页覆盖、资产索引、对象级核验、artifact、文献搜索失败披露 |

### 团队库（1 个）

| 工具 | 描述 |
| --- | --- |
| `manage_team_literature_server` | 搜索中央团队库、提案（自动隐私剥离）、审核、审计、管理员备份 |

### 引用/导出（1 个）

| 工具 | 描述 |
| --- | --- |
| `export_bibtex` | 导出个人库论文为 BibTeX：优先 CrossRef DOI 内容协商，失败回退元数据生成 |

### 内部（1 个）

| 工具 | 描述 |
| --- | --- |
| `paper_agent_probe` | 模型工具调用能力探测（诊断用，不可直接调用） |

---

## 三、数据源（10 个 Provider）

| Provider | 说明 | 需要 Key |
| --- | --- | --- |
| arXiv | 预印本 + 开放 PDF | 否 |
| OpenAlex | 学术图谱 + 引文（2.4 亿+） | 否 |
| Crossref | DOI 注册元数据 | 否 |
| Semantic Scholar | ML/AI 论文 + 引文图 | 可选（S2_API_KEY / config.credentials） |
| DBLP | 计算机科学会议/期刊 | 否 |
| PubMed | 生物医学（NCBI E-utilities） | 可选 |
| CORE | 开放获取聚合 | **必须**（CORE_API_KEY） |
| OpenCitations | DOI 引文元数据 | 否 |
| Unpaywall | 开放获取定位（需邮箱） | 必须邮箱 |
| **Exa** | 神经语义全网/学术搜索（MCP，匿名可用，可配 EXA_API_KEY） | 可选 |

---

## 四、Skills（2 个）

| Skill | 用途 |
| --- | --- |
| **literature-corpus-manager** | 文献语料管理手册：搜集/去重/获取/个人-团队/once-persistent 规则；先查库再搜集、下载要确认、个人笔记不进团队 |
| **literature-survey**（新增） | 导师方法论文献调研：一句话定题 → 领域/问题/方法拆词 → 多轮迭代多源搜索 → 种子扩展 → 规则初筛 → 候选论文表（含 CCF 优先级） |

Skill 机制：`name+description` 常驻上下文，全文按需加载（渐进式披露），references 更深层按需读。

---

## 五、Web 界面说明（9 个页面）

| 页面 | 功能 |
| --- | --- |
| **总览（Dashboard）** | 个人库论文数、运行中任务、各工作区入口 |
| **搜索论文** | 选 Provider（含 Exa）、填查询/过滤/每源上限/页数、后台任务、结果表格（CCF 徽章）、勾选保存到个人库；可查看 Agent 对话产生的搜索记录 |
| **Agent 对话** | 流式对话、工具卡片、确认弹窗、任务模板（搜集/分析/导入/查询/比较/Artifact/团队）；模型从 config.json 选择 |
| **个人库** | 搜索/筛选记录、私人标签/笔记/筛选状态、导出、下载选中 PDF、版本查看 |
| **任务中心** | 长任务列表：暂停/继续/取消/重试/删除（终态可删，运行中需先取消） |
| **PDF 与 Artifact 工作台** | 按标题下拉选个人库 PDF（或手动输路径）→ 图表分析/发现 Artifact/获取 Artifact，人工校正裁剪框 |
| **团队知识库** | 搜索共享记录、提案/审核、审计、token 管理、备份 |
| **研究工作区** | 略读卡/比较矩阵/证据图（human 与 ai-assisted 分离、原文 locator） |
| **设置与诊断** | 配置模型端点（环境变量名）、路径、Provider、团队服务环境变量名、doctor |

---

## 六、配置文件（.paper-agent/config.json）

```json
{
  "interface": { "port": 0, "openBrowser": true },
  "storage": { "defaultNamespace": "default" },
  "search": { "providers": ["arxiv","openalex","crossref","semanticscholar"], "maxResultsPerProvider": 20, "pagesPerProvider": 1 },
  "model": { "providerId": "deepseek", "modelId": "deepseek-v4-flash", "api": "openai-completions", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "..." },
  "models": [ /* 多模型列表, Web Agent 页下拉选用 */ ],
  "credentials": { "exaApiKey": "...", "coreApiKey": "...", "semanticScholarApiKey": "...", "unpaywallEmail": "..." },
  "network": { "proxyEnabled": true, "proxyUrl": "http://192.168.206.50:7890" },
  "team": { "serverUrl": "http://127.0.0.1:4317", "namespace": "lab", "token": "..." }
}
```

优先级规则：**调用参数 > config.json > 环境变量**。

---

## 七、数据存储布局

```
.paper-agent/
├── corpus/personal/<namespace>/
│   ├── records/<id>.json        ← 论文元数据
│   ├── paper-versions/<id>.json ← PDF 下载版本记录(blobPath 指向本体)
│   ├── blobs/sha256/<2>/<hash>  ← PDF 文件本体(内容寻址)
│   ├── search-runs/<id>.json    ← 搜索运行记录
│   ├── index/literature.sqlite  ← 检索索引
│   └── manifest.json            ← 库清单
├── runtime/jobs.sqlite          ← 任务队列(永久保存, 可手动删除终态)
├── audit/operations.jsonl       ← 写操作审计(追加式)
└── web-agent-memory/            ← Web Agent 会话持久化(pi-sessions + session-views)
```

---

## 八、安全与信任模型

- 本地 Web 服务仅 loopback + 临时会话 token
- 所有写操作走 `prepare → fingerprint → 确认 → 一次性授权 → 执行` 闸门
- 密钥只存 config.json（0600 + gitignored）或环境变量，不进仓库
- 下载：公网 HTTPS-only、私网拒绝、大小/超时/重定向有界、浅克隆、不执行获取的代码
- 搜索元数据是发现证据，不是 claim 证据；技术结论必须回到一手来源
