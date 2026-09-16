# Personal and Team Libraries

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Paper Agent keeps scope and lifetime as two independent choices.

| Dimension | Option | Meaning |
| --- | --- | --- |
| Scope | `personal` | Local records, private notes, local screening, and unreviewed research memory |
| Scope | `team` | Shared records that pass proposal and role-based review |
| Lifetime | `once` | Disposable work that does not create new long-term knowledge by default |
| Lifetime | `persistent` | Reusable records and versioned derived-memory entries |

The default is `personal + once`.

## Personal library

Use the Web **Search papers** page to run discovery and explicitly save selected results. Use **Personal library** to search records and private notes, filter by screening state, inspect PDF versions, apply tags/notes/decisions to a selection, export a selection or namespace, and prepare PDF downloads.

In Pi:

```text
/collect --save --namespace thesis stateful fuzzing
/library
/library search stateful fuzzing
/library export bibtex
/library audit thesis
```

All personal namespaces share `.paper-agent/corpus/personal.sqlite` unless a different corpus root is configured. PDF files live under `.paper-agent/files/personal/<namespace>/<paperId>/` with readable title-based names. The store keeps:

- normalized paper records and identifiers;
- provider provenance and search runs;
- readable PDF versions with SHA-256 integrity and exact-duplicate metadata;
- tags, notes, and screening state;
- versioned derived-memory keys;
- audit information;
- JSON, Markdown, CSV, and BibTeX exports;
- fail-soft imports from PDFs, directories, BibTeX, or Paper Agent JSON.

The Web curation controls are intentionally batch-oriented. Select one or more records and apply tags, append a private note, or set `include`, `maybe`, or `exclude`. When confirmation is enabled, review the exact plan and fingerprint before applying it. Leaving the screening selector at “do not change” preserves the current decision. Download, organize, and export actions require an explicit paper selection.

Each persisted paper keeps one permanent `paper_id`. Later DOI enrichment or exact deduplication adds aliases without renaming that ID. A paper may have separate formal and preprint publication versions; the formal version is preferred when both exist. Local PDF imports are treated as formal versions. PDF download skips papers that already have a local file, tries formal candidates before preprints, and accepts one explicit publication-version ID when a particular version is required.

Persistent library mutations are code-gated. Search selections, citation-network results, local imports and rejection logs, PDF downloads, tags, notes, screening state, derived memory, and exports first produce an exact manifest fingerprint. A short-lived one-time grant can execute only that matching plan. Ordinary personal-library writes do not ask by default; local policy issues the grant when human confirmation is disabled. Deletion, research-workspace changes, and PDF/Artifact operations ask by default. See the [confirmation model](web-interface.md#confirmation-model).

`once` collection does not merge candidate records into the personal paper library, but it does persist a local search run for later selection. It is not a no-storage mode. Saving selected candidates is a separate persistent write.

## Reuse and duplicate work

Before repeating generated analysis, Paper Agent can compare a task key derived from material hashes and pipeline/model/prompt/config versions. Exact derived-cache matches can be reused. Human-readable research work is stored separately as linked Markdown notes.

Search results are discovery metadata. A record entering the personal library does not make every claim verified; primary PDFs and official artifacts remain the evidence source.

Screening can require several concept groups: terms within one group are alternatives, while all groups must match. A missing abstract that prevents a decision remains `unresolved`. Each filtering call creates a complete new sidebar baseline; later small edits update that document by `paper_id`, and re-running the filter creates another baseline. Search runs also retain the status of every query/provider execution, including partial, failed, and skipped work.

## Moving content to a team

Personal data never becomes team data automatically:

```text
personal record
  -> privacy-scrubbed preview
  -> explicit confirmation
  -> team-proposed
  -> reviewer approval or rejection
```

Personal notes and screening opinions are removed before proposal. Tags, public links, and provenance remain. Generated analysis must be human-reviewed before it can be proposed as team derived memory.

Readers can query shared papers by text and year range from the Web team page. Results are cursor-paginated. Paper search and lookup by ID currently do not filter review states, so results may include proposed or rejected papers; inspect the returned state before treating a record as approved. Contributors, reviewers, and administrators see the sections permitted by their authenticated role. See the [team review limitations](team-knowledge-base.md#proposal-and-review-flow).

For roles, one-person testing, tokens, blobs, reviews, and backups, see [Team knowledge base](team-knowledge-base.md). For production TLS and deployment, see the [standalone server guide](../team-server/README.md).
