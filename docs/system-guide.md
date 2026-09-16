# Paper Agent 系统指南

> 本文描述当前源码版本的系统定位、运行架构、工具能力、配置拆分、数据存储和安全边界。
> 更新日期：2026-09-12。

相关文档：[命令手册](command-manual.md) | [模型配置](model-configuration.md) | [Web 界面](web-interface.md) | [研究流程](research-workflow.md)

## 1. 系统定位

Paper Agent 是一个以证据、来源和可追溯性为核心的论文研究工作区。系统负责检索、整理、PDF 分析、公开 Artifact 获取、个人文献库和团队知识库协作；研究结论、实验判断和创新评价仍由用户负责。

典型工作流：

```text
规划检索 -> 多源收集 -> 筛选并保存 -> 获取 PDF/Artifact
         -> 精读文本与图表 -> 组织卡片、矩阵和证据 -> 人工判断
```

系统提供两个主要入口：

| 入口 | 启动命令 | 用途 |
| --- | --- | --- |
| Web 工作区 | `paper-agent` | 搜索、个人库、Agent 对话、PDF 工作台、任务中心、团队库和研究工作区 |
| Pi 终端 | `paper-agent agent` | 使用 `/paper`、`/collect`、`/library`、`/team` 进行对话式研究 |

## 2. 运行架构

```text
paper-agent CLI
  |
  +-- Web 工作区
  |     +-- 本地 loopback HTTP 服务
  |     +-- PaperAgentApplication
  |     +-- Web Agent 会话与任务队列
  |     +-- Browser Connector 本地捕捉接口
  |
  +-- Pi 终端
        +-- Paper Agent 扩展
        +-- Slash Commands
        +-- Agent 工具调用

应用与 Agent 共用
  +-- 42 个注册工具
  +-- 文献 Provider 层
  +-- Poppler PDF 工具链
  +-- 个人语料库与研究工作区
  +-- 可选团队知识服务
```

扩展从 `src/SYSTEM.md` 加载系统提示词；根目录同名文件不是该入口的运行时提示词。当前内置 `literature-corpus-manager`、`paper-research`、`research-wiki` 三个 Skill，工具清单以运行时注册表及生成的 [Agent 工具文档](agent-tools.md) 为准。

职责边界：

- Agent 层负责拆解任务、选择工具和组织结果。
- 工具层负责确定性的读取、检索、校验和写入。
- Provider 层负责外部文献元数据与开放获取信息。
- 存储层负责版本、来源、审计记录和后台任务状态。

## 3. 核心能力

### 文献检索与资料库

- 先查已有个人库或团队库，再按需访问外部 Provider。
- 支持检索规划、查询扩展、分页、过滤、去重和部分失败报告。
- 搜索结果默认是候选材料；只有显式保存后才进入个人库。
- 个人记录进入团队库必须经过提案和审核，私人笔记不会自动共享。

### PDF 与图表分析

Poppler、Tesseract、PDF2zh Next 等外部工具可以安装在任意目录。通用命令目录配置在 `.paper-agent/config/app.json` 的 `externalTools.commandDirectories`，或使用环境变量 `PAPER_AGENT_EXTERNAL_TOOL_PATHS` 覆盖；未配置时直接使用系统 `PATH`。Poppler 应填写包含 `pdftotext`、`pdfinfo`、`pdftoppm` 和 `pdfimages` 的目录，Tesseract 应填写包含 `tesseract` 的目录。Paper Agent 不扫描磁盘、不复制这些工具，也不管理它们的安装和升级。

```json
{
  "externalTools": {
    "commandDirectories": [
      "D:\\Tools\\poppler\\Library\\bin",
      "D:\\Tools\\tesseract"
    ]
  }
}
```

个人库阅读工作台可使用 PDF2zh Next 生成中英双语 PDF。Paper Agent 不安装或管理 PDF2zh Next，只调用用户已经安装的 `pdf2zh_next` 命令并读取输出。命令按 `PAPER_AGENT_PDF2ZH_COMMAND`、`.paper-agent/config/app.json` 中的 `pdfTranslation.command`、`PATH` 中的 `pdf2zh_next` 依次解析；配置值只能是单个命令名或可执行文件路径，不包含额外参数，也不会通过 Shell 执行。

首次使用前自行安装 PDF2zh Next。例如，可将它安装到任意独立虚拟环境，无需在运行 Paper Agent 前激活：

```powershell
python -m venv D:\AI-Tools\pdf2zh-env
D:\AI-Tools\pdf2zh-env\Scripts\python.exe -m pip install pdf2zh-next
```

随后在设置页将“PDF2zh Next 命令”填写为 `D:\AI-Tools\pdf2zh-env\Scripts\pdf2zh_next.exe`。也可以使用 Conda、pipx 或系统 Python 安装，只要命令位于 `PATH`，设置项即可留空。

PDF2zh Next 是可选外部命令，找不到时只禁用翻译功能，Paper Agent 的其他能力不受影响。PDF2zh Next 自行管理内部配置和缓存；Paper Agent 只为单次任务创建系统临时输出目录，并在成功、失败、取消或超时后清理。设置页可选择无需个人密钥的 `SiliconFlowFree`（默认），或单独指定一个 OpenAI Completions 兼容的 Paper Agent 模型。模型密钥只通过子进程环境变量传递，不写入任务参数、命令行或译文版本元数据；选择 `siliconflowfree` 时不读取 Paper Agent 模型密钥。译文作为 `translation` PDF 版本保存到原论文，不覆盖原文，也不会成为 Zotero 导出的首选 PDF。

- 读取指定物理页并保留页码标记。
- 渲染整页、检查文字块坐标、裁剪图表区域。
- 索引 figure、table、algorithm 和 listing。
- 表格可重建为 Markdown/CSV，但原始裁剪图像仍是校验依据。

### 浏览器论文捕捉

- `browser-extension/` 提供可直接加载到 Chrome/Edge 的 Connector。
- 监听 Chrome/Edge 完成的 PDF 下载，不重新请求论文 URL。
- 下载完成后通过本地 PDF 解析与 SQLite 原子导入流程进入当前默认 namespace，不调用模型。
- 确认导入成功后会删除浏览器下载目录中的原始 PDF；导入失败时保留原文件，服务关闭期间的下载不会离线排队。
- Connector 只连接 `127.0.0.1:43127`，Paper Agent 关闭后不可用，也不会离线排队。

### MinerU 论文解析材料

个人库中已有本地 PDF 的论文可以按需生成 MinerU Precision v4 解析材料。入口位于 PDF 阅读器工具栏和个人库详情栏；Agent 可调用 `generate_mineru_material` 生成材料，再用 `read_mineru_material` 按目录、物理页或关键词读取。默认使用 `https://mineru.net/api/v4`、`vlm` 模型和英文文档语言，API Key 保存在 `.paper-agent/config/credentials.json` 的 `mineruApiKey` 字段。

材料保存在 `.paper-agent/files/personal/<namespace>/<paperId>/mineru/`，与 PDF 和 `artifacts/` 同级。目录只保留规范化的 `full.md`、`content_list.json`、可选的 `content_list_v2.json` 和 `layout.json`、`images/`，以及 Paper Agent 生成的 `manifest.json`。MinerU 返回的 UUID 原名文件、模型中间结果和原始 PDF 副本不会重复保存；SQLite 的 `pdf_materials` 只记录当前成功版本。重新生成先写入临时目录，全部校验成功后才替换旧材料。生成中的远端批次 ID 复用后台任务 checkpoint，不创建单独的状态表。

系统优先调用电脑已有的 `unzip` 解包，缺少时回退到 `tar`；两者都不存在时仅禁用 MinerU，不影响其他功能。MinerU 内容属于派生材料，关键论断、公式和表格仍应使用原始 PDF 工具复核。

### Artifact 与复现材料

- 从 PDF URL 注释和正文中发现代码、数据集、补充材料与项目页。
- 仅获取公开 HTTPS 文件或浅克隆 Git 仓库。
- 记录最终 URL、重定向、提交、哈希、许可提示和失败原因。
- 获取后的代码不会被自动执行，也不会自动解压。

### 调研笔记与团队协作

- 使用可分层的 Markdown 笔记记录略读、精读和比较材料；正文和真实目录保存在 `.paper-agent/notes/{namespace}/`，SQLite 保存目录树、索引、修订和论文关系。
- 一篇笔记可关联零篇或多篇个人库论文，删除论文只解除关联，不删除笔记。
- `paper-research` 支持在用户明确要求创建笔记或保存研究结果时，读取当前模板并调用 `manage_research_note` 保存填写后的 Markdown；普通阅读请求只在对话中报告，写入遵守现有确认策略。
- 略读、精读和比较矩阵模板位于 `.paper-agent/templates/research-notes/`，初始内容随 `.agents/skills/paper-research/assets/research-notes/` 分发。原有空模板会补齐，已有内容的模板和历史笔记保留。
- 团队服务支持搜索、提案、审核、审计、令牌管理和备份。
- 本地单人团队演示仅监听 loopback，不等同于生产部署。

## 4. 工具清单

工具清单由运行时注册表生成，完整说明见 [Agent 工具清单](agent-tools.md)。Agent 在执行 Wiki 沉淀或选择可选材料工具前，应先调用 `inspect_agent_tools` 查询当前会话实际注册的工具、参数和使用要求，不能根据静态文档猜测工具名。

主要能力组包括：

- 文献检索、个人库/团队库搜索、论文包与 PDF 下载；
- PDF 文本、页面渲染、布局、区域、表格和图表索引；
- MinerU 材料生成与定向读取；
- Artifact 发现、获取和本地检查；
- 调研笔记、研究 Wiki、论文覆盖审计；
- Zotero、侧栏和团队知识库操作。

## 5. 文献 Provider

| Provider | 主要用途 | 凭据 |
| --- | --- | --- |
| arXiv | 预印本和开放 PDF | 不需要 |
| OpenAlex | 学术图谱、引用和开放获取信息 | 可选联系邮箱 |
| Crossref | DOI 注册元数据 | 可选礼貌池邮箱 |
| Semantic Scholar | 论文和引用图 | API key 可选 |
| DBLP | 计算机领域会议与期刊 | 不需要 |
| CORE | 开放获取聚合 | 通常需要 API key |
| OpenCitations | DOI 引用关系 | 不需要 |
| Unpaywall | 开放获取位置 | 需要联系邮箱 |
| Exa | 语义网页与学术搜索 | API key 可选 |

外部检索元数据用于发现和筛选，不自动等同于论文结论的证据。技术结论应回到论文、官方文档或其他一手来源核验。

## 6. 配置系统

系统只读取 `.paper-agent/config/` 下的拆分配置，不读取旧的 `.paper-agent/config.json`。

| 文件 | 内容 |
| --- | --- |
| `app.json` | 版本、Web 端口、是否自动打开浏览器、存储路径、默认 namespace 和操作确认策略；Connector 默认使用端口 `43127` |
| `search.json` | 默认 Provider、每源数量、分页、查询扩展和本地库复用策略 |
| `models.json` | 当前模型，以及按 Provider 分组的 Pi 风格模型能力元数据 |
| `auth.json` | 按模型 Provider 分组的 API key 或环境变量引用 |
| `network.json` | 代理开关、代理 URL 和直连域名 |
| `credentials.json` | 文献 Provider API key、联系邮箱和 Zotero 本地写授权 |

每个文件直接包含自己的字段，不再使用同名外层包装。例如 `search.json` 应直接写 `providers`，而不是 `{ "search": { ... } }`。

团队连接不属于拆分配置。用户在设置页粘贴 `pateam1.` 编码接入串并通过 CA、健康状态、身份和 namespace 校验后，系统才会原子写入 Git 忽略的 `.paper-agent/team-access.json`；不要让 Agent 直接读取该凭据文件来检查连接状态。

示例文件位于仓库的 `config.example/`。首次配置可运行：

```powershell
paper-agent init
paper-agent models add
```

`models add` 会询问 Base URL 和 API key，访问兼容端点的 `/models`，分别写入 `.paper-agent/config/models.json` 和 `.paper-agent/config/auth.json`。新模型的推理配置默认开启，已有声明会保留；活动模型在 Agent 对话页面自行选择。新添加和重新发现的模型默认标记为 `text + image` 输入，这只是声明，可用 `models probe-image --model <provider/model>` 实际验证。使用 `models remove --model <provider/model>` 删除单个模型，或使用 `models remove --provider <provider>` 删除整个 Provider；不再使用的 Provider 凭据会同步删除。项目目录下的 `.paper-agent/` 已被 Git 忽略，但仍应限制本机文件访问权限，不要在日志、截图或提交中暴露密钥。

可用 `PAPER_AGENT_CONFIG_DIR` 将整个拆分配置目录指向其他绝对或相对位置。只有测试或本地演示需要改用其他接入文件位置时，才使用 `PAPER_AGENT_TEAM_ACCESS_FILE`。

## 7. 数据存储

默认运行数据位于项目的 `.paper-agent/`，其中配置中的 `dataRoot` 或 `corpusRoot` 可以改变部分存储根目录。

```text
.paper-agent/
|-- config/                         拆分配置
|-- corpus/personal.sqlite          个人论文、检索、调研及论文专属 Agent 会话
|-- files/personal/<namespace>/
|   `-- <paperId>/
|       |-- <论文标题>.pdf          首选正式版本
|       |-- <论文标题> [preprint].pdf 等其他版本
|       `-- artifacts/
|           |-- artifact-manifest.json
|           |-- <Git 项目名>/       浅克隆的论文仓库
|           `-- downloads/          数据集、补充材料和其他文件
|-- corpus/legacy-backups/          从旧 JSON 存储迁移前生成的只读备份
|-- runtime/jobs.sqlite             持久化后台任务
|-- audit/operations.jsonl          写操作审计
|-- wiki/{namespace}/              研究 Wiki Markdown 仓库
|-- wiki/wiki.sqlite               可由 Wiki Markdown 重建的搜索索引
`-- web-agent-memory/               普通 Web Agent 会话及 Pi 运行时上下文
```

个人库只使用一个 `personal.sqlite`，由 `namespace_id` 隔离不同空间。PDF 二进制不写入数据库，而是按 namespace 和论文 ID 保存为可读文件名；`stored_files` 与 `paper_versions` 记录文件路径、版本关系、大小和 SHA-256。SHA-256 只用于完整性校验和精确重复检测，不再出现在正常文件名中。

PDF 阅读工作台中的论文助手支持为同一篇论文创建多个持续会话。会话、消息和工具调用保存在 `personal.sqlite`，按 `namespace + paper_id` 查询，不出现在主 Agent 页；Pi JSONL 仅作为模型运行时上下文。删除会话会同步清理其运行时文件，删除论文会级联删除该论文的全部会话、消息、工具调用和运行时文件。

### Zotero 双向导入

个人库“导入”菜单可从本机 Zotero 读取论文；“导出”卡片选择 `Zotero` 可将已勾选论文写入 Zotero。两个方向都会保留完整分类祖先路径和多重分类归属，每次只复制一个首选 PDF，不同步删除，也不传输个人笔记、筛选状态、调研正文或 Artifact。

Zotero 必须正在运行，并在“设置 → 高级”中启用“允许其他应用与 Zotero 通信”。读取不需要密钥；首次写入会由 Zotero 弹出授权对话框，建议选择“始终允许”。授权密钥与 Server ID 保存在 Git 已忽略的 `.paper-agent/config/credentials.json`，界面和日志只展示连接状态。

Artifact 不再增加“论文标题 + PDF SHA”目录层。Git 仓库直接以远程项目名保存在所属论文的 `artifacts/` 下，并使用 `--depth 1 --filter=blob:none --single-branch --no-tags` 浅克隆；`fetch_url` 只验证公开网页，不负责 Git 仓库下载。Windows 用户应启用全局 `git config --global core.longpaths true`。

标题中的 Windows 非法字符和保留名称会被安全处理，长标题会按完整路径预算截断。论文标题更新时，系统会同步重命名其 PDF；若文件操作失败，会保留原文件、记录 `file_operations` 并向调用方返回警告。

首次打开旧个人库时，系统会自动读取原 `records/`、`paper-versions/`、`blobs/sha256/`、分类、搜索记录和派生结果，写入 SQLite，并把 PDF 硬链接或复制到可读目录。验证完成前，旧目录和 `corpus/legacy-backups/` 中的备份均不会自动删除。

完整表结构和字段说明见 [Personal SQLite 数据库表说明](personal-sqlite-schema.md)。

文件名以 `.tmp` 结尾的普通会话视图通常是原子写入过程中的临时文件，不应加入 Git。若没有正在运行的 Paper Agent 进程但临时文件长期残留，可在确认目标路径后再清理。

## 8. 安全边界

- Web 服务只监听 loopback，本地工作区和 API 不要求会话 token；团队服务独立使用身份凭据认证。
- 关键写操作执行 `prepare -> fingerprint -> one-time grant -> execute` 完整性流程；“设置与诊断”中的操作确认开关只控制是否展示人工确认，关闭后由本地策略签发同样的一次性授权。
- 可选的 Pi 内置工具由 `app.json` 的 `agent.builtinTools` 白名单控制；未配置或为空时禁用，`config.example/app.json` 则显式启用了七个内置工具。启用 `bash`、`edit`、`write` 等高信任工具后，其文件和命令操作不经过 Paper Agent 的操作确认卡片，不能把上述门控描述为覆盖所有内置工具。
- Agent 普通写入和 Web 个人库普通操作默认不询问；个人库删除、调研区、研究 Wiki、PDF 与 Artifact 默认询问。团队、令牌、备份恢复、配置、模型探测和系统文件操作始终询问。
- 私网地址、携带凭据的 URL、重定向到私网的下载会被拒绝。
- 下载和 Git 获取都有大小、超时和范围限制，获取内容不会自动执行。
- Web 页面临时输入的模型 key 只保存在当前服务进程内；`models add` 保存的 key 位于 Git 忽略的本地拆分配置中。
- 个人笔记、筛选意见和凭据不会自动进入团队库。

## 9. 项目 Skill

项目级 Skill 统一放在 `.agents/skills/<skill-name>/`，每个目录必须包含 `SKILL.md`，并保留其 `scripts`、`references`、`assets` 和 `agents` 等配套目录。Web Agent 和本地启动脚本会扫描整个 `.agents/skills` 目录；新增或移动 Skill 后重启服务或新建会话即可生效，无需修改 Skill 固定名单。

`research-wiki` Skill 管理独立于调研笔记的长期知识层。Wiki 正文位于 `.paper-agent/wiki/{namespace}/`，使用声明级证据和批量 preview/apply；`wiki.sqlite` 只是可由 Markdown 重建的页面、证据、claim、链接和分块检索索引。详细约束见 [研究 Wiki](research-wiki.md)。

## 10. 运维入口

常用检查命令：

```powershell
paper-agent --status
paper-agent --doctor
paper-agent --verify quick
```

完整命令、参数、退出行为和 Pi 内命令见 [Paper Agent 命令手册](command-manual.md)。
