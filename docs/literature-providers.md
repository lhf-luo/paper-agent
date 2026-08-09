# Literature Providers and Recovery

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Paper Agent uses provider adapters behind one normalized record and provenance model. The default Web selection is arXiv, OpenAlex, and Crossref; additional providers can be enabled for the query.

## Provider catalog

| Provider | Mode | Best use | Credential or identifier note |
| --- | --- | --- | --- |
| arXiv | Search | Public preprints and direct PDFs | No key required |
| OpenAlex | Search | Broad scholarly graph and citation metadata | `OPENALEX_MAILTO` recommended |
| Crossref | Search | DOI registration metadata | `CROSSREF_POLITE_EMAIL` recommended |
| Semantic Scholar | Search | Scholarly search and citation graph | `S2_API_KEY` optional but improves rate limits |
| DBLP | Search | Computer-science bibliography | No key required |
| PubMed | Search | Biomedical literature | No key required for basic use |
| CORE | Search | Open-access aggregator | `CORE_API_KEY` required |
| OpenCitations | DOI enrichment | DOI metadata and citation relationships | Supply a DOI-shaped query |
| Unpaywall | DOI enrichment | Open-access locations for a DOI | `UNPAYWALL_EMAIL` required |

DOI-enrichment providers are not general keyword search engines. Use them after a DOI has been found or enter a DOI query explicitly.

## Collection pipeline

```text
explicit query
  -> controlled query expansion
  -> existing-corpus lookup
  -> provider pages
  -> normalization and identifier extraction
  -> exact and probable-duplicate handling
  -> filters and result limits
  -> provenance manifest
```

Each normalized paper records its provider, exact query, retrieval time, identifiers, and source links. Provider metadata is discovery evidence; technical claims still require a primary PDF or official artifact.

## Pagination, limits, and rate limiting

Provider pages use bounded result counts. HTTP 429 and transient failures are classified as retryable when appropriate, and `Retry-After` is preserved in provider health. Successful providers remain usable when another source fails.

Avoid requesting unnecessarily large result sets. Use a focused query, a year range, and a reasonable per-provider limit, then expand through citations only after screening the first collection.

## Checkpoints and retry

Search jobs write a checkpoint containing completed provider/query pages and the next cursor. If a retryable failure or cancellation occurs, retrying the read-only job resumes from that checkpoint rather than replaying completed pages. The checkpoint is removed after a successful complete run.

The task center permits direct retry only for read-only search, PDF analysis, and artifact discovery. Saving records or downloading PDFs requires a new prepared manifest and confirmation.

## Cache and reproducibility

Responses and search runs retain query, provider, page/cursor, filters, retrieval time, and failure information. Live APIs can change, so a previous result set is not guaranteed to be reproduced byte-for-byte. Persistent records and downloaded PDF hashes are the stable local evidence layer.

## Suggested environment variables

```powershell
$env:OPENALEX_MAILTO = "researcher@example.org"
$env:CROSSREF_POLITE_EMAIL = "researcher@example.org"
$env:S2_API_KEY = "optional-semantic-scholar-key"
$env:CORE_API_KEY = "core-key"
$env:UNPAYWALL_EMAIL = "researcher@example.org"
```

Set only the variables needed by your selected providers. Never commit their values.
