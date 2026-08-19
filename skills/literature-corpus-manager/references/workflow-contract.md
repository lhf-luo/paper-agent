# Workflow contract

## Collection stages

1. Frame: define the question, inclusion/exclusion rules, time range, venue/type constraints, and expected output.
2. Select: choose once/persistent and personal/team explicitly; default to once + personal.
3. Reuse: search the remote team service when configured, then the selected local corpus and versioned derived-task cache before external search or repeated generation.
4. Expand: record the primary query and explicit variants. Do not hide model-generated terms.
5. Search: use arXiv, OpenAlex, and Crossref by default. Add Semantic Scholar when its API is reachable or an API key is configured. Keep pagination bounded and record partial failures.
6. Normalize: merge only on exact DOI, arXiv id, provider record id, or material hash. Treat normalized title + first author + year and fuzzy-title matches as review candidates; never silently merge them.
7. Screen: state inclusion criteria and keep unresolved or rejected candidates visible in the handoff. Persist new material only in personal scope.
8. Save selection: when the user chooses candidates from a table, use a persisted `search_run_id` plus selected `paper_ids` as the source of truth. Save with `save_literature_selection` after exact confirmation, and report created, updated, unchanged, failed, and missing ids. Once-mode chat output is not a durable source.
9. Acquire: show the selected PDFs or artifact candidates and complete the exact code-level manifest confirmation before storing or cloning anything, even when the current request already names those acquisitions. In once mode, discovery never implies download or persistence. Discover paper artifacts before acquisition, revalidate cached hashes, Git commit, and remote before reuse, and never execute acquired content.
10. Package: build a material package with `build_paper_package` after records, PDF versions, and artifact manifests exist. The package row must join metadata, version, PDF, artifact, discovery source, screening status, reading status, and update time; missing materials remain explicit.
11. Organize: audit provenance, record new derived work with versioned keys, and export a human-reviewable snapshot.
12. Share: propose only explicitly selected, provenance-reviewed personal records to the team service, excluding personal notes and screening decisions, then require reviewer approval or rejection.
13. Verify: use primary papers and official artifacts for claims. Metadata, citation counts, and snippets cannot prove a claim.

## Common subtasks

- Find canonical records: focused query, identifiers, versions, and final URLs.
- Build a reading list: explicit criteria, deduplicated records, and provenance.
- Update a topic corpus: search existing records first; persistent identical runs avoid repeated API work.
- Reuse an analysis: compute the task key from immutable material hashes plus operation, pipeline, model/prompt, and config; look it up before generation.
- Snowball citations: relevant seeds, direction stated, depth at most two unless a human expands scope.
- Save selected results: durable `search_run_id`, selected `paper_ids`, confirmation fingerprint, and write outcome counts.
- Acquire materials: bounded downloads and an artifact manifest with hashes, commits, license hints, and failures.
- Build material packages: one package row per paper with metadata, versions, PDF blob/link, artifact manifest/acquisition, discovery path, screening status, reading status, and latest update time.
- Share with the team: audit personal records, select ids, propose with authenticated identity, then approve/reject in team scope.

## Implementation layout

Tool entrypoints are grouped under `src/tools/`. Shared core modules such as `literature-store.ts`, `literature-types.ts`, `literature-providers.ts`, `literature-download.ts`, `artifact-acquisition.ts`, `artifact-discovery.ts`, `operation-consent.ts`, and `network-security.ts` remain directly under `src/`. Do not move or duplicate core logic into a tool file just to satisfy a workflow; tools should orchestrate core modules.

## Human boundary

The agent may rank, summarize metadata, connect repeated patterns, and prepare evidence. A human remains responsible for close reading and interpretation, deciding whether an experiment is fair or sufficient, executing or trusting third-party code, accepting material into the team knowledge base, assessing novelty, and forming research ideas.
