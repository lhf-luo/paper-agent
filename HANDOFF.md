# Paper Agent 开发交接说明

## 1. 交付快照

| 项目 | 内容 |
| --- | --- |
| 交付日期 | 2026-08-07 |
| 项目版本 | `0.1.0`，源码开发版，尚未发布到 npm |
| 原工作分支 | `feat/artifact-discovery-acquisition` |
| 原仓库 HEAD | `47c6db7fa55be728aa68201e676c48ea4241f607` |
| 快照性质 | 当前工作区源码快照，包含尚未提交的修改和新增文件，不等同于上述 HEAD |
| 核心入口 | 本地 Web 工作区；高级用户可使用原始 Pi 终端 |

重要：本交付版必须作为一个新的开发基线保存。原工作区在打包时有大量未提交修改和未跟踪文件，因此只重新 clone 原远程仓库或只 checkout 上述 commit，会缺少 Web Agent、团队知识库、Artifact 评测等本次新增功能。

## 2. 项目目标

Paper Agent 是一个以证据和可追溯性为中心的论文调研工作区，围绕以下流程组织能力：

```text
文献搜索
  -> 获取一手 PDF 与公开 Artifact
  -> 略读和筛选
  -> 精读方法、图表、实验和实现
  -> 组织可复用证据与知识库
  -> 由研究者完成实验判断、创新性评估和 Idea
```

AI 的主要职责是搜索、整理、记忆、证据关联和模式匹配。深度理解、第三方代码执行、实验是否充分、论文创新性以及最终研究 Idea 仍由人负责。

## 3. 相对最初需求的完成情况

### 3.1 PDF 自动发现和获取 Artifact：主体完成

- 从 PDF URL 注释、`pdftotext` 正文和 DOI 上下文发现 Artifact 链接。
- 支持 GitHub、GitLab、Bitbucket、Codeberg、Zenodo、Figshare、数据集、项目页和补充材料。
- 支持受控文件下载和 shallow Git clone。
- 记录来源 URL、最终 URL、SHA-256、Git commit、license 文件、失败原因和 provenance manifest。
- 获取前要求 exact-plan 人工确认，不自动解压、不安装依赖、不执行下载代码。

主要入口：

- `src/artifact-discovery.ts`
- `src/artifact-acquisition.ts`
- `src/artifact-tools.ts`

尚未达到最终发布门槛：需要至少 30 篇真实人工审核论文、20 个真实 Artifact，并达到 precision、recall 和 kind accuracy 均不低于 0.90。详见 `docs/artifact-evaluation.md`。

### 3.2 图表截图和正文位置标注：主体完成，复杂版式待加强

- 使用 `pdftotext -tsv -r 72` 获取 page、block、line、word 和坐标。
- 识别 figure、table、algorithm、listing caption。
- 根据单栏/双栏布局、结构边界和页面灰度细化裁剪范围。
- 关联正文 mention、物理页码、section、line box 和上下文。
- 支持部分跨页表格、subfigure、OCR 补充和旋转坐标转换。
- Web 页面允许人工移动或缩放裁剪框，校正结果绑定 PDF SHA-256 保存。

主要入口：

- `src/pdf-analysis.ts`
- `src/pdf-asset-tools.ts`
- `src/pdf-annotation-store.ts`
- `src/pdf-asset-evaluation.ts`

待加强：纯扫描 PDF、旋转页面、非英语论文、出版社特殊排版、复杂跨栏浮动对象和无重复表头的跨页表格。自动结果仍是启发式候选，必须保留人工核验。

### 3.3 论文搜集 Tools：核心完成

已实现：

- `collect_literature`
- `search_literature_corpus`
- `expand_citation_network`
- `download_literature_pdfs`
- `manage_literature_memory`
- `manage_literature_corpus`
- `import_literature_corpus`

Provider 包括 arXiv、OpenAlex、Crossref、Semantic Scholar、DBLP、PubMed、CORE、OpenCitations 和 Unpaywall。已支持查询扩展、过滤、分页、去重、疑似重复、部分失败、429/Retry-After、checkpoint、provenance、PDF 下载和本地导入。

主要入口：

- `src/collection-tools.ts`
- `src/literature-providers.ts`
- `src/literature-store.ts`
- `src/literature-download.ts`
- `src/literature-search-checkpoint.ts`

待加强：为特定会议官网或会议论文集实现独立 adapter；持续验证真实 Provider 的限流、接口变化和长期稳定性。

### 3.4 System Prompt 人工精简：已完成

`src/SYSTEM.md` 已进行人工去重和重构：

- 明确 AI 不替代人的精读、实验判断、理解和创新。
- 区分 `quick`、`methods`、`full`、`reproduce` 四种调研深度。
- 明确搜索元数据不能直接证明技术 claim。
- 整合 PDF、Artifact、corpus、memory、个人/团队和 once/persistent 关卡。
- 将坐标、重试、分页和安全参数等工具细节下沉到各 Tool 的 `promptGuidelines`，避免 System Prompt 重复。

### 3.5 导师提出的产品方向：基本落实

- 个人知识库和团队共享知识库分离。
- 单次使用 `once` 与可复用的 `persistent` 分离。
- 通过材料 hash，以及 pipeline/model/prompt/config 版本避免重复分析。
- 团队库具备 reader、contributor、reviewer、admin 角色，以及提议、审核、审计、token、blob、备份和恢复流程。
- 人工笔记和筛选意见不会自动进入团队库。
- 已实现略读卡、比较矩阵和证据图，并区分 human 与 ai-assisted 内容。

## 4. 当前 Skill 状态

当前已经存在可运行的论文调研 Skill 系统，但还没有完全封装成一个独立的端到端 Skill 包。

- `skills/literature-corpus-manager/SKILL.md`：负责文献搜集、去重、获取、知识库复用、个人/团队及 once/persistent 规则。
- `src/SYSTEM.md`：负责论文精读、证据纪律、图表与实验分析、复现规划。
- `src/index.ts`：提供 `/collect`、`/paper quick|methods|full|reproduce` 等 Pi 工作流。
- Web Agent 会自动加载 `literature-corpus-manager` Skill，并调用相同的底层 Tools。

建议后续把上述能力统一封装成 `paper-research` 或 `literature-research` Skill，形成清晰的端到端入口，并将文献搜集、略读卡、图表核验、Artifact 审计、比较矩阵和复现计划明确为子任务。

## 5. Web 与服务端现状

默认 `paper-agent` 打开本地 Web 工作区，包含：

- 总览和任务中心；
- 多 Provider 论文搜索；
- 流式 Web Agent 对话、停止生成、工具卡片和人工确认；
- 个人论文库；
- PDF 与 Artifact 工作台；
- Artifact 人工质量评测页面；
- 团队知识库；
- 略读卡、比较矩阵和证据图工作区；
- 设置和诊断。

主要入口：

- `src/paper-agent-application.ts`：应用层编排。
- `src/local-web-server.ts`：本地 HTTP/API 服务。
- `src/web-agent-service.ts`：Pi Web Agent 会话和流式桥接。
- `web/`：React 前端。

Web Agent 的 `persistent` 会话上下文目前只在当前服务进程内存中存在；服务重启后会话消失。它与 corpus 的持久化是两个不同概念。

## 6. 开发环境和启动

要求：

- Git；
- Node.js `>=22.19.0`；
- Poppler `>=22.05`，包含 `pdftotext`、`pdftoppm`、`pdfinfo`、`pdfimages`；
- Tesseract 可选，用于 OCR；
- 使用 Web Agent 或 Pi 对话时需要自行配置模型和 API Key。

Windows 开发初始化：

```powershell
Set-Location paper-agent
npm ci --ignore-scripts
npm run web:build
.\paper-agent.ps1 install
paper-agent init
paper-agent --doctor
paper-agent
```

不安装用户级命令时，也可以从项目源码脚本启动。详细命令见 `README.zh-CN.md` 和 `docs/cli.md`。

模型配置见：

- `docs/web-agent-guide.zh-CN.md`
- `docs/model-configuration.md`

不要把真实 API Key、Pi 登录文件或团队 bearer token 写入仓库。

## 7. 打包时的验证结果

在 Windows、Node.js `v24.18.0`、npm `11.16.0`、Poppler `25.02.0` 环境执行：

```powershell
npm run check
```

2026-08-07 验证结果：

- Biome 检查通过，无 error/warning；仍有若干仅供参考的 style info。
- TypeScript 主项目检查通过。
- Web TypeScript 检查通过。
- Web 生产构建通过。
- Vitest：33 个测试文件、150 项测试全部通过。

`npm run eval:artifacts:check` 在未完成真实人工 gold 集之前应当失败，不能通过生成合成标注来绕过门槛。真实 Provider、模型中转站和生产团队服务仍需要在接手者环境进行在线验证。

## 8. 建议后续优先级

1. 将本交付快照提交为新的 Git 基线，避免继续在无提交快照上开发。
2. 统一封装端到端 `paper-research` Skill，明确各子任务入口和输出契约。
3. 使用真实论文完成 Artifact 人工 gold 集和严格评测门槛。
4. 针对扫描、旋转、复杂双栏和跨页表格继续提高图表区域准确率。
5. 增加会议官网/会议论文集专属 Provider adapter。
6. 对 Provider 限流、checkpoint、接口变化和部分失败做定期在线 smoke。
7. 在真实团队环境部署共享知识库，进行多用户权限、备份和恢复演练。
8. 评估是否需要把 Web Agent 会话从进程内存扩展为可选择的磁盘持久化。

## 9. 交付包数据边界

开发交付包只包含源码、测试、文档、Skill、配置和可版本化的评测标注，不包含：

- `.git/`；
- `node_modules/`、`dist/`、`coverage/`；
- `.paper-agent/` 运行数据；
- 下载到论文旁边的 `artifacts/`；
- 本地评测 PDF、渲染图片、debug 输出和 Artifact review workspace；
- `auth.json`、`oauth.json`、团队 token、API Key 或备份数据。

依赖通过 `package-lock.json` 和 `npm ci` 恢复，Web 资源通过 `npm run web:build` 重建。接手者若需要真实评测 PDF，应按 `eval-data/README.md` 和 `docs/artifact-evaluation.md` 中记录的来源重新下载并校验 hash。

## 10. 接手者第一步

解压后建议立即执行：

```powershell
git init
git add .
git commit -m "chore: import paper-agent handoff snapshot"
npm ci --ignore-scripts
npm run check
```

随后阅读顺序建议为：

1. `README.zh-CN.md`
2. 本文件 `HANDOFF.md`
3. `skills/literature-corpus-manager/SKILL.md`
4. `docs/research-workflow.md`
5. `docs/web-agent-guide.zh-CN.md`
6. `docs/pdf-artifact-workspace.md`
7. `docs/team-knowledge-base.md`

