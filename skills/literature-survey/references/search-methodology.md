# 多轮迭代搜索方法（literature-survey 子文档）

本文档给"尽量不漏"的文献搜索提供可操作的方法，供 SKILL.md 的 Execute 阶段按需加载。

## 一、定题与拆词

### 一句话定题（先写出来）

```
研究对象 + 要解决的问题 + 应用场景 + 时间范围
例: "2020-2026 年，网络协议模糊测试中关于状态感知(stateful)的
    覆盖率引导方法, 是否以及如何解决了状态空间爆炸问题"
```

说不清一句话，就先别搜——搜索词会发散，结果没法初筛。

### 拆词表（领域词 + 问题词 + 方法词）

| 类别 | 中文 | 英文 | 缩写/同义词 |
| --- | --- | --- | --- |
| 领域词 | 模糊测试 | fuzzing | fuzzer, greybox fuzzing, fuzz testing |
| 问题词 | 状态感知 | stateful | state-aware, stateful network protocol |
| 方法词 | 覆盖率引导 | coverage-guided | CFG-guided, mutation-based |

规则：
- 每个维度至少一组变体；
- 缩写要展开（如 UAF → use-after-free）；
- 相邻术语（如 fuzzing → grammar-based / symbolic execution 相邻方向）可加但别无限膨胀。

## 二、多轮迭代搜索

### 为什么多轮？

单轮搜索受限于：
- 单次查询的表达力（一个查询覆盖不了一个主题的多个侧面）；
- 各源索引差异（arXiv 偏预印本、DBLP 偏 CS 会议、PubMed 偏生物医学）；
- 返回条数有界（默认 20/源，可调大）。

### 轮次策略（建议）

| 轮 | 策略 | 例子 |
| --- | --- | --- |
| 1 | 主题主干查询（领域词+问题词） | "stateful fuzzing network protocol" |
| 2 | 换问题词/方法词变体 | "state-aware fuzzing"、"coverage-guided fuzzing state machine" |
| 3 | 缩写/英文反向变体 | "protocol fuzzing"、"UAF detection fuzzing" |
| 4 | 从种子论文扩展（引用/被引） | expand_citation_network 深度≤2 |
| 5 | 补充轮：新发现的术语再查 | 从已得论文摘要里提取新关键词 |

**停止条件**：连续 1-2 轮新增去重后论文数趋近于 0，或覆盖度达到"主要工作都能在候选表里找到"。

### 覆盖度自查

```
对每篇种子论文问: 它的前向引用/被引论文, 在我的候选表里吗？
对每个拆词维度问: 该维度的主要工作, 搜到了吗？
缺 → 补一轮定向查询; 齐 → 停止
```

## 三、初筛规则

- **相关性优先于 venue**：顶会/高影响期刊只决定阅读优先级，不能替代相关性判断；
- 明确规则：时间范围、类型（会议/期刊/预印本）、是否要代码/实验；
- 三档初筛：`include`（进入候选表）/ `maybe`（待定，标注疑点）/ `exclude`（记录理由）；
- 用 `manage_literature_corpus` 的 screening 状态记录，不要只在对话里说。

## 四、候选论文表字段说明

| 字段 | 含义 | 怎么填 |
| --- | --- | --- |
| 来源 | 该记录来自哪个 provider | arxiv / openalex / crossref / dblp / ... |
| 发现路径 | 如何被发现 | "第1轮查询: stateful fuzzing" 或 "论文X的引用扩展" |
| 初筛结果 | include/maybe/exclude + 一句理由 | 可追溯，供后续复核 |
| PDF | 是否有开放 PDF 链接 | 有/无（元数据 links 里 kind=pdf） |
| 代码 | 是否有代码仓库链接 | 有则给 URL（artifact 链接） |

**发现路径是最容易被忽略但最有价值的字段**——它直接回答"我有没有漏"。

## 五、与 paper-agent 工具的映射

| 需求 | 工具 |
| --- | --- |
| 查已有库防重复 | `search_literature_corpus` / `manage_team_literature_server` |
| 多源搜索 | `collect_literature`（providers + queryExpansions） |
| 种子引用扩展 | `expand_citation_network`（bounded） |
| 初筛记录 | `manage_literature_corpus`（screening） |
| 避免重复分析 | `manage_literature_memory`（hash+版本缓存） |
| 验证一手来源 | `fetch_url`（最终 URL） |
| 导出 | `manage_literature_corpus` export |
