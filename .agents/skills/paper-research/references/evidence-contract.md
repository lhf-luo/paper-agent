# Paper Research Evidence Contract

## Evidence Classes

- **`[论文]`**: cite the physical PDF page and, when available, section plus figure, table, algorithm, or equation.
- **`[代码]`**: cite source URL, exact commit, and `path:line`. State when the worktree is dirty or a value is only a default or example.
- **`[公开资料]`**: cite the final accessible URL for an author page, official documentation, dataset, or release.
- **`[推断]`**: name the supporting evidence and the reasoning step not directly stated by a source.
- **`[未知]`**: identify missing, unreadable, conflicting, or unreported evidence. Do not fill it from convention or model memory.

Provider metadata, citation counts, snippets, MinerU output, OCR, and generated summaries are discovery or navigation aids, not technical-claim evidence.

## PDF Identity And Coverage

Record the PDF path or source, SHA-256 when available, title and authors, version or date, total physical pages, inspected ranges, and missing or unreadable ranges. A truncated read does not count as coverage.

MinerU may identify relevant sections and page ranges. Key claims, numbers, equations, figures, tables, quotations, and limitations must be verified against the original PDF. A paper-wide conclusion requires `read_pdf` coverage of every physical page in small ranges, including appendices and references, followed by `paper_progress` to reveal gaps.

## Major-Claim Visual Evidence

For each figure, table, algorithm, or listing that supports a major claim:

1. locate it with `list_paper_assets`;
2. inspect the rendered region or reconstruct the table with the appropriate PDF tool;
3. confirm object boundary, caption, physical page, section, and body mention context;
4. check subfigure labels, axes, units, legends, row and column headers, direction arrows, emphasis, error bars, footnotes, and caption conditions;
5. retain ambiguous crop, caption, mention, section, subfigure, and continuation mappings as unresolved rather than forcing a match.

When extracted text conflicts with the visible page, use the visible page and disclose the parsing ambiguity. Human crop corrections are authoritative.

## Challenge-Evidence Ledger

For each major claim, record:

- the failure condition in prior systems;
- the paper's mechanism and the assumption it depends on;
- the experiment question, data, comparison, budget, metric, and hardware when reported;
- the observed result with a primary locator;
- the claim it supports;
- alternative explanations the experiment does not exclude.

Keep paper algorithms, code abstractions, default configuration, example commands, and reported experimental settings distinct. Check whether data represents the target scenario, baselines receive comparable budgets, metrics measure the stated goal, and ablations or counterexamples isolate the proposed mechanism.

## Artifact And Reproduction Evidence

Discovery establishes only that a candidate link exists in paper context. Acquisition establishes retrievable bytes or a Git commit plus provenance. Neither establishes correctness, safety, license permission, or successful reproduction.

Audit redirects, hashes, Git remote and commit, license hints, entry points, configs, datasets, checkpoints, scripts, and paper-to-code mappings. Compare Artifact requirements and behavior with the paper's claims. Revalidate cached hashes and Git state before reuse. Do not execute, install, build, initialize submodules, or auto-extract acquired material.

For reproduction preparation, separate settings reported by the paper, effective values traced from code, examples or defaults that may not match the paper, proposed choices requiring user approval, and `[未知]` values that block or weaken reproduction.

## Human Authority

Human notes, crop corrections, screening decisions, experiment choices, and conclusions take precedence over AI drafts. The Agent may expose fragile assumptions and falsifiable questions, but final relevance, novelty, risk, execution, and research conclusions belong to the user.
