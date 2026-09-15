# Paper Research Workflow

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Paper Agent follows this division of responsibility:

```text
literature search
  -> obtain primary PDFs and public artifacts
  -> organize reusable evidence and provenance
  -> skim and screen
  -> inspect selected papers deeply
  -> human experiments and judgment
  -> human idea formation
```

The agent handles discovery, collection, indexing, evidence tracking, and memory. The researcher remains responsible for deep understanding, experimental decisions, novelty assessment, and ideas.

## Collect a topic

Use the Web **Search papers** page for a visual multi-provider run, provider health, selection, and confirmed import into the personal library.

In Pi, use `/collect` for a disposable personal search:

```text
/collect stateful network protocol fuzzing
```

Persist only when the collection should be reused:

```text
/collect --save --namespace thesis --max 30 stateful fuzzing
```

Collection checks the selected corpus first, expands explicit queries, searches providers, applies filters, paginates, deduplicates, reports partial failures, and records provenance. Search metadata is discovery evidence; technical claims still require a primary PDF or official artifact.

## Choose paper depth

Describe the research goal in natural language; there is no CLI mode argument. The `paper-research` Skill applies four research contracts:

- **快速略读** for relevance checks or when no goal is supplied;
- **方法精读** only when the request explicitly focuses on a method, formula, algorithm, or implementation path;
- **全文研究** for ordinary “精读”, deep reading, complete analysis, or paper-wide review;
- **复现准备** for reproduction or implementation requests, after the full-paper contract is complete.

Full-paper research and reproduction preparation cover every physical page, verify the major visual evidence, call `paper_progress`, and produce the fixed 12-section research report plus a reproduction-parameter table and unresolved questions. A bounded skim or method-only investigation must disclose its narrower coverage and does not imitate the complete report.

From the Windows CLI, explicitly select the Pi agent and add the goal after the PDF:

```powershell
paper-agent --agent D:\papers\example.pdf "Audit the paper and prepare reproduction requirements"
```

Inside Pi:

```text
/paper "D:\papers\example.pdf" Audit the paper and prepare reproduction requirements
```

For example, `/paper "D:\papers\example.pdf" 精读这篇论文` selects full-paper research, while `/paper "D:\papers\example.pdf" 只分析方法和公式` selects method close reading.

Add “并创建笔记” or “并保存研究结果” to request a Markdown note as part of the same workflow. The Skill reads the current skim, deep-reading, or comparison template, fills it with the verified analysis, and saves it through `manage_research_note` under the configured confirmation policy. Without a save request, the report stays in the conversation. A later explicit save request can also persist the completed report.

## Evidence gates

For complete work, Paper Agent:

1. confirms PDF identity, page count, and physical-page coverage;
2. indexes figures, tables, algorithms, captions, crop candidates, body mentions, sections, and context;
3. discovers PDF artifact links and records successful or failed acquisition provenance;
4. checks existing corpus and versioned derived memory before repeating work;
5. separates search metadata from primary-source evidence;
6. reports missing materials, tool failures, ambiguous mappings, and unverified claims.

Artifact acquisition accepts only bounded public HTTPS files and public HTTPS Git. Archives and repositories are not automatically extracted, installed, or executed.

Use the [Web interface](web-interface.md), [PDF and artifact workspace](pdf-artifact-workspace.md), and [Research workspace](research-workspace.md) guides for the corresponding visual workflows.
