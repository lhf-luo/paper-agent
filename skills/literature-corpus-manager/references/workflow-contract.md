# Workflow contract

## Collection stages

1. Frame: define the question, inclusion/exclusion rules, time range, venue/type constraints, and expected output.
2. Select: choose once/persistent and personal/team explicitly; default to once + personal.
3. Reuse: search the remote team service when configured, then the selected local corpus and versioned derived-task cache before external search or repeated generation.
4. Expand: record the primary query and explicit variants. Do not hide model-generated terms.
5. Search: use arXiv, OpenAlex, and Crossref by default. Add Semantic Scholar when its API is reachable or an API key is configured. Keep pagination bounded and record partial failures.
6. Normalize: merge only on exact DOI, arXiv id, provider record id, or material hash. Treat normalized title + first author + year and fuzzy-title matches as review candidates; never silently merge them.
7. Screen: state inclusion criteria and keep unresolved or rejected candidates visible in the handoff. Persist new material only in personal scope.
8. Acquire: show the selected PDFs or artifact candidates and complete the exact code-level manifest confirmation before storing or cloning anything, even when the current request already names those acquisitions. In once mode, discovery never implies download or persistence. Discover paper artifacts before acquisition, revalidate cached hashes, Git commit, and remote before reuse, and never execute acquired content.
9. Organize: audit provenance, record new derived work with versioned keys, and export a human-reviewable snapshot.
10. Share: propose only explicitly selected, provenance-reviewed personal records to the team service, excluding personal notes and screening decisions, then require reviewer approval or rejection.
11. Verify: use primary papers and official artifacts for claims. Metadata, citation counts, and snippets cannot prove a claim.

## Common subtasks

- Find canonical records: focused query, identifiers, versions, and final URLs.
- Build a reading list: explicit criteria, deduplicated records, and provenance.
- Update a topic corpus: search existing records first; persistent identical runs avoid repeated API work.
- Reuse an analysis: compute the task key from immutable material hashes plus operation, pipeline, model/prompt, and config; look it up before generation.
- Snowball citations: relevant seeds, direction stated, depth at most two unless a human expands scope.
- Acquire materials: bounded downloads and an artifact manifest with hashes, commits, license hints, and failures.
- Share with the team: audit personal records, select ids, propose with authenticated identity, then approve/reject in team scope.

## Human boundary

The agent may rank, summarize metadata, connect repeated patterns, and prepare evidence. A human remains responsible for close reading and interpretation, deciding whether an experiment is fair or sufficient, executing or trusting third-party code, accepting material into the team knowledge base, assessing novelty, and forming research ideas.
