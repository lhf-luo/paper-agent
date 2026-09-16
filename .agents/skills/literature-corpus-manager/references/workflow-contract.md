# Workflow contract

## Collection stages

1. Frame: define the question, inclusion/exclusion rules, time range, venue/type constraints, and expected output.
2. Select: choose once/persistent and personal/team explicitly; default to once + personal.
3. Reuse: search the remote team service when configured, then the selected local corpus and versioned derived-task cache before external search or repeated generation.
4. Expand: record the primary query and explicit variants. Do not hide model-generated terms.
5. Search: use arXiv, OpenAlex, and Crossref by default. Add Semantic Scholar when its API is reachable or an API key is configured. ACL Anthology and USENIX are optional official sources: ACL requires one exact year and one supported venue, while USENIX may preserve successful papers alongside detail-level warnings. Keep pagination bounded and record partial failures.
6. Normalize: merge only on exact DOI, arXiv id, provider record id, or material hash. Treat normalized title + first author + year and fuzzy-title matches as review candidates; never silently merge them.
7. Enrich selected records: after discovery and denoising, use the configured exact-DOI providers to fill missing metadata. Preserve the selected record's title, authors, and id. A missing credential, no result, timeout, rate limit, or other provider failure is a warning and must not block saving.
8. Screen: proactively denoise every externally collected run before presenting it. Use `filter_search_run_results` against the persisted run, applying positive inclusion criteria first and cautious title-scoped exclusions for obvious noise. Filtering preserves the original run and saves a session-scoped result snapshot. Report before/after counts and noise categories, and keep unresolved borderline candidates visible. If obvious noise remains, refine the rule; otherwise pass the complete `filter_result_id` and `search_run_id` to `update_literature_sidebar`. Never choose a title-based subset. Ask only when the relevance boundary would materially change the requested scope. Persist new material only in personal scope.
9. Save selection: for one search run, use its persisted `search_run_id` plus selected `paper_ids`. For a list created by `update_literature_sidebar`, pass the returned `mdUrl` as `sidebar_result_url`; the save tool resolves hidden IDs across all contributing search runs, so the Agent must not repeat the search to recover IDs. Save after exact confirmation and report created, updated, unchanged, failed, and missing ids. Once-mode search runs are durable in the personal SQLite database; visible chat text alone is not a source of truth.
9a. Edit an existing list: use `edit_literature_sidebar` with the existing `mdUrl`, expected revision, and structured add/replace/remove/patch operations. Bibliographic additions and replacements must reference a persisted `search_run_id` plus `paper_id`; query by complete title and first author when metadata must be recovered. Keep the same URL, never rewrite the Markdown manually, and do not claim the personal library changed because this operation changes only the list.
10. Acquire: show the selected PDFs or artifact candidates and complete the exact code-level manifest confirmation before storing or cloning anything, even when the current request already names those acquisitions. In once mode, discovery never implies download or persistence. Before a GitHub search, inspect the stored abstract for an explicitly named implementation; when it is absent or unclear, read the PDF abstract and introduction pages. Record the supporting sentence, reject names guessed only from title punctuation or generic acronyms, and inspect automatically generated queries before using their results. Search GitHub by a verified implementation/tool name first, then DOI, exact title plus author surname, and distinctive terms plus author surname. Model memory may supply an untrusted lead only after deterministic discovery fails; verify it with public primary evidence before using `additional_candidate_urls`. Revalidate cached hashes, Git commit, and remote before reuse, and never execute acquired content.
11. Package: build a material package with `build_paper_package` after records, PDF versions, and artifact manifests exist. The package row must join metadata, version, PDF, artifact, discovery source, screening status, reading status, and update time; missing materials remain explicit.
12. Organize: audit provenance, record new derived work with versioned keys, and export a human-reviewable snapshot.
13. Research notes: search existing notes first, then create or update Markdown through `manage_research_note`. Note bodies live under `.paper-agent/notes/{namespace}/`; SQLite contains their index and paper relationships only. Every linked paper must already exist in that namespace, and deleting a paper removes only the relationship.
14. Zotero transfer: use the official local API and exact item/collection keys. Preserve complete ancestor paths and multiple memberships; treat unreadable PDFs as non-blocking warnings, require confirmation, and never edit either SQLite database directly.
15. Share: propose only explicitly selected, provenance-reviewed personal records to the team service, excluding personal notes and screening decisions, then require reviewer approval or rejection.
16. Verify: use primary papers and official artifacts for claims. Metadata, citation counts, and snippets cannot prove a claim.

## Common subtasks

- Find canonical records: focused query, identifiers, versions, and final URLs.
- Build a reading list: explicit criteria, deduplicated records, and provenance.
- Denoise collected results: filter the persisted run without re-searching, retain the original record set, and report retained and unresolved counts.
- Update a topic corpus: search existing records first; persistent identical runs avoid repeated API work.
- Reuse an analysis: compute the task key from immutable material hashes plus operation, pipeline, model/prompt, and config; look it up before generation.
- Snowball citations: relevant seeds, direction stated, depth at most two unless a human expands scope.
- Save selected results: durable `search_run_id`, selected `paper_ids`, confirmation fingerprint, and write outcome counts.
- Edit a sidebar list: existing result URL, expected revision, structured operations, exact persisted source handles, and the new revision.
- Acquire materials: bounded downloads and an artifact manifest with hashes, commits, license hints, and failures.
- Build material packages: one package row per paper with metadata, versions, stored PDF path/link, artifact manifest/acquisition, discovery path, screening status, reading status, and latest update time.
- Share with the team: audit personal records, select ids, propose with authenticated identity, then approve/reject in team scope.

## Implementation layout

Tool entrypoints are grouped in feature `presentation/` directories. Domain models live under `domain/`, use cases under `application/`, and storage or external-service adapters under `infrastructure/`. Presentation tools may orchestrate application services but must not duplicate domain, storage, consent, or network-security logic.

## Human boundary

The agent may rank, summarize metadata, connect repeated patterns, and prepare evidence. A human remains responsible for close reading and interpretation, deciding whether an experiment is fair or sufficient, executing or trusting third-party code, accepting material into the team knowledge base, assessing novelty, and forming research ideas.
