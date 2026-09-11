# Research Wiki ingest contract

Ingest is an explicit, source-backed synthesis operation. It is not triggered by reading a paper, searching the corpus, writing a note, or answering a question.

## Required sequence

1. Call `inspect_agent_tools` and record which paper, PDF, MinerU, asset, Artifact, note, Wiki, and coverage capabilities are actually available.
2. Search existing Wiki pages by title, alias, paper id, note id, type, and source.
3. Read relevant pages in full, including their evidence and related pages.
4. Build a source inventory with paper/note IDs, versions, PDF SHA-256, note revision/hash, Artifact commit, or official URL.
5. Extract knowledge units and map them to `topic`, `concept`, `method`, `system`, `dataset`, `synthesis`, or `question` pages.
6. Attach declaration-level evidence to every stable claim.
7. Preview the complete change set. Never create empty pages or write source material verbatim.
8. Apply with the exact preview fingerprint and a single batch authorization.
9. Re-read affected pages, run Wiki search, and run lint.

## Material rules

| Material | Allowed use | Not allowed |
| --- | --- | --- |
| Personal-library metadata | identity, version, material availability, discovery | technical claim evidence |
| PDF text | claim, method, limitation, direct quote | substitute for visual object checks when the issue is visual |
| Rendered PDF page / region / table | verify figures, tables, equations, axes, units, captions | silently replace the original page |
| MinerU Markdown/OCR | navigation, outline, candidate page ranges | primary technical evidence |
| Research note | working synthesis, user-authored interpretation, source lead | proof of a paper-reported fact without PDF verification |
| Acquired Artifact | implementation and reproduction evidence tied to commit/path | claim that code works or reproduces a result |
| Public official page/documentation | external context and availability | unrelated secondary summaries |

## Page decision rules

- Create a new page only when the knowledge unit is reusable and has a stable identity.
- Update the existing page when title, aliases, or semantics overlap.
- Return `no-op` when the normalized content and evidence are unchanged.
- Return `conflict` when the page changed after preview, expected hash is missing/mismatched, a source version is stale, or a duplicate label exists.
- Split a page when it contains independent concepts that would be searched, linked, or updated separately.
- Merge by updating the canonical page and listing aliases, not by creating a near-duplicate page.

## Evidence rules

- A paper claim needs `source_id`, PDF version, and a positive `pdf_page`.
- A note claim needs `source_id`, revision or hash, and a heading/locator when possible.
- An Artifact claim needs its parent paper and a commit, path, or official URL.
- A public-source claim needs the final HTTP(S) URL.
- MinerU output must never be encoded as a `paper` evidence locator unless the corresponding original PDF page was verified.
- A missing source is reported; it is never replaced with model memory.

## Writing rules

- Prefer claims, conditions, mechanisms, evidence, contradictions, and unresolved questions over a chronological paper summary.
- Distinguish direct report, code value, default/example value, and inference.
- State conflicts explicitly. Do not average incompatible findings.
- Link related knowledge with exact `[[Page title]]` labels or aliases.
- Keep HTML/Markdown excerpts short and do not store entire source documents.
