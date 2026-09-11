---
name: research-wiki
description: Build, query, and audit the user's curated Paper Agent research Wiki with declaration-level evidence, tool discovery, batch preview/apply, FTS chunk search, and deterministic lint. Use when the user asks to deposit stable knowledge, query their Wiki, or check Wiki structure and provenance; do not use it for ordinary paper reading or temporary notes.
---

# Research Wiki

Wiki 是经过主动沉淀的可复用知识层，不是论文全文、对话记录或个人笔记的复制件。Markdown 是正文唯一事实来源；SQLite 只保存可重建的证据、关系、分块和检索索引。

每个 namespace 根目录包含自动生成的 `index.md` 导航和追加式 `log.md` 变更日志。二者都是管理文件，不是 Wiki page、证据来源或查询结果；不要把它们引用为 claim evidence。

个人笔记是工作材料，PDF/MinerU/Artifact 是证据材料。三者不能互相冒充：

- `[论文]` 必须回到原始 PDF 的物理页、章节、图表或公式定位。
- `[代码]` 必须来自已验证的 Artifact、commit 和路径。
- `[公开资料]` 必须来自最终可访问的一手 URL。
- MinerU、OCR、搜索摘要和模型记忆只能用于定位，不能独立支撑技术 claim。
- 个人笔记只能作为工作来源或明确标注的推断来源。

本 Skill 只处理三种工作流：

- **Ingest**：用户明确要求把材料沉淀、综合或更新到 Wiki。
- **Query**：用户询问 Wiki 中已经沉淀的知识。
- **Lint**：用户要求检查 Wiki 结构、证据、链接或索引完整性。

## 工具发现优先

In ingest 前必须先调用 `inspect_agent_tools`，按能力查询当前会话实际注册的工具。不要根据旧文档、模型记忆或工具名猜测可用能力。

至少查询这些能力组：

1. `paper metadata personal library`
2. `PDF MinerU text assets figure table`
3. `artifact discover acquire inspect`
4. `research notes`
5. `Wiki evidence search lint`
6. `paper progress coverage`

返回结果决定本轮能做什么。工具缺失时先说明降级：

- 没有 MinerU：直接用 PDF 工具定位，不补造结构化材料。
- 没有 Artifact 工具或未获取 Artifact：只能写公开资料或未知，不能写代码事实。
- 没有笔记工具：不要声称读取了笔记。
- 没有覆盖工具：全文 claim 仍必须覆盖全部物理页，并在对话中明确说明无法自动审计覆盖。

常用能力映射仅作为查询提示，不是固定清单：论文状态、PDF 文本、PDF 视觉、MinerU、Artifact、笔记、Wiki、覆盖检查。下面出现的工具名是能力示例；实际调用必须以 `inspect_agent_tools` 返回的名称为准。

## Ingest

只有用户明确说“保存到 Wiki”“沉淀到知识库”“更新 Wiki”等，才进入 Ingest。普通论文阅读、搜索结果、聊天总结和笔记创建都不能自动写入 Wiki。

### 1. 对齐已有知识

先调用 `search_research_wiki`：

1. 按用户主题、别名、论文 ID 和笔记 ID 搜索。
2. 读取相关完整页面，记录页面 ID、标题、别名、类型、状态、现有证据和链接。
3. 判断应该 create、update、no-op 还是 conflict；不要因为名称不同就创建语义重复的新页。

然后调用 `search_research_notes` 和 `get_personal_library_paper` 或 `search_literature_corpus`，建立来源清单。必要时调用 `build_paper_package` 检查 PDF、MinerU 和 Artifact 状态。

### 2. 选择材料并取证

按照以下顺序处理每篇来源：

1. **论文身份和版本**：确认 paper ID、标题、PDF 版本、SHA-256、总页数和语言。
2. **MinerU 定位**：若有材料，用 `read_mineru_material` 的 overview、pages 或 search 找到章节和页码；只把它当作导航。
3. **原始 PDF 核验**：用 `read_pdf` 读取证据所在的小页段。全文级页面在写入前还要覆盖全部物理页，并调用 `paper_progress`。
4. **视觉对象核验**：用 `list_paper_assets` 建立图表、算法、caption 和正文 mention 索引；用 `render_pdf_page`、`inspect_pdf_layout`、`extract_pdf_region` 或 `extract_pdf_table` 核验支撑主要 claim 的对象。
5. **Artifact**：只有发现、获取并检查后的代码才能写 `[代码]`。记录 commit、路径、行号和实际配置，区分论文值、代码值、默认值和未知值。
6. **笔记**：用笔记 ID、revision、content hash 和标题定位。笔记可以提示观点，但涉及论文事实时必须回到论文证据。
7. **公开资料**：只使用最终可访问的一手页面或官方文档；记录 URL，不把搜索结果页当作事实来源。

一条证据必须精确到能复核的位置。论文证据至少包含 `paper_id`、PDF 版本和 `pdf_page`；笔记证据至少包含 `note_id`、revision/hash 和可选标题；Artifact 至少包含 `paper_id` 以及 commit、URL 或路径；公开来源必须包含 HTTP(S) URL。

### 3. 提炼知识单元

不要按论文目录机械复制。先提炼可复用知识单元：

- 定义和范围
- 问题、失败条件与脆弱假设
- 机制、流程、公式和适用条件
- 实验问题、条件、基线、指标、结果和替代解释
- 限制、反例、争议和未决问题
- 与其他页面、论文、方法、系统或数据集的真实关系

页面类型固定为：

- `topic`：领域、问题空间或研究方向。
- `concept`：可复用概念、机制、观察或判据。
- `method`：算法、技术路线、假设和失败模式。
- `system`：具名系统、架构、实现和工程边界。
- `dataset`：数据集、基准、采集、split、指标和代表性。
- `synthesis`：跨论文综合、共识、争议和证据缺口。
- `question`：可证伪问题、当前证据和下一步实验。

### 4. 组织页面正文

每条稳定 claim 必须用 `[E1]`、`[E2]` 引用声明级证据。需要推断时写 `[E1][推断]`，并让推断依赖的证据可追踪。不得把未经核验的结论写成论文事实。

推荐结构：

```markdown
> 一句话说明页面范围。

## Key claims
- 结论一。[E1]
- 结论二；如果依赖综合判断，标为推断。[E1][E2][推断]

## Boundaries and contradictions
- 适用条件、反例、来源冲突或未知项。

## Related knowledge
- [[相关页面]]

## Open questions
- 可证伪的下一步问题。
```

类型页面可以增加专属小节，但保留 `Key claims`、边界或开放问题的清晰位置。不要粘贴整篇报告、PDF 或笔记；不要为了凑页面而拆出没有独立复用价值的实体。

### 5. 批量预览和写入

一次沉淀通常涉及多个页面。把所有页面作为一个 change set 调用 `ingest_research_wiki(mode="preview")`：

1. 检查每个 change 的 `create/update/no-op/conflict`。
2. 检查来源快照、证据定位、正文 `[E#]`、Wiki link 和重复名称。
3. 向用户展示完整页面清单、差异、来源和冲突；不要只展示一句摘要。
4. 用户确认后，用同一个 `preview_fingerprint` 调用 `apply`。

如果来源、页面哈希或请求发生变化，必须重新 preview。不要绕过工具直接编辑 Markdown、SQLite 或工作区文件。

### 6. 写入后复核

apply 成功后：

1. 通过页面 ID 重新读取受影响页面。
2. 再调用 `search_research_wiki` 验证正文分块和别名可检索。
3. 调用 `lint_research_wiki`；有 error 时不得把写入报告为完成。
4. 如果 lint 发现旧来源、死链或 stale source，提出新的批量修复 preview，不直接改文件。

## Query

Query 只回答 Wiki 已经沉淀的内容。

1. 调用 `search_research_wiki`，优先使用标题、别名、正文分块和来源过滤。
2. 用返回的 `page_id` 读取完整页面；不要只根据 snippet 下结论。
3. 默认只扩展一跳 `[[Wiki link]]` 或 backlink，并把扩展页面标记为关系导航，不把相关页面自动当成证据。
4. 输出时标明 Wiki 页面 ID，并保留底层 `[E#]`、paper ID、note ID 和定位。
5. Wiki 没有支持答案时，明确说“尚未沉淀”；建议论文研究或显式 ingest，不静默使用 PDF、笔记、搜索结果或模型记忆补充。

Wiki 页面是二次知识，不是一手证据。回答科学 claim 时，优先引用页面内保存的原始证据定位；如果用户要求重新核验，进入论文研究流程重新读取原始 PDF。

## Lint

调用 `lint_research_wiki`，按 error、warning、info 分组报告。检查包括：

- frontmatter、重复 ID、重复标题/别名和近似重复页面；
- 缺失来源、来源版本过期、非法证据类型和无效定位；
- `[E#]` 未定义、证据未使用、空页面和无来源页面；
- 死链、自链接、索引不一致；
- `conflicted` 页面缺少争议或开放问题章节；
- 旧式页面级来源，以及外部移动 Markdown 后的索引重建。

Lint 只读。修复不能手工编辑，必须生成新的批量 preview/apply；语义矛盾和结论合并仍需要用户确认。

## References

- [pages schema](references/schema.md)
- [ingest contract](references/ingest-contract.md)
- [query contract](references/query-contract.md)
- [lint contract](references/lint-contract.md)
