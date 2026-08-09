---
name: literature-corpus-manager
description: Build, update, audit, and share evidence-traceable literature corpora with paper-agent. Use for systematic or exploratory literature collection, query expansion, multi-source search, deduplication, PDF and artifact acquisition, personal/team library separation, once/persistent workflows, citation expansion, exports, and avoiding repeated analysis. This skill organizes research memory; it does not replace human deep reading, experiments, interpretation, or idea formation.
---

# Literature corpus manager

Use paper-agent tools as the single implementation of collection, storage, acquisition, and security rules. Do not reimplement downloads or edit corpus manifests by hand.

## Route the request

1. Identify the research question and desired deliverable.
2. Choose:
   - once for a disposable search;
   - persistent for reusable records and cached results;
   - personal for unreviewed work;
   - team for read-only reuse or explicit review of proposed material; never collect directly into it.
3. If the user did not specify a mode, use once + personal and state that choice.
4. Read [workflow contract](references/workflow-contract.md) for collection and handoff rules.
5. Read [corpus policy](references/corpus-policy.md) before persistent, team, promotion, download, or artifact work.

## Execute

1. Search the selected corpus first. When `PAPER_AGENT_TEAM_SERVER_URL` is configured, use `manage_team_literature_server` search for shared team knowledge; otherwise use `search_literature_corpus` for a local corpus. Use `collect_literature` with corpus reuse enabled only after existing records are checked.
   If existing material is only in a local PDF directory, BibTeX file, or paper-agent JSON export, use `import_literature_corpus` into personal scope and inspect its rejection log first.
2. Before repeating a skim card, comparison matrix, or evidence map, use `manage_literature_memory` lookup with material hashes and tool/model/prompt/config versions. Reuse an exact hit unless refresh is explicit.
3. Write a focused primary query and explicit variants for acronyms, synonyms, author/title forms, and adjacent terminology.
4. Use `collect_literature` with documented filters and bounded pagination. Preserve partial provider failures and possible-duplicate review candidates.
5. Review deduplication and provenance before persisting or promoting records. Persist new collection in personal scope only.
6. Use `expand_citation_network` only from relevant personal seeds and keep depth bounded.
7. Use `download_literature_pdfs` for selected papers, not an unreviewed result dump. Always complete the tool's exact manifest confirmation before bytes are stored, even when the user already named the papers; once mode never implies download or persistence.
8. For a paper PDF, run `discover_paper_artifacts` before `acquire_paper_artifacts`. Always complete the tool's exact candidate-manifest confirmation before acquisition. Never execute or auto-extract acquired content.
9. Use `manage_literature_corpus` for local annotate/audit/export/promotion. For the central service, use `manage_team_literature_server` to propose explicitly selected, provenance-reviewed personal records into `team-proposed`, then have a reviewer explicitly approve or reject them. Exclude personal notes and screening decisions from every proposal; the server scrubs them again.
10. After producing reusable generated work, record it with `manage_literature_memory`; keep it separate from user notes and source metadata.

## Handoff

Report:

- question, query variants, filters, providers, pages, and date;
- included records, duplicates merged, rejected or unresolved candidates;
- source failures, missing PDFs/artifacts, hashes and commits when acquired;
- mode, scope, namespace, cache status, and corpus/export paths;
- reused corpus hits, exact analysis-cache hits, possible duplicates, screening decisions, and pending team reviews;
- what requires human reading, experimental verification, or novelty judgment.

Search metadata is discovery evidence only. For technical claims, open the primary paper or official artifact and follow the paper-agent evidence gates.
