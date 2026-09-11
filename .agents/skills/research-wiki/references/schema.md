# Wiki page contract

Paper Agent stores each namespace under `.paper-agent/wiki/{namespace}/` and rebuilds `.paper-agent/wiki/wiki.sqlite` from Markdown before Wiki reads.

The namespace is initialized with the matching folders `topics/`, `concepts/`, `methods/`, `systems/`, `datasets/`, `syntheses/`, and `questions/`. The folder is the default location for its page type, not a separate source of truth.

The root also contains generated `index.md` for Obsidian navigation and append-only `log.md` for page-write events. Both files are reserved management files: they are not Wiki pages, evidence, query results, or lint targets.

## Frontmatter

```yaml
---
id: wiki-stable-id
title: Page title
type: concept
status: draft
aliases: []
tags: []
source_notes: []
paper_ids: []
evidence:
  - id: E1
    kind: paper
    source_id: paper-...
    version: 64-character-pdf-sha256
    locator:
      pdf_page: 7
      section: "3.2"
      object: "Figure 2"
  - id: E2
    kind: note
    source_id: note-...
    version: note-content-sha256
    locator:
      note_revision: 3
      note_hash: note-content-sha256
      section: "Experiment boundary"
  - id: E3
    kind: artifact
    paper_id: paper-...
    version: commit-or-release
    locator:
      url: https://github.com/org/project
      commit: full-git-commit
      path: src/engine.ts
      line: 42
  - id: E4
    kind: public
    version: "2026-09-10"
    locator:
      url: https://example.org/official-document
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---
```

Allowed types are `topic`, `concept`, `method`, `system`, `dataset`, `synthesis`, and `question`.

Allowed statuses are `draft`, `needs-review`, `reviewed`, and `conflicted`. The Agent may create drafts and cause reviewed pages to return to `needs-review`; it must not claim human review.

`source_notes` and `paper_ids` remain readable for legacy pages; new pages derive them from `evidence`. A legacy page has page-level sources and receives `legacy-source-granularity` lint warnings until it is re-ingested.

## Claims

Every stable claim in the Markdown body must use an evidence marker:

```markdown
- The mechanism reduces stale references after reclamation. [E1]
- The measured improvement is conditional on the reported workload. [E1][E2][推断]
```

An evidence id must match `E1`, `E2`, and so on. A marker without a matching evidence item is an error. An evidence item not referenced by any claim is a warning. `[推断]` marks an explanation derived from the listed evidence rather than a statement made directly by a source.

## Storage

The Markdown files are the source of truth. `wiki.sqlite` contains a rebuildable page/evidence/claim/link/chunk/full-text index and must not be edited directly. A schema mismatch rebuilds the index from Markdown; it never reconstructs or modifies the Markdown body.
