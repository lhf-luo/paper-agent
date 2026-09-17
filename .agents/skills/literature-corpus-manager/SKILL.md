---
name: literature-corpus-manager
description: Build, update, audit, and share evidence-traceable literature corpora with paper-agent. Use for systematic or exploratory literature collection, query expansion, multi-source search, deduplication, PDF and artifact acquisition, personal/team library separation, once/persistent workflows, citation expansion, exports, and avoiding repeated analysis. This skill organizes research memory; it does not replace human deep reading, experiments, interpretation, or idea formation.
---

# Literature corpus manager

Use paper-agent tools as the single implementation of collection, storage, acquisition, and security rules. Do not reimplement downloads or edit `personal.sqlite`, personal PDF directories, or artifact manifests by hand.

Tool entrypoints live in each feature's `presentation/` layer. Domain rules, application use cases, and infrastructure adapters stay in their corresponding feature layers and are reused by the tools.

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

## End-to-end workflow

This skill implements five connected tasks:

1. Literature-search planning and candidate-table output.
2. Seed-paper citation/reference expansion.
3. Saving selected candidates into a personal corpus.
4. PDF and artifact acquisition for saved papers.
5. Building a traceable paper material package.

### 1. Plan and collect literature

Use this when the user asks for a literature review, related work, reading list, topic survey, or candidate paper table.

1. Restate the research object, problem, scenario, and time range in one sentence before searching.
2. Call `plan_literature_search` with domain terms, problem terms, method terms, primary query, explicit query variants, and year filters when available.
3. Use the returned query variants as the starting point for `collect_literature`; add only explicit variants that can be explained in the handoff.
4. Search existing reusable records first. When the redacted team connection status reports an active `pateam1.` access-file connection, use `manage_team_literature_server` search for shared team knowledge; otherwise use `search_literature_corpus` for a local corpus.
5. Use `collect_literature` with corpus reuse enabled, documented filters, bounded pagination, and the structured search plan. Collection automatically attempts DOI-based abstract completion through configured Crossref, OpenAlex, and Semantic Scholar providers before saving the Search Run.
6. Keep the search-run ID, search coverage, abstract-enrichment status, provider failures, possible duplicates, corpus-hit count, and the bounded candidate Paper ID/title list visible. Retrieve full metadata, abstracts, discovery paths, PDF links, and artifact links from the stored search run only when needed.

**Mandatory screening after collection:**

- Screen and denoise every externally collected search run before presenting a literature list. This is routine quality control: perform it proactively and do not ask the user whether routine denoising should be performed. Filtering preserves the search run and saves only a session-scoped selection snapshot.
- After duplicate review, call `filter_search_run_results` with the persisted `search_run_id`. Each group has `with_abstract` rules for title+abstract and `without_abstract` rules for title only. Use `include_term_groups` when several concepts are required: terms inside a group are alternatives (OR), while every group is required (AND). Use exclusion terms only for clearly unrelated concepts; prefer `exclude_scope=title` for broad words so an incidental abstract mention cannot remove a relevant paper.
- Papers with abstracts that pass are `matched`. Papers without abstracts can only be `unresolved`, and only when they pass an explicit positive title rule in `without_abstract`; missing positive rules exclude them. Thus `unresolved` means "passed title screening but lacks an abstract for verification", not "every record without an abstract".
- Filtering returns every unique matched and unresolved Paper ID/title, counts for the current source and root run, and a `filter_result_id`. If the result still has obvious noise, call the tool again with `source_filter_result_id` to narrow the retained subset. To loosen a rule, restart from the root `search_run_id`. Once the rule is accepted, do not select a subset by title or silently drop unresolved papers.
- Pass `filter_result_id` and `search_run_id` to `update_literature_sidebar`. The tool imports every retained paper directly from the filter snapshot and stored search run; the Agent may add provisional title-based `focus`, `relevance`, and `topic` annotations by Paper ID. Use `get_search_run_papers` only when full metadata or a specific abstract is needed.
- `collect_literature` automatically merges records whose normalized titles and normalized first authors are exactly equal, including preprint and formal-publication records from different years. Review only fuzzy-title candidates and exact title/first-author matches that report conflicting DOI or arXiv identifiers.

7. Report the recorded status for every query/provider execution: succeeded, partial, failed, or skipped. Providers can be circuit-broken mid-collection; skipped remaining queries are not successful coverage. Other providers continue normally.
8. Use once mode for exploration. Use persistent mode only when the user wants reusable search results and accepts the confirmation prompt.
9. State unsupported sources. Do not claim Google Scholar was searched because this project has no Google Scholar provider.
10. Distinguish provider capabilities. `collect_literature` accepts keyword-search providers only. OpenCitations and Unpaywall are DOI enrichment providers, not unavailable search providers; do not include them in a keyword-provider status table.
11. Treat ACL Anthology as a directed optional source, not a broad default. Select it only when the plan has one exact year and one supported ACL-family venue; otherwise omit it instead of issuing an invalid request.
12. Use the optional USENIX provider for official systems, security, networking, and software-engineering proceedings. It may return useful papers with detail-level warnings; report that as a partial result rather than treating the entire provider as failed or silently dropping the warnings.

### 1.1 Deliver and edit the generated sidebar

- For the normal filter flow, do not construct a Markdown table or repeat complete metadata. Pass the accepted filter's `filter_result_id`, `search_run_id`, and optional `annotations: [{ paper_id, focus, relevance, topic }]` to `update_literature_sidebar`. Treat all annotations as title-based initial judgments, not claims from abstracts. Missing annotations do not remove papers; report the tool's incomplete-annotation count.
- The tool builds one combined Markdown table, marks unresolved papers for review, and returns its `mdUrl` as the sidebar link. Keep abstracts in the Search Run; do not put them in annotations or the Markdown document.
- To correct or extend an existing list, call `edit_literature_sidebar` with that list's `mdUrl` and current revision. Apply small changes by Paper ID; the tool reports added, removed, and updated IDs.
- For bibliographic corrections, query `search_literature` with the complete title and first author, verify title/author/identifier agreement, then use the returned `searchRunId` and candidate `paperId` with `replace_from_search`. A search candidate is not a completed correction until the edit succeeds.
- Never regenerate the whole list or edit its Markdown by hand just to add a DOI, replace a record, remove a row, or change focus/relevance/topic.
- Do not print the table in the chat reply. Report counts, focus distribution, notable papers, and the document link.

### 2. Expand from seed papers

1. Use `expand_citation_network` only after the seed papers are relevant and already in a personal corpus.
2. Keep direction and depth explicit. Default to bounded depth; do not use citation snowballing as a substitute for a documented query strategy.
3. Pass the seed search run as `source_search_run_id` when known. Preserve the citation expansion table, including seed id, relationship, depth, actual source provider, and discovery path.
4. After expansion, build ONE combined markdown table of the discovered neighboring papers (same `标题 | 年份/venue | 标识 | focus` format with a `focus` column) and pass it to `update_literature_sidebar` — the sidebar is the ONLY place the expansion list is shown. Do NOT print the markdown table in the chat reply; give a short summary instead (seed → neighbor counts, focus distribution, notable neighbors, next steps).

### 3. Save selected results

Use this when the user chooses papers from a candidate table and wants them kept in the personal library.

1. Use a persisted `search_run_id` for a single search run. Search runs are saved in the namespace-scoped search tables in `.paper-agent/corpus/personal.sqlite` even in once mode (once only skips merging candidate papers into the library), so a once-mode run can still feed `save_literature_selection`; never rely on chat memory as the source of truth.
2. If `update_literature_sidebar` produced a combined list, pass its returned `mdUrl` as `sidebar_result_url` to `save_literature_selection` and omit `search_run_id`. The tool resolves each row's hidden `paper_id` and `search_run_id`, including rows drawn from multiple runs. Never rerun a search merely to recover IDs.
3. Omit `paper_ids` to save all search-backed rows in that sidebar, or pass selected IDs when the user selected a subset. Model-supplement rows are ignored. The result returns paper IDs grouped by `focus`, which can be passed to `manage_literature_collections` for follow-up classification.
4. Optional `collection` argument: the name of the target folder/collection the papers should go into. If a collection with that name already exists in the target corpus it is reused (no duplicate), otherwise it is created. When omitted the papers stay uncategorized — the user can later move them in the library UI (Personal → 分类 sidebar, select papers and use “把已勾选论文移到”). Ask the user which folder, or propose one per the user's research directions; let the user confirm rather than guessing.
5. Complete the exact confirmation prompt before writing.
6. Report created, updated, unchanged, failed, and missing ids, plus which collection the papers were saved into.
7. Resolve reported possible duplicates with `review_literature_duplicates` before final screening when evidence is sufficient. A same-work decision merges only the search-run records under the chosen left ID; a paper ID already persisted in the personal library is never rewritten.

When the user asks about one paper that may already be saved, call `get_personal_library_paper` with its exact title, paper ID, DOI, or arXiv ID before using an external Provider. The result distinguishes remote PDF download links from locally saved PDF versions and also returns classifications, notes, provenance, and Artifact records. If it returns multiple or approximate candidates, retry with the selected `paper_id`; never guess which record the user meant.

### 3.1 Import local literature

Use this when the source of truth is a local PDF, PDF directory, BibTeX file, or paper-agent JSON export rather than a persisted search run.

1. Call `import_literature_corpus`; pass `collection` in the same call when the user names a destination collection. The tool reuses the same-name collection or creates it as part of the confirmed import.
2. Treat title and authors as required evidence. Prefer valid embedded metadata, then the first two pages of PDF text, then bilingual OCR. Ignore publisher or producer placeholders such as `CNKI`. If those stages remain incomplete but the PDF itself contains an exact DOI, configured DOI providers may recover missing title or authors from that exact record. Never use a filename or fuzzy provider match as required metadata. Report every remaining `needsMetadata` file and do not claim it was saved. Provider warnings or no matches never make an otherwise valid local import fail, and provider metadata must not replace title or authors already extracted from the PDF.
3. Do not call `save_literature_selection` for a local-import paper id. That tool only selects records from its named persisted search run.
4. Treat a locally imported PDF as the formal publication version. When the record has a DOI it is linked to that formal version; the user is responsible for the DOI/PDF match.
5. Use `manage_literature_collections` to list, create, rename, delete, assign, or unassign collections for papers already in the personal library.
6. Use `manage_literature_corpus` with `action=delete` only for an explicitly requested personal-paper deletion and complete its destructive confirmation.
7. Never edit `personal.sqlite`, personal PDF directories, artifact manifests, or search indexes by hand. Use the registered tools and storage APIs.

### 3.2 Transfer with Zotero

1. Use `search_zotero_library` to inspect the local Zotero collection tree and obtain exact item or collection keys. Zotero must be running with its Local API enabled.
2. Use `import_zotero_papers` for Zotero → personal. Preserve complete ancestor paths: selecting `A/B` must create or reuse `A` and `A/B`, never flatten `B` into a root collection. Missing or unreadable PDFs are warnings and do not block valid metadata.
3. Use `export_papers_to_zotero` for personal → Zotero. The first write may require the user to approve Zotero's authorization dialog. Copy complete collection paths, public bibliographic metadata, tags, and one preferred PDF.
4. Match by stored mapping, DOI, arXiv ID, PDF hash, then exact normalized title plus one matching author. Identifier conflicts require review and must not be overwritten automatically.
5. Zotero transfer is an explicit copy/update operation. Never propagate deletion or transfer Zotero annotations, child notes, personal notes, screening status, research records, or Artifacts. Never read or edit `zotero.sqlite` directly.

### 4. Acquire PDF and artifact materials

Use this after candidate papers have been screened or explicitly selected.

1. Use `download_literature_pdfs` for selected saved papers when PDF bytes are needed. Do not download every unreviewed candidate by default. Existing local PDFs are skipped. For a new download, try the formal publication first and use the preprint as fallback; pass one `publication_version_id` with one `paper_id` only when the user explicitly requests a particular version. A successful fallback URL is written back to the personal paper. Provider errors and missing credentials are non-blocking discovery warnings. Never construct fallback URLs manually or bypass the downloader's HTTPS, SSRF, redirect, size, and PDF-signature checks.
2. Use `translate_personal_pdf` only for an already saved PDF version. First query the exact personal paper, then pass its `paper_id` and registered source PDF SHA-256. The tool uses the configured PDF2zh Next engine (`SiliconFlowFree` by default or the active Paper Agent model) and saves a non-preferred translation version beside the source; it never overwrites the source PDF. Do not pass a translation version back into the tool.
3. For page-aware full-paper reading, call `generate_mineru_material` once for the saved paper, then use `read_mineru_material` by outline, physical page, or search term. Reuse current material unless the user explicitly requests a rebuild. MinerU OCR, formulas, and tables are derived evidence; verify critical claims against the original PDF tools.
4. For a saved paper, inspect its material package before downloading anything so an existing local PDF is reused. Always pass `paper_id` plus namespace; PDF-only calls are for unsaved papers. Pass `source_directory` when an extracted arXiv LaTeX bundle is available.
5. Before accepting or generating any GitHub query, call `get_personal_library_paper` and read the stored abstract. Identify the implementation name or project acronym from explicit author language such as "we present X", "our system X", or "the implementation of X". Record the name and its abstract sentence as the query rationale. This lightweight abstract check is mandatory for every paper, even when `discover_paper_artifacts` can generate queries automatically.
6. If the abstract is absent or does not explicitly name the implementation, use `read_pdf` on the abstract and introduction pages (normally physical pages 1-4). Read further only when those pages point to an artifact or named system elsewhere. Do not infer a project name solely from title punctuation, the first title word, an all-caps paper-session label, or a generic domain acronym. Words such as `poster`, `paper`, `machine`, `method`, `system`, `framework`, `analysis`, `detection`, `for`, and a standalone `UAF` are not valid project names without explicit in-paper naming evidence.
7. Run `discover_paper_artifacts` before `acquire_paper_artifacts`, then inspect every reported `github-search` query. Automatic query generation is candidate evidence, not a substitute for the abstract/PDF check. Ignore a generic or unsupported query and do not present its repositories as paper Artifacts.
8. If PDF evidence has no credible paper-owned Artifact, search GitHub first by the verified implementation name or acronym (for example `MLTA`, `TypeDive`, `RTT`, or `SAVIOR`). If no tool name is stated, use DOI, then exact title plus an author surname, and only then distinctive method terms plus an author surname. Do not search by a generic title token alone. Verify a repository found through an Agent-selected query, then add its URL through `additional_candidate_urls` so the manifest records it.
9. Verify that a repository is the paper authors' own release from author-release language, README tool-name/title/method/arXiv/DOI matches, and owner identity. Reject cited baselines, dependencies, tokenizers, paper lists, slide repositories, and repositories merely mentioning or using the paper. A README containing the exact paper title is not by itself high-confidence ownership evidence. GitHub fallback candidates are selected by default only when confidence is high; medium and low matches require explicit `candidate_ids`.
10. Only after deterministic PDF, metadata, tool-name, DOI, author-qualified GitHub searches find no credible candidate may model memory suggest a repository name, owner, or URL. Memory is an untrusted lead, not provenance: verify it against a public GitHub README, author/lab organization page, paper title, DOI, or author evidence. Add only a verified URL through `additional_candidate_urls`; if verification fails, report that no Artifact was found.
11. Complete the exact candidate manifest confirmation before downloading or cloning. For a saved personal paper, pass `paper_id` and namespace so the completed manifest is associated in SQLite.
12. Git repositories are acquired by bounded shallow clone into `<paperId>/artifacts/<project>/`; `fetch_url` is only for read-only primary-source verification. Non-Git files use the bounded HTTP downloader under `<paperId>/artifacts/downloads/`.
13. Use `additional_candidate_urls` for a supported public HTTPS URL found in other public evidence. It is a per-call input, not a config field, and a raw URL must never be passed as `candidate_ids`.
14. Never execute, install dependencies from, or auto-extract acquired content. The default per-artifact limit is 200 MB and the hard maximum is 500 MB; it also applies to the cloned repository working tree and `.git` data.
15. On Windows, do not rename upstream Git paths containing `:` or other NTFS-reserved forms. The acquisition service excludes those paths and conventional committed build/run output through sparse checkout and records the safely named excluded directories in the manifest.
16. Preserve discovery method/query, tool-name evidence, source URL, final URL, SHA-256, readable personal PDF path, commit, license hints, and failure reason when available. SHA-256 is for integrity, exact duplicate detection, and transfer verification; it is not the personal PDF filename. Team storage may still expose a content-addressed blob reference.

### 5. Build a paper material package

Use this after selected papers have been saved and the user wants traceable materials for one paper.

1. Confirm the target `paper_id` is in the personal corpus.
2. Call `build_paper_package` with `paper_id` and namespace. Associated manifests are loaded from SQLite automatically; use `artifact_manifest_paths` only for temporary or legacy unassociated manifests.
3. Report the material package row: `paper_id | 元数据 | 版本 | PDF | artifact | 发现来源 | 筛选状态 | 阅读状态 | 更新时间`.
4. If PDF or artifact material is missing, say it is missing instead of inferring availability from metadata.
5. A manifest containing only failed acquisitions is still missing material. Treat an artifact as available only when the latest successful snapshot has a real local path.

## Tool map

| Task                             | Tool                            | Implementation file                                                    |
| -------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Plan search                      | `plan_literature_search`        | `src/literature/presentation/collection-search-tools.ts`               |
| Collect candidates               | `collect_literature`            | `src/literature/presentation/collection-query-tools.ts`                |
| Screen and denoise results       | `filter_search_run_results`     | `src/literature/presentation/collection-query-tools.ts`                |
| Review possible duplicates       | `review_literature_duplicates`  | `src/literature/presentation/collection-query-tools.ts`                |
| Search local corpus              | `search_literature_corpus`      | `src/literature/presentation/collection-query-tools.ts`                |
| Inspect one personal paper       | `get_personal_library_paper`    | `src/literature/presentation/personal-library-query-tool.ts`           |
| Expand seeds                     | `expand_citation_network`       | `src/literature/presentation/citation-expansion-tool.ts`               |
| Edit an existing sidebar list    | `edit_literature_sidebar`       | `src/literature/presentation/collection-search-tools.ts`               |
| Save selected results            | `save_literature_selection`     | `src/literature/presentation/collection-search-tools.ts`               |
| Import local literature          | `import_literature_corpus`      | `src/literature/presentation/literature-import-tools.ts`               |
| Search Zotero                    | `search_zotero_library`         | `src/extensions/zotero/presentation/zotero-tools.ts`                   |
| Import from Zotero               | `import_zotero_papers`          | `src/extensions/zotero/presentation/zotero-tools.ts`                   |
| Export to Zotero                 | `export_papers_to_zotero`       | `src/extensions/zotero/presentation/zotero-tools.ts`                   |
| Manage library collections       | `manage_literature_collections` | `src/literature/presentation/literature-collections-tool.ts`           |
| Download PDFs                    | `download_literature_pdfs`      | `src/literature/presentation/literature-download-memory-tools.ts`      |
| Translate saved PDF              | `translate_personal_pdf`        | `src/extensions/pdf-translation/presentation/pdf-translation-tools.ts` |
| Generate structured PDF material | `generate_mineru_material`      | `src/extensions/mineru/presentation/mineru-tools.ts`                   |
| Read structured PDF material     | `read_mineru_material`          | `src/extensions/mineru/presentation/mineru-tools.ts`                   |
| Discover artifacts               | `discover_paper_artifacts`      | `src/artifacts/presentation/artifact-discovery-tools.ts`               |
| Acquire artifacts                | `acquire_paper_artifacts`       | `src/artifacts/presentation/artifact-discovery-tools.ts`               |
| Inspect artifacts                | `inspect_paper_artifacts`       | `src/artifacts/presentation/artifact-tools.ts`                         |
| Build material package           | `build_paper_package`           | `src/artifacts/presentation/paper-package-tools.ts`                    |
| Export/annotate/delete/promote   | `manage_literature_corpus`      | `src/literature/presentation/literature-corpus-tool.ts`                |
| Derived memory                   | `manage_literature_memory`      | `src/literature/presentation/literature-download-memory-tools.ts`      |
| Search research notes            | `search_research_notes`         | `src/research/presentation/research-tools.ts`                          |
| Manage research notes            | `manage_research_note`          | `src/research/presentation/research-tools.ts`                          |

## Supporting operations

1. Search the selected corpus first. When the redacted team connection status reports an active `pateam1.` access-file connection, use `manage_team_literature_server` search for shared team knowledge; otherwise use `search_literature_corpus` for a local corpus. Use `collect_literature` with corpus reuse enabled only after existing records are checked.
   If existing material is only in a local PDF directory, BibTeX file, or paper-agent JSON export, use `import_literature_corpus` in personal scope, pass the requested collection directly, and inspect `needsMetadata`, provider warnings, possible duplicates, and the rejection report.

   When selected search results are saved, `save_literature_selection` automatically checks exact DOI enrichment before showing the confirmation. Complete records make no provider request; incomplete records stop querying once useful bibliographic, citation, and open-access fields are filled. Do not ask the user whether to run OpenCitations or Unpaywall separately, and do not treat an enrichment warning as a save failure.

2. Before repeating generated analysis, search linked Markdown notes with `search_research_notes` and use `manage_literature_memory` for exact derived-cache hits. Reuse an exact hit unless refresh is explicit.
3. Use `manage_literature_corpus` for local annotate/audit/export/promotion. For the central service, use `manage_team_literature_server` to propose explicitly selected, provenance-reviewed personal records into `team-proposed`, then have a reviewer explicitly approve or reject them. Exclude personal notes and screening decisions from every proposal; the server scrubs them again.
4. After producing reusable generated work, record it with `manage_literature_memory`; keep it separate from user notes and source metadata.

## Research workspace

1. Research note bodies are Markdown files under `.paper-agent/notes/{namespace}/`. SQLite stores only their index, revision, content hash, and paper relationships. Never edit `personal.sqlite` by hand.
2. A note may link zero or more papers, but every linked paper must already exist in the same personal namespace. Put evidence locators such as paper ID, PDF version, physical page, section, figure, table, and quotation in the Markdown body.
3. Use `search_research_notes` before creating overlapping work. Reuse its folder IDs when organizing notes in the existing folder tree. Use `manage_research_note` for every Agent-created or Agent-edited note and include the intended namespace; mutations follow the research confirmation policy.
4. Use `template_id=skim`, `deep-reading`, or `comparison-matrix` when a template is useful. These templates are copied only at creation and may initially be empty, so the Agent must write the actual Markdown content.
5. Deleting a paper removes only its note relationships. It must not delete otherwise valid notes. Delete a note explicitly through `manage_research_note` when the user requests it.

## Handoff

Report:

- question, query variants, filters, providers, pages, and date;
- included records, duplicates merged, rejected or unresolved candidates;
- search run id, selected paper ids, created/updated/unchanged/failed counts, and missing ids when saving selections;
- source failures, missing PDFs/artifacts, hashes, stored PDF paths, manifest paths, and commits when acquired;
- material package rows, including version, PDF, artifact, discovery source, screening status, reading status, and update time;
- mode, scope, namespace, cache status, and corpus/export paths;
- reused corpus hits, exact analysis-cache hits, possible duplicates, screening decisions, and pending team reviews;
- local-import collection, required-metadata failures, non-blocking provider warnings, and imported PDF hashes;
- what requires human reading, experimental verification, or novelty judgment.

Search metadata is discovery evidence only. For technical claims, open the primary paper or official artifact and follow the paper-agent evidence gates.
