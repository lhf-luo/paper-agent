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

| Mode | Use it for | Boundary |
| --- | --- | --- |
| `quick` | Decide whether a paper is relevant | Does not claim full-paper coverage |
| `methods` | Understand algorithms, formulas, implementation path, and directly related experiments | Does not audit unrelated pages |
| `full` | Complete physical-page and asset coverage with structured evidence | Artifact writes still require confirmation |
| `reproduce` | Full evidence audit, public artifact acquisition, code/config inspection, and reproduction planning | Never executes acquired code automatically |

From the Windows CLI, explicitly select the Pi agent:

```powershell
paper-agent --agent --mode reproduce D:\papers\example.pdf
```

Inside Pi:

```text
/paper reproduce "D:\papers\example.pdf"
```

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
