---
name: paper-research
description: "Read, investigate, and compare research papers with Paper Agent through evidence-traceable skim, method, full-paper, reproduction, and comparison workflows. Use MinerU as the primary reading layer and the original PDF for targeted verification."
---

# Paper Research

使用个人库中的当前 PDF、MinerU、图表和 Artifact 工具研究论文。MinerU 是正文阅读、导航、搜索和候选结论的主要材料；原始 PDF 用于复核关键数字、原文引语、公式、主要视觉证据、材料冲突和决定性结论。不要用模型记忆、临时 Shell 下载或手工修改 manifest 代替材料工具。

用户明确要求创建或保存研究笔记时，研究笔记才是交付物；只要求阅读或分析时，在当前对话报告。

## 选择研究方式

根据用户目标直接选择，不要求用户提供模式名。

1. **快速略读**：用于“讲了什么”“是否值得读”“先看看”等请求，以及没有明确研究范围的阅读请求。输出五问卡和暂定建议，不声称覆盖全文。
2. **方法精读**：用户明确限定方法、公式、算法、实现或直接相关实验时使用。只覆盖目标方法及其支撑证据。
3. **全文研究**：用户说“精读”“精读论文”“深度阅读”“完整分析”“全文研究”或要求评价整篇论文时使用。完整覆盖 MinerU 正文、主要图表和论证链，输出严格 12 节报告。
4. **复现准备**：用户要求复现、实现、审计代码、恢复配置或验证结果时使用。先完成全文研究，再核对 Artifact、代码、数据、环境与配置。
5. **跨论文比较**：用户要求比较或综合两篇及以上指定论文时使用。先固定比较问题和统一维度，再逐篇独立取证。

开始前读取与当前方式对应的[子任务契约](references/subtask-contracts.md)。方法精读、全文研究、复现准备、跨论文比较和任何关键技术 claim 必须遵守[证据契约](references/evidence-contract.md)。涉及文献收集、保存或下载时，另读相邻 `literature-corpus-manager` Skill 的工作流契约。

## 研究顺序

后一步依赖前一步时按以下顺序执行。已有材料只有在论文身份、首选 PDF SHA 和 provenance 一致时才能复用。

1. **确认论文身份和当前 PDF**
   - 用个人库查询确认 paper ID、namespace、标题、作者、版本、首选 PDF、SHA-256 和物理页数。
   - 材料缺失、版本不一致或不可读时直接披露。跨论文比较为每篇维护独立短标签。

2. **读取当前 MinerU 导航**
   - 有当前 MinerU 材料时，先调用 `read_mineru_material` 的 `overview`。
   - 使用返回的稳定 section ID、物理页段、asset ID、类型统计和警告规划阅读；overview 不等于正文覆盖。
   - 工具拒绝过期材料时，重新生成当前首选 PDF 的 MinerU 材料后再读，不使用旧包形成结论。

3. **用 MinerU 阅读正文**
   - `sections`：按导航读取完整章节，适合略读、方法精读和定向实验阅读。
   - `pages`：读取指定物理页的类型化内容，包括正文、公式、表格 HTML、图注、脚注和代码；页眉、页脚和页码不作为正文。
   - `search`：同时检索正文、图注、表格、代码和其他专用字段，并保留相邻 block、页码、章节与 asset ID。
   - `markdown`：按 `next_cursor` 逐块遍历精确 `full.md`。全文研究可用完整 Markdown 游标遍历或全部 MinerU 页完成正文覆盖。
   - 每次返回 `truncated=true` 时继续传回原样的 `next_cursor`；被截断且未续读的调用不算完整覆盖。

4. **检查 MinerU 视觉材料**
   - 使用 `assets` 按 asset ID 读取相关图、chart 和表。模型具备图像输入能力，应直接检查图片，而不是只读 caption。
   - 表格同时检查结构化 HTML、caption、footnote 和图片；图表检查坐标、单位、图例、子图标签和视觉趋势。
   - 优先读 MinerU crop。仅当它支撑重大 claim、裁剪不完整、字段冲突或含义不清时，再回到原 PDF 渲染或区域提取。

5. **定点核验原始 PDF**
   - 关键数字、原文引语、公式、主要视觉证据、冲突、局限和决定性结论必须用 `read_pdf`、`render_pdf_page`、`extract_pdf_region` 或 `extract_pdf_table` 核验。
   - MinerU 可以形成论文理解和候选结论，但不能覆盖明显的 PDF 冲突。页面图像与提取文本冲突时，以可见原页为准并披露歧义。
   - 全文研究不要求用 `read_pdf` 重读每一页；完整性由 MinerU 全页或 `full.md` 完整游标遍历提供，PDF 核验针对重要证据。

6. **按需检查 Artifact**
   - 只有复现、实现或代码核验任务才要求 `discover_paper_artifacts`、获取和 `inspect_paper_artifacts`。
   - 记录实际来源、commit、入口、配置和失败。不得自动安装、构建、执行第三方代码或初始化 submodule。

7. **完成进度检查**
   - 全文研究和复现准备在报告前调用 `paper_progress`。
   - 检查当前 MinerU 来源、overview、章节/页/Markdown 覆盖、截断调用、发现与已查看资产，以及原 PDF 的定点核验。
   - Artifact 关卡只适用于复现工作；普通论文研究不要求文献检索、公开网页抓取或 Artifact 获取。

8. **报告并按请求保存笔记**
   - 先写简洁的证据边界：身份和版本、MinerU 实际覆盖、检查的 MinerU 资产、原 PDF 核验页和对象、Artifact（如有）、失败与未知项。
   - 没有保存请求时不调用笔记或派生记忆写入工具。明确要求保存时按下方流程创建或更新研究笔记。

## 各方式的最低读取范围

- 快速略读：overview；摘要、引言、方法概览、主要结果、局限/讨论和结论对应章节；至少检查一个关键 MinerU 图表；五问卡中的关键 claim 有定点 PDF 锚点。
- 方法精读：目标方法、直接实验、消融、局限和必要附录；检查相关 MinerU 图表；关键公式、数值和结论定点回到 PDF。
- 全文研究：通过 MinerU pages 或 Markdown cursor 完成完整正文覆盖；检查主要视觉资产；对决定性证据做定点 PDF 核验；调用 `paper_progress`。
- 复现准备：满足全文研究，再完成 Artifact 和论文到代码映射。
- 跨论文比较：每篇使用相同 MinerU 阅读维度和同等核验标准；只有用户要求逐篇全文研究时才要求每篇完整覆盖。

## 分析原则

建立 `challenge -> design -> evaluation` 链：已有系统在哪些条件下失败，论文的哪个设计针对该问题，哪个实验提供支持，哪些替代解释仍未排除。不要按目录机械改写摘要。

- 区分论文假定的场景与实验实际覆盖的场景；安全论文核对威胁模型。
- 用真实输入说明数据流，把论文概念映射到可验证模块。无 Artifact 时标 `[未知]`。
- 公式先解释变量、维度、目标和假设，再解释推导；不制造论文没有的形式化内容。
- 实验检查数据与 split、预处理、baseline 公平性、预算、指标、seed/方差、硬件、消融和反例。
- 数字保留单位、实验条件和误差。未报告内容标 `[未知]`，建议实验不写成已执行结果。

## 输出契约

快速略读输出：证据边界、问题与动机、research gap、核心机制、最直接支撑实验、主要局限、暂定 `精读 / 保留 / 排除` 建议和后续问题。

方法精读输出：证据边界；核心 intuition 与边界；输入到输出的数据流；公式或算法及假设；实现映射；直接支撑实验与替代解释；最脆弱假设；证据缺口。不要强制 12 节。

全文研究和复现准备严格输出以下 12 节，不得合并、缺省或用其他章节替代：

1. **研究问题、重要性与价值**
2. **之前如何解决，以及缺口在哪里**
3. **重建作者可能的思考路径**，整节标为 `[推断]`
4. **核心 intuition**
5. **具体方法与实现**
6. **核心数学与理论背景**
7. **实验如何验证 claim**
8. **Takeaways**
9. **最脆弱的假设**
10. **一周最小复现实验**
11. **反例设计**
12. **非增量 follow-up idea**

另附复现参数表和仍然未知的问题。复现准备再附 Artifact 核对、论文到代码映射、缺失条件和人工执行步骤。

跨论文比较输出：比较问题与范围、逐篇证据边界、逐篇证据卡、统一矩阵、可比性审计、跨论文综合、证据缺口与后续验证。不同数据、预算或指标的数字不得直接排名。

## 创建研究笔记

1. 用 `inspect_agent_tools` 确认 `search_research_notes` 和 `manage_research_note`，并确定 namespace。
2. 先按 paper ID 或标题搜索已有笔记。只有用户明确要求更新时才覆盖已有笔记，并保留人工内容。
3. 略读使用 `skim`；方法精读、全文研究和复现准备使用 `deep-reading`；比较使用 `comparison-matrix`。模板只在创建时复制，必须写入实际分析。
4. 正文保留 MinerU 覆盖、原 PDF 页码、章节、图表/公式、Artifact commit、失败与 `[未知]`。不要把模板提示或空占位符当成结果。
5. 调用 `manage_research_note` 创建或更新。工具成功返回后才报告已保存；取消或失败时明确尚未保存。

研究笔记不自动创建派生记忆、Wiki 页面或团队共享内容。用户明确要求沉淀到 Wiki 时切换到 `research-wiki` Skill。
