# PDF and Artifact Workspace

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

The PDF workspace connects page layout, visual assets, body references, and public research artifacts without treating any parser as infallible.

## PDF analysis

The analysis pipeline:

1. validates the local PDF path and physical page count;
2. runs `pdftotext -tsv` at 72 DPI to obtain page, block, line, word, and coordinate information;
3. detects figure, table, algorithm, and listing captions;
4. estimates the visual region around each caption using column and structural layout;
5. refines crop boundaries against rasterized pages from `pdftoppm`;
6. optionally uses OCR when text extraction is incomplete;
7. links each asset to section-aware body mentions and surrounding context;
8. identifies continued table regions on later physical pages;
9. infers labeled subfigure regions when evidence supports a panel layout.

Coordinates use PDF points with a top-left origin. Regions include the visual object and its caption. The Web viewer compares analysis page dimensions with the PDF.js viewport so 90/270-degree pages can be mapped without rotating an already-rotated `pdftotext` result twice.

## Manual crop correction

Select a detected asset, drag its box, or resize it from the lower-right handle. The correction is not written immediately:

```text
edited region
  -> validate against the physical analysis-page bounds
  -> prepare correction manifest
  -> explicit confirmation
  -> store correction by PDF SHA-256 and asset ID
```

Reanalysis applies the latest matching correction. A different PDF hash does not silently inherit an old correction.

## Artifact discovery

Discovery is read-only. It extracts and normalizes links from PDF text, annotations, and nearby context, then classifies candidates such as:

- GitHub or GitLab repositories;
- Zenodo and Figshare records/files;
- datasets and benchmark pages;
- supplementary material;
- project or implementation pages.

Each candidate retains its source method, physical page when available, nearby evidence, normalized URL, kind, and confidence. A candidate is not proof that the artifact belongs to the paper; review its context before acquisition.

Ordinary discovery results are operational candidates, not evaluation gold. The fixed detector benchmark uses a separate researcher-operated review queue so that detector output cannot score itself. See [Artifact discovery human evaluation](artifact-evaluation.md).

## Safe acquisition

After candidates are selected, Paper Agent prepares an exact acquisition plan. Execution requires a matching one-time confirmation grant.

By default, acquisition includes only `high` and `medium`-confidence top-level candidates. `low`-confidence candidates are excluded from the plan and must be selected explicitly with `candidate_ids` after their page/context evidence has been reviewed.

The network and Git layer enforces:

- public-address validation before and after redirects;
- HTTPS for artifact files and Git repositories;
- bounded size, timeout, redirect count, concurrency, and candidate count;
- shallow public HTTPS clones;
- disabled interactive credentials, hooks, submodules, and LFS smudge;
- no archive extraction and no code execution.

The manifest records successful and failed attempts, including source/final URL, resolved addresses, bytes, content type, SHA-256, Git remote/ref/commit, license files, output paths, and failure reason.

## File-tree inspection

The Web result page shows a bounded tree of acquired material. It skips `.git`, `node_modules`, symbolic links, deep traversal, and excessive entry counts. This view is for orientation, not a security guarantee or a substitute for manual code review.

## Known boundaries

The fixed evaluation set measures common arXiv single/two-column layouts, multi-panel figures, captions, body mentions, continued tables, and a limited number of independent subfigure boxes. Rotated pages, pure scans, non-English papers, publisher-rendered versions, unusual cross-column floats, and continued tables without repeated headers remain explicit hardening targets.

When a crop, mention, or artifact mapping is uncertain, keep the ambiguity visible and inspect the physical PDF manually.
