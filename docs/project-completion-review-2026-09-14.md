**Paper Agent 项目完成度评估 · 2026-09-14**

**修复更新（2026-09-14，基于 99d3add）：** 后续按用户要求修复了本报告中的图号误标、Web once 上下文残留、人工裁剪未进入 Agent 索引三项问题。新增 19 项回归，覆盖显式编号及范围、正文数字、once/persistent 连续对话与重启、默认/自定义存储目录、PDF 改名和内容 hash 变化。完整 npm run check 通过：主项目 75 个测试文件/416 项测试，团队服务 4 个测试文件/13 项测试，合计 429 项；三处类型检查、Web 构建、团队 smoke 和工具文档校验通过。第四项固定 PDF 评测问题按要求未处理。[修复验证日志](C:/Users/zjy/AppData/Local/Temp/paper-agent-three-fixes-20260914-check.log)。以下保留修复前评估，作为问题发现与定位记录。

结论：主要功能已经落地，适合有技术支持的组内试用；尚未达到“原始需求全部验收完成”的状态。原始四项需求中，artifact 获取、文献搜集、system prompt 精简三项基本完成，图表截图与正文标注仍为部分完成。导师要求的个人/团队分离、知识库与子任务 Skill 已有实质实现；单次/持久使用的采集层已经分开，但 Web 单次会话存在可复现的上下文复用错误。

本次以原始需求和[最佳实践的核心流程](D:/ssh文献调研/paper-agent-collab/ssh文献调研最佳实践.md:5)为评估基准。外部工具清单视为能力参考，不要求逐个复制所有第三方产品；“没有自动代替人做实验和形成创新”不计作欠项。

**评估范围与证据强度。** 开始时工作区干净，基线为 27315d6，Node v24.18.0。完整检查于北京时间约 13:22 完成；13:24 起，Agent 会话设置、路由及前端等文件出现非本次评估产生的未提交修改。下文完整检查结论对应检查时的基线，不能外推为这些后续改动全部通过。once 问题在当前工作区复现，相关会话恢复逻辑也已核对存在于 HEAD。本次产物为评估报告，未修订业务实现。

“基本完成”指核心行为有可调用实现和测试支持；“部分完成”指仍有影响要求的行为缺口；“未验证”表示缺少相应验收证据，不等于功能不存在。单元测试、真实本地 HTTP、在线服务、真实论文准确性和多人部署分别判断。

原始需求逐项对照：

| 原始需求 | 判定 | 当前已经实现 | 尚欠的验收或修正 |
| --- | --- | --- | --- |
| 1. 从 PDF 自动提取 artifact 链接并下载，解除事先准备 artifacts 的要求 | 基本完成；本机在线验收受阻 | PDF URL 注释、正文、可选 LaTeX 和 DOI 线索发现；无可信候选时 GitHub 补查；受限下载/浅克隆；文件哈希、commit、来源及失败清单 | 本机 Git CA 配置残留旧安装路径；在线复测还遇到网络中断。ACM badge/evaluator 等特殊入口没有专门解析链 |
| 2. 改善截图范围，并结合 pdftotext 做文中位置标注 | 部分完成 | TSV 坐标、caption、章节与正文 mention、候选框、栅格精化、OCR、子图、跨页表格和 Web 人工修正 | 数字被误识别为图号；人工框尚未接入 Agent 图表索引；固定真实 PDF 评测材料缺失，无法确认截图准确性达标 |
| 3. 实现论文搜集 tools，参考会议讨论中的工具能力 | 基本完成 | 搜索规划、多源采集、分页、过滤、去重、来源记录、引用扩展、断点恢复、选中入库、PDF 获取及材料包 | 外部源运行波动仍需监测；旧文档中的整届会议采集承诺与当前注册能力需要重新核准 |
| 4. 检查并精简 system prompt 的冗余重复 | 基本完成，仍有少量重复 | 全局规则留在 SYSTEM，研究流程与报告结构下沉 Skill，工具参数由工具描述管理；有契约回归 | SYSTEM 第 5 行与第 39 行重复表达 AI/人工边界；跨 Skill 的持久化要求仍应统一表述 |

第 1 项已经形成真实调用路径。[discoverArtifactsFromPdf](D:/ssh文献调研/paper-agent-collab/src/artifacts/application/artifact-discovery.ts:343) 并行执行 pdfinfo -url、pdftotext -layout 和 PDF 哈希计算，保留正文页码；[acquire_paper_artifacts](D:/ssh文献调研/paper-agent-collab/src/artifacts/presentation/artifact-discovery-tools.ts:147) 在执行阶段自动发现候选、检查选择、准备授权并调用下载/克隆。取得的材料进入 [PDF 旁的 artifacts 目录](D:/ssh文献调研/paper-agent-collab/src/artifacts/application/artifact-acquisition-files.ts:46)，目录由程序创建，不再要求事先存在 artifact。

自动发现与确认后获取是现有产品设计，不能把需要用户选定材料或确认下载判为“下载未实现”。默认不会选入低置信度、引用基线或第三方候选，见[选择规则](D:/ssh文献调研/paper-agent-collab/src/artifacts/application/artifact-acquisition.ts:227)。[已有下载复用测试](D:/ssh文献调研/paper-agent-collab/test/artifact-acquisition.test.ts:50)覆盖避免重复网络获取；该类测试大多使用替身，不能代替真实 PDF 到真实仓库的整链验收。

第 2 项确实使用了 pdftotext，不只是截图工具堆叠。[分析入口](D:/ssh文献调研/paper-agent-collab/src/pdf/application/pdf-analysis.ts:23)以 72 DPI TSV 获取布局，[attachAssetMentions](D:/ssh文献调研/paper-agent-collab/src/pdf/application/pdf-asset-mentions.ts:34)记录物理页、章节、上下文及 lineBox，[栅格精化](D:/ssh文献调研/paper-agent-collab/src/pdf/application/pdf-gray-image.ts:286)再处理候选区域。这是位置与文本关联能力，不等同于自动理解图表所支持的科学结论。

第 3 项的[当前 provider 注册表](D:/ssh文献调研/paper-agent-collab/src/literature/infrastructure/literature-providers.ts:74)有 9 个关键词检索源：arXiv、OpenAlex、Crossref、Semantic Scholar、DBLP、CORE、Exa、ACL Anthology、USENIX；另有 OpenCitations 和 Unpaywall 用于 DOI/引用/OA 补全，不应把它们算作普通关键词搜索源。ACL 需要一个确定年份和一个支持的 venue。没有 Google Scholar provider。

[collectLiterature](D:/ssh文献调研/paper-agent-collab/src/literature/application/literature-collection.ts:101)实现缓存、已有库复用与部分失败返回；[结果去重及来源状态](D:/ssh文献调研/paper-agent-collab/src/literature/application/literature-collection.ts:284)有独立数据结构；[引用扩展工具](D:/ssh文献调研/paper-agent-collab/src/literature/presentation/citation-expansion-tool.ts:19)支持前向/后向、有界深度和发现路径。当前通过通用检索及 ACL/USENIX 源支持会议相关收集，但不能因此声称旧文档列出的所有会议整届覆盖范围均已验收。

第 4 项的[当前 SYSTEM](D:/ssh文献调研/paper-agent-collab/src/SYSTEM.md:1)为 45 行、1616 字符，主职责已经收敛；[契约测试](D:/ssh文献调研/paper-agent-collab/test/prompt-skill-contract.test.ts:9)检查长度、证据规则和流程下沉。仍可将第 5 行和第 39 行合并，但这属于小幅收尾，优先级低于行为错误。

导师建议逐项对照：

| 导师建议 | 完成度评价 | 实现证据和边界 |
| --- | --- | --- |
| 团队共享库与个人分布式部署分开 | 架构及本地业务闭环基本完成；真实多人部署未验收 | 个人 SQLite 按 namespace 隔离；独立 team-server 提供认证、角色、审核、共享论文/PDF/知识、审计、备份恢复；个人到团队显式提议，团队到个人可拉取 |
| 持久使用与单次使用分开，避免重复分析生成 | 采集/缓存层基本完成；Web 会话层部分完成 | persistent 查询可命中缓存，材料和派生结果可按版本复用；once 不自动合并候选论文，但保存检索记录。Web once 第二轮仍带入第一轮上下文 |
| 着力搜集、整理、知识库化，以子任务插件承载常见需求，保留人的理解和创新 | 基本达成 | 三个 Skill 分别负责 corpus、论文研究、研究 Wiki；Markdown 笔记与声明级知识分开；AI 结论需要原始证据和人工判断 |

个人/团队分离有实际数据边界：[个人 namespace 隔离测试](D:/ssh文献调研/paper-agent-collab/test/personal-corpus-database.test.ts:126)、[上行脱敏](D:/ssh文献调研/paper-agent-collab/src/team/application/team-corpus-client.ts:48)、[默认只检索已批准内容](D:/ssh文献调研/paper-agent-collab/team-server/src/infrastructure/file-team-literature-repository.ts:244)、[原生 Node 多角色 Web API 流程](D:/ssh文献调研/paper-agent-collab/test/team-web-flow.test.ts:84)、[独立复制后启动测试](D:/ssh文献调研/paper-agent-collab/team-server/test/standalone.test.ts:215)。团队知识重复拉取保持幂等，且保留用户后续编辑，见[executeTeamKnowledgePull](D:/ssh文献调研/paper-agent-collab/src/team/application/team-knowledge-pull.ts:90)。这些证据支持小团队单实例服务的实现完成，不证明实际实验室已部署并持续使用。

防重复机制已经实现，但需要区分不同层次。[搜索缓存回归](D:/ssh文献调研/paper-agent-collab/test/collection-workflow.test.ts:133)断言重复搜索不会增加网络请求；[derivedCacheKey](D:/ssh文献调研/paper-agent-collab/src/literature/application/literature-store.ts:38)包含材料 hash、operation、pipeline/model/prompt 版本与配置；[manage_literature_memory](D:/ssh文献调研/paper-agent-collab/src/literature/presentation/literature-download-memory-tools.ts:100)提供 lookup/record。模型和 prompt 版本由调用方提供，AI 分析复用仍依赖先查库、保存已授权成果的流程，不能声称所有入口都自动保证不重复生成。

once 的采集语义是“保留搜索记录、跳过候选论文入库”，见[分支实现](D:/ssh文献调研/paper-agent-collab/src/literature/application/literature-collection.ts:346)；它不等于完全不落盘。该行为有利于后续按 search_run_id 保存选择，应在用户说明中表达准确。

知识库化已超出最佳实践中旧的“部分内建”描述。[Wiki 批量预览和写入](D:/ssh文献调研/paper-agent-collab/src/wiki/application/wiki-workspace.ts:131)会检查冲突及指纹，来源或内容变化后拒绝旧预览；[FTS5 页面和分块索引](D:/ssh文献调研/paper-agent-collab/src/wiki/infrastructure/wiki-index.ts:144)支持检索，[测试](D:/ssh文献调研/paper-agent-collab/test/wiki-workspace.test.ts:62)覆盖声明级证据、搜索、批量写入、外部移动和来源变化。lint 检查结构与来源一致性，无法替代人判断结论是否正确。

核心流程的覆盖范围：

| 环节 | 当前可交付内容 | 应保留给人的工作 |
| --- | --- | --- |
| 文献搜索 | 多源候选表、筛选线索、去重、来源、引用扩展 | 定义研究边界、确认相关性和最终纳入 |
| 原文与 artifact | PDF 版本、下载/克隆、哈希、commit、材料包和失败报告 | 确认论文与 artifact 对应，解决非公开或缺失材料 |
| 略读 | 五问阅读卡、暂定筛选建议 | 验证 gap、创新点和是否精读 |
| 精读 | 页码覆盖、图表/公式/代码定位、证据和参数整理 | 深度理解、质疑假设、判断论证是否成立 |
| 实验 | 复现参数、入口、配置核查与最小实验计划 | 实际执行、结果解释和实验决策 |
| 形成 idea | 基于局限提出待核验的问题、反例和实验候选 | 判断创新性、选择问题并形成研究 idea |

对应[四类论文研究契约](D:/ssh文献调研/paper-agent-collab/.agents/skills/paper-research/SKILL.md:12)和[人工边界](D:/ssh文献调研/paper-agent-collab/src/SYSTEM.md:37)，当前的自动化止于材料与研究辅助。最佳实践 L0 有核验支持，L1–L4 没有完整自动执行闭环；按照导师要求，这不应算原始功能未完成。Skill 中强制生成“非增量 follow-up idea”的表述宜明确为候选，避免让输出标题被误当成人工确认的创新评价。

影响验收的具体问题，按优先级排列：

1. **图表正文关联存在已复现误标。** [referenceIdentifiers](D:/ssh文献调研/paper-agent-collab/src/pdf/application/pdf-asset-mentions.ts:9)从 figure/table 标签后的较长文本中提取多个数字，没有严格限制图号语法。本次以“Figure 2 shows results for 5 tasks.”及图 2、图 5 两个对象调用真实 attachAssetMentions，结果同时关联 2 和 5，且均为 high。期望只关联图 2。应修复图号列表/范围的边界，并覆盖正文带数量、年份、百分比的例子。

2. **Web once 没有实际清空后续模型上下文。** [createPiSession](D:/ssh文献调研/paper-agent-collab/src/agent/application/web-agent-runtime.ts:111)无条件查找并恢复同一会话的 Pi JSONL；[disposePiSession](D:/ssh文献调研/paper-agent-collab/src/agent/application/web-agent-runtime.ts:175)仅释放对象。文档却声明[每轮清空上下文](D:/ssh文献调研/paper-agent-collab/docs/web-agent-guide.zh-CN.md:98)。本次用真实 Pi SDK、隔离临时目录和本地模拟模型端点连续发送 AUDIT_FIRST_MARKER、AUDIT_SECOND_MARKER，第二轮模型请求的 user messages 同时包含两个 marker。应分离 UI 历史与模型上下文；验收要直接检查第二轮请求，而不只检查运行时对象被销毁。

3. **人工裁剪修正仅进入 Web 分析路径，未进入 Agent 索引路径。** [pdf-analysis 后台任务](D:/ssh文献调研/paper-agent-collab/src/app/application/paper-agent-runtime.ts:63)按 PDF hash 应用修正；[list_paper_assets](D:/ssh文献调研/paper-agent-collab/src/pdf/presentation/pdf-assets-list-tool.ts:41)重新检测、OCR 和精化后直接返回，未读取修正存储。应让两条入口共用带人工修正的结果，再验收“Web 修正后 Agent 继续阅读”。

4. **截图质量没有当前可执行的固定评测证据。** 最佳实践[第 6 节](D:/ssh文献调研/paper-agent-collab/ssh文献调研最佳实践.md:204)称有 104 Gold 固定评测集，但当前 checkout 缺少 scripts/evaluate-pdf-assets.ts、eval-data/annotations、eval-data/baseline.json；package.json 也没有对应 eval 命令。[CI](D:/ssh文献调研/paper-agent-collab/.github/workflows/ci.yml:96)会在缺失时跳过该门禁。现有测试包含[人工构造 TSV](D:/ssh文献调研/paper-agent-collab/test/pdf-mentions.test.ts:34)和[替身 OCR](D:/ssh文献调研/paper-agent-collab/test/pdf-assets.test.ts:136)，通过它们不能推导真实论文截图准确率。应恢复固定材料、人工标注、指标及门禁，至少区分常见双栏、跨栏、子图、扫描、旋转、跨页表格。

5. **在线与多人使用验收没有闭合。** 本机在线 smoke 首次因 Git 的 http.sslCAInfo 指向不存在的旧目录失败；给测试进程临时使用当前安装目录的 CA 后，第二次仍因 ECONNRESET 失败，不能记为通过。团队服务的[交付清单](D:/ssh文献调研/paper-agent-collab/docs/team-service-completion.md:21)仍未勾选真实浏览器角色流程；真实多成员 HTTPS 部署本次也未验证。应分别完成环境修正、公开小仓库获取、真实论文材料链及角色浏览器验收。

6. **文档与交付配置需要同步。** 当前[生成目录](D:/ssh文献调研/paper-agent-collab/docs/agent-tools.md:5)为 42 工具、仓库有 3 个 Skill；旧最佳实践写 23 工具、2 个 Skill。详见下表。额外发现[发布打包脚本](D:/ssh文献调研/paper-agent-collab/.github/workflows/release.yml:82)仍复制不存在的 deployment、skills、eval-data 和 LICENSE 路径，且没有按当前结构纳入 .agents/skills、team-server 等目录。正式发布前需按当前目录结构修正并实跑打包；本次未生成发布包。

另外，栅格精化[渲染失败或异常分支](D:/ssh文献调研/paper-agent-collab/src/pdf/application/pdf-gray-image.ts:305)会继续使用文本候选框，但不会把该失败抛给上层 warnings。建议显式报告降级状态，让用户知道裁剪结果没有经过图像精化。

最佳实践文档中需要修正的状态：

| 旧描述 | 当前核验结果 | 对完成度的影响 |
| --- | --- | --- |
| 23 个工具、2 个 Skill | 42 个工具、3 个 Skill | 文档过时，不能据旧数量低估实现 |
| 104 Gold 固定评测集把关 | 文件/脚本缺失时 CI 跳过 | 不能据旧文字认定 PDF 质量已验收 |
| collect_conference_proceedings 覆盖列出的会议和年份 | 当前源码和注册表无该工具；有 ACL/USENIX 源与 DBLP 通用检索 | 专用整届覆盖承诺需要重新验证；不据工具改名否定一般搜集能力 |
| parse_pdf_layout_mineru、read_paper_html | 前者当前由 generate_mineru_material / read_mineru_material 路径承载；后者未在当前源码和工具表找到 | 旧调用示例和能力清单需更新 |
| 个人库主要为 records/papers/derived、内容寻址文件 | 当前是个人 SQLite、可读 PDF 路径及版本记录；团队仍用内容寻址 blob | 存储和排障文档需要区分版本 |
| 知识组织仅部分内建，Zotero 主要经 BibTeX 互通 | 已有独立 Wiki、声明级证据、FTS、lint、Zotero 本地双向导入/导出入口 | 这些方向已明显推进 |
| 团队共享已内建但真实多人 HTTPS 待验收 | 版本化审核、协作、知识拉取和恢复补偿已增加；真实部署验收仍未得到确认 | 实现进度与运营验收应分开记录 |

本次实际验证结果：

| 验证 | 结果 | 能证明什么 |
| --- | --- | --- |
| npm run check | 退出码 0；主项目 74 文件/397 测试，团队服务 4 文件/13 测试 | 基线 lint、三处类型检查、Web 构建、410 项测试、原生 Node 团队 smoke 和工具文档检查通过 |
| lint 细项 | 2 个非阻断 warning | team-page.css 的 reduced-motion 规则使用 !important；不是功能阻断 |
| 图表 mention 最小复现 | 复现失败行为 | 普通数量 5 被错误关联为图 5，且置信度为 high |
| Web once 两轮请求复现 | 复现失败行为 | 释放 Pi 实例后恢复了旧上下文，第二轮仍含第一轮内容 |
| npm run test:live，额外启用 ACL/USENIX | 退出码 1 | 首次进入 Git 获取阶段后因 CA 路径失败；并非所有外部链路验收通过 |
| 正确 CA 的临时进程复测 | 退出码 1 | 出现网络 ECONNRESET，仍无完整在线通过证据；未永久修改 Git 配置 |
| 固定真实 PDF 准确率评测 | 无法执行当前文档声称的门禁 | 缺少评测材料与入口 |
| 浏览器角色流程、真实多人 HTTPS、真实 LLM 研究质量 | 本次未验收 | 不用 HTTP/单元测试结果替代 |

本地日志：[完整检查](C:/Users/zjy/AppData/Local/Temp/paper-agent-completion-audit-20260914-check.log)、[首次在线 smoke](C:/Users/zjy/AppData/Local/Temp/paper-agent-completion-audit-20260914-live.log)、[临时 CA 复测](C:/Users/zjy/AppData/Local/Temp/paper-agent-completion-audit-20260914-live-ca.log)。两个行为复现使用合成输入；once 复现的模型端点是本地模拟服务，实际会话管理走 Pi SDK，没有调用付费模型。

建议下一阶段以验收收尾为目标：先修复图号识别与 once 上下文，统一人工裁剪复用，再恢复 PDF 固定评测并完成真实材料和团队角色流程。文档和发布配置随实际行为同步。以上完成后，才适合将项目状态从“主要功能可用、组内试运行”提升为“原始需求验收完成”。
