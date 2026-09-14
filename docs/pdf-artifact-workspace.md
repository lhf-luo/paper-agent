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

Web reanalysis and the Agent's `list_paper_assets` tool apply the latest matching correction after automatic region estimation. Both read the configured data root, and the Agent reports the correction's author and ID. Moving or renaming an unchanged PDF preserves its correction; a different PDF hash does not inherit it.

## Artifact discovery

Discovery is read-only. It extracts and normalizes links from PDF text, annotations, and nearby context, then classifies candidates such as:

- GitHub or GitLab repositories;
- Zenodo and Figshare records/files;
- datasets and benchmark pages;
- supplementary material;
- project or implementation pages.

Each candidate retains its source method, physical page when available, nearby evidence, normalized URL, kind, and confidence. A candidate is not proof that the artifact belongs to the paper; review its context before acquisition.

If PDF, LaTeX, and DOI scanning finds no medium- or high-confidence paper-owned artifact, Paper Agent extracts implementation names and project acronyms from the paper, then performs at most three bounded GitHub repository searches and verifies at most five candidate READMEs. Queries prioritize names such as `MLTA`, `TypeDive`, `RTT`, or `SAVIOR`, then DOI, with the full paper title retained only as a fallback. Supplying `paper_id` makes stored title, author, and DOI metadata authoritative over noisy PDF headers while still retaining project names extracted from the PDF.

When deterministic discovery returns no credible candidate, model memory may suggest a repository name, owner, or URL only as an untrusted lead. The lead must be verified against public GitHub README, author/lab organization, DOI, title, or author evidence before its URL is passed through `additional_candidate_urls`. Unverified remembered URLs never become candidates or provenance.

Use `additional_candidate_urls` to add a supported public HTTPS URL found in other public evidence. This value is a per-operation tool/API input, not a configuration field. Unsupported hosts, credential-bearing URLs, HTTP URLs, and private network targets are rejected or reported as warnings.

Ordinary discovery results are operational candidates. They must be checked against the paper, official project materials, and other primary sources before acquisition or reproduction claims.

## Safe acquisition

After candidates are selected, Paper Agent prepares an exact acquisition plan. Execution requires a matching one-time confirmation grant.

By default, acquisition includes high- and medium-confidence PDF/external candidates, but only high-confidence GitHub fallback candidates. Medium- and low-confidence GitHub results must be selected explicitly with `candidate_ids` after their API/README evidence has been reviewed.

The network and Git layer enforces:

- public-address validation before and after redirects;
- HTTPS for artifact files and Git repositories;
- bounded size, timeout, redirect count, concurrency, and candidate count;
- a default per-artifact limit of 200 MB and a hard maximum of 500 MB, including the Git working tree and `.git` data;
- shallow public HTTPS clones;
- Windows-safe sparse checkout: committed build/run output and paths that NTFS cannot represent are excluded rather than renamed, so filenames containing `:` or other Windows-reserved forms are never created locally;
- disabled interactive credentials, hooks, submodules, and LFS smudge;
- no archive extraction and no code execution.

The manifest records successful and failed attempts, including source/final URL, resolved addresses, bytes, content type, SHA-256, Git remote/ref/commit, license files, output paths, and failure reason.

For a saved personal paper, repositories are cloned directly to `.paper-agent/files/personal/<namespace>/<paperId>/artifacts/<project>/`. The manifest is stored at the `artifacts/` root, while non-Git files use its `downloads/` directory. Repository acquisition uses Git; `fetch_url` is only a read-only verification tool.

On Windows, the manifest records safely named excluded directories when an upstream repository contains generated output or filenames that NTFS cannot represent. Paper Agent does not rewrite those upstream names, because doing so would make the local snapshot differ from the recorded commit.

An optional `githubToken` may be stored in `.paper-agent/config/credentials.json` to raise GitHub API limits. Anonymous public search remains available when it is empty. The token is redacted from configuration/status output, sent only to `api.github.com`, never forwarded across redirects, and does not enable private-repository discovery.

## File-tree inspection

The Web result page shows a bounded tree of acquired material. It skips `.git`, `node_modules`, symbolic links, deep traversal, and excessive entry counts. This view is for orientation, not a security guarantee or a substitute for manual code review.

## Known boundaries

The PDF asset tools cover common single/two-column layouts, multi-panel figures, captions, body mentions, continued tables, and a limited number of independent subfigure boxes. Rotated pages, pure scans, non-English papers, publisher-rendered versions, unusual cross-column floats, and continued tables without repeated headers remain explicit hardening targets.

When a crop, mention, or artifact mapping is uncertain, keep the ambiguity visible and inspect the physical PDF manually.
