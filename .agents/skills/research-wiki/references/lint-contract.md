# Research Wiki lint contract

Lint is read-only. It rebuilds the Markdown-derived index and reports deterministic issues; it does not repair or semantically reinterpret pages.

## Error classes

- invalid frontmatter or unsupported type/status;
- duplicate page id or duplicate title/alias;
- missing paper/note/Artifact parent source;
- missing evidence used by a `[E#]` marker;
- invalid evidence locator;
- `conflicted` page without a contradiction and open-question section.

## Warning classes

- stale paper version, note revision/hash, or Artifact snapshot;
- legacy page-level sources without declaration-level locators;
- unused evidence entries;
- empty pages, missing source lists, self-links, or broken Wiki links;
- near-duplicate pages with the same type;
- index-versus-Markdown inconsistency.

## Repair flow

1. Read the affected pages and source snapshots.
2. Explain each issue and whether it blocks a query or only weakens provenance.
3. Build a new batch preview with corrected evidence, links, aliases, or body claims.
4. Obtain the normal Wiki write authorization and apply the batch.
5. Re-run lint and report remaining issues.

Do not fix lint findings by editing Markdown, SQLite, or `.paper-agent/wiki/` directly.
