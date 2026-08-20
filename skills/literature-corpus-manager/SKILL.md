---
name: literature-corpus-manager
description: Build, update, audit, and share evidence-traceable literature corpora with paper-agent. Use for systematic or exploratory literature collection, query expansion, multi-source search, deduplication, PDF and artifact acquisition, personal/team library separation, once/persistent workflows, citation expansion, exports, and avoiding repeated analysis. This skill organizes research memory; it does not replace human deep reading, experiments, interpretation, or idea formation.
---

# Literature corpus manager

Use paper-agent tools as the single implementation of collection, storage, acquisition, and security rules. Do not reimplement downloads or edit corpus manifests by hand.

Tool entrypoints live under `src/tools/`. Core storage, identifiers, providers, consent, network safety, and lower-level acquisition logic remain under `src/` and are reused by the tools.

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
4. Search existing reusable records first. When a team literature server is configured (config.json `team` section, or the legacy `PAPER_AGENT_TEAM_SERVER_URL` environment variable), use `manage_team_literature_server` search for shared team knowledge; otherwise use `search_literature_corpus` for a local corpus.
5. Use `collect_literature` with corpus reuse enabled, documented filters, bounded pagination, and the structured search plan.
6. Keep provider failures, possible duplicates, corpus hits, discovery paths, PDF links, artifact links, and candidate-table rows visible.
7. Use once mode for exploration. Use persistent mode only when the user wants reusable search results and accepts the confirmation prompt.
8. State unsupported sources. Do not claim Google Scholar was searched because this project has no Google Scholar provider.

### 1.1 Output format: one combined table with a `focus` column

When delivering a screened literature list, output **ONE combined markdown table** with a `focus` column — do not split into multiple per-topic sections:

```markdown
| 标题 | 年份/venue | 标识 | focus |
| --- | --- | --- | --- |
| [KernelGPT: Enhanced Kernel Fuzzing via LLMs](https://doi.org/10.1145/3676641.3716022) | ASPLOS 2025 | DOI 10.1145/3676641.3716022 | 内核模糊测试 |
| [SLUBStick: Arbitrary Memory Writes](https://arxiv.org/abs/2310.13151) | USENIX Sec 2024 | arXiv 2310.13151 | 漏洞利用与缓解 |
```

- One table for the whole list; the `focus` column marks each paper's topic group (e.g. 内核模糊测试, 漏洞利用与缓解, eBPF 安全, 二进制分析).
- Title cells use `[text](url)` when a paper URL is known.
- Pass the exact same table to `update_literature_sidebar` — the sidebar is the ONLY place the table is shown.
- Do NOT print the table (or any markdown table) in your chat reply. The chat reply is a short summary only: total paper count, topic (focus) distribution, notable papers, and next-step options (save / download / refine).
- Do not emit multiple `## focus` headings with separate tables; the `focus` column replaces them.

### 2. Expand from seed papers

1. Use `expand_citation_network` only after the seed papers are relevant and already in a personal corpus.
2. Keep direction and depth explicit. Default to bounded depth; do not use citation snowballing as a substitute for a documented query strategy.
3. Preserve the citation expansion table, including seed id, relationship, depth, source provider, and discovery path.

### 3. Save selected results

Use this when the user chooses papers from a candidate table and wants them kept in the personal library.

1. Require a persisted `search_run_id`. Search runs are saved to `search-runs/` even in once mode (once only skips merging records into the corpus), so a once-mode run can still feed `save_literature_selection`; never rely on chat memory as the source of truth.
2. Call `save_literature_selection` with `search_run_id`, selected `paper_ids`, source namespace, target namespace, and contributor.
3. Complete the exact confirmation prompt before writing.
4. Report created, updated, unchanged, failed, and missing ids.

### 4. Acquire PDF and artifact materials

Use this after candidate papers have been screened or explicitly selected.

1. Use `download_literature_pdfs` for selected saved papers when PDF bytes are needed. Do not download every unreviewed candidate by default.
2. For a local paper PDF, run `discover_paper_artifacts` before `acquire_paper_artifacts`.
3. Complete the exact candidate manifest confirmation before downloading or cloning.
4. Never execute, install dependencies from, or auto-extract acquired content.
5. Preserve source URL, final URL, hash, local blob path, commit, license hints, and failure reason when available.

### 5. Build a paper material package

Use this after selected papers have been saved and the user wants traceable materials for one paper.

1. Confirm the target `paper_id` is in the personal corpus.
2. Call `build_paper_package` with `paper_id`, namespace, and any `artifact_manifest_paths` produced by acquisition.
3. Report the material package row: `paper_id | 元数据 | 版本 | PDF | artifact | 发现来源 | 筛选状态 | 阅读状态 | 更新时间`.
4. If PDF or artifact material is missing, say it is missing instead of inferring availability from metadata.

## Tool map

| Task | Tool | Implementation file |
| --- | --- | --- |
| Plan search | `plan_literature_search` | `src/tools/collection-tools.ts` |
| Collect candidates | `collect_literature` | `src/tools/collection-tools.ts` |
| Search local corpus | `search_literature_corpus` | `src/tools/collection-tools.ts` |
| Expand seeds | `expand_citation_network` | `src/tools/collection-tools.ts` |
| Save selected results | `save_literature_selection` | `src/tools/collection-tools.ts` |
| Download PDFs | `download_literature_pdfs` | `src/tools/collection-tools.ts` |
| Discover artifacts | `discover_paper_artifacts` | `src/tools/artifact-tools.ts` |
| Acquire artifacts | `acquire_paper_artifacts` | `src/tools/artifact-tools.ts` |
| Inspect artifacts | `inspect_paper_artifacts` | `src/tools/artifact-tools.ts` |
| Build material package | `build_paper_package` | `src/tools/paper-package-tools.ts` |
| Import/export/annotate/promote | `import_literature_corpus`, `manage_literature_corpus` | `src/tools/literature-import.ts`, `src/tools/collection-tools.ts` |
| Derived memory | `manage_literature_memory` | `src/tools/collection-tools.ts` |

## Supporting operations

1. Search the selected corpus first. When a team literature server is configured (config.json `team` section, or the legacy `PAPER_AGENT_TEAM_SERVER_URL` environment variable), use `manage_team_literature_server` search for shared team knowledge; otherwise use `search_literature_corpus` for a local corpus. Use `collect_literature` with corpus reuse enabled only after existing records are checked.
   If existing material is only in a local PDF directory, BibTeX file, or paper-agent JSON export, use `import_literature_corpus` into personal scope and inspect its rejection log first.
2. Before repeating a skim card, comparison matrix, or evidence map, use `manage_literature_memory` lookup with material hashes and tool/model/prompt/config versions. Reuse an exact hit unless refresh is explicit.
3. Use `manage_literature_corpus` for local annotate/audit/export/promotion. For the central service, use `manage_team_literature_server` to propose explicitly selected, provenance-reviewed personal records into `team-proposed`, then have a reviewer explicitly approve or reject them. Exclude personal notes and screening decisions from every proposal; the server scrubs them again.
4. After producing reusable generated work, record it with `manage_literature_memory`; keep it separate from user notes and source metadata.

## Handoff

Report:

- question, query variants, filters, providers, pages, and date;
- included records, duplicates merged, rejected or unresolved candidates;
- search run id, selected paper ids, created/updated/unchanged/failed counts, and missing ids when saving selections;
- source failures, missing PDFs/artifacts, hashes, blob paths, manifest paths, and commits when acquired;
- material package rows, including version, PDF, artifact, discovery source, screening status, reading status, and update time;
- mode, scope, namespace, cache status, and corpus/export paths;
- reused corpus hits, exact analysis-cache hits, possible duplicates, screening decisions, and pending team reviews;
- what requires human reading, experimental verification, or novelty judgment.

Search metadata is discovery evidence only. For technical claims, open the primary paper or official artifact and follow the paper-agent evidence gates.
