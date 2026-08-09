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

Personal records live under `.paper-agent/corpus/personal/<namespace>/` unless a different corpus root is configured. The store keeps:

- normalized paper records and identifiers;
- provider provenance and search runs;
- content-addressed PDF versions;
- tags, notes, and screening state;
- versioned derived-memory keys;
- audit information;
- JSON, Markdown, CSV, and BibTeX exports;
- fail-soft imports from PDFs, directories, BibTeX, or Paper Agent JSON.

The Web curation controls are intentionally batch-oriented. Select one or more records, review the exact plan, confirm the fingerprint, and then apply tags, append a private note, or set `include`, `maybe`, or `exclude`. Leaving the screening selector at “do not change” preserves the current decision. Exporting with no selection means “export the whole current namespace,” not merely the visible text-filtered rows.

Persistent library mutations are code-gated. Search selections, citation-network results, local imports and rejection logs, PDF downloads, tags, notes, screening state, derived memory, and exports first produce an exact manifest fingerprint. A short-lived one-time grant can execute only that matching plan. Disposable `once` collection remains read-only unless the user explicitly chooses a persistent target.

## Reuse and duplicate work

Before repeating a persistent skim card, comparison matrix, or evidence graph, Paper Agent can compare a task key derived from material hashes and pipeline/model/prompt/config versions. Exact matches can be reused; changed inputs create new revisions instead of silently overwriting history.

Search results are discovery metadata. A record entering the personal library does not make every claim verified; primary PDFs and official artifacts remain the evidence source.

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

Readers can query the approved shared paper index by text and year range from the Web team page. Results are cursor-paginated. Contributors, reviewers, and administrators continue to see only the sections permitted by their authenticated role.

For roles, one-person testing, tokens, blobs, reviews, and backups, see [Team knowledge base](team-knowledge-base.md). For production TLS and deployment, see the [deployment guide](../deployment/team-corpus/README.md).
