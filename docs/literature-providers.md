# Literature Providers and Recovery

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Paper Agent uses provider adapters behind one normalized record and provenance model. Keyword discovery and DOI enrichment are separate phases with separate provider configuration.

## Provider catalog

| Provider | Capabilities | Best use | Credential or identifier note |
| --- | --- | --- | --- |
| arXiv | Keyword search, preprint discovery | Public preprints and direct PDFs | No key required |
| OpenAlex | Keyword search, DOI enrichment, citations, open access | Broad scholarly graph and citation metadata | `OPENALEX_MAILTO` recommended |
| Crossref | Keyword search, DOI enrichment | DOI registration metadata | `CROSSREF_POLITE_EMAIL` recommended |
| Semantic Scholar | Keyword search, DOI enrichment, citations, open access | Scholarly search and citation graph | `S2_API_KEY` optional but improves rate limits |
| DBLP | Keyword search | Computer-science bibliography | No key required |
| CORE | Keyword search, open access | Open-access aggregator | `CORE_API_KEY` required |
| ACL Anthology | Directed keyword search, open access | One ACL-family venue in one exact year | No key required; exact year and one supported venue are mandatory |
| USENIX | Keyword search, open access | Official systems, security, networking, and software-engineering papers | No key required; paper details are read from official pages |
| OpenCitations | DOI enrichment, citations | DOI metadata and citation relationships | Requires an exact DOI |
| Unpaywall | DOI enrichment, open access | Open-access locations for a DOI | Exact DOI and `UNPAYWALL_EMAIL` required |
| Exa | Keyword search | Neural web and academic discovery | Optional configured credential |

OpenCitations and Unpaywall are not keyword-search engines and therefore do not appear in the Web search-source selector. They run automatically after a selected search result or local PDF has an exact DOI. The default DOI enrichment chain is Crossref, OpenAlex, Semantic Scholar, OpenCitations, and Unpaywall.

ACL Anthology and USENIX are optional and are not added to the default provider list. ACL Anthology accepts only a single exact year and one supported venue: AACL, ACL, ANLP, COLING, CONLL, EACL, EMNLP, IJCNLP, LREC, NAACL, SemEval, or TACL. Invalid ACL requests are rejected before any network call. USENIX first discovers official presentation pages and then reads at most ten deduplicated details per page. If some detail pages fail, successful papers remain in the result and the search run records the provider as partial instead of discarding them.

Configure the phases separately in `.paper-agent/config/search.json`:

```json
{
  "providers": ["arxiv", "openalex", "crossref", "semanticscholar", "dblp", "core", "exa"],
  "doiEnrichmentProviders": ["crossref", "openalex", "semanticscholar", "opencitations", "unpaywall"]
}
```

DOI enrichment preserves the discovered or PDF-extracted title, authors, and record ID. It fills only missing metadata and merges exact identifiers, links, and provenance. Complete records make no provider request. For incomplete records, providers run in configured order and later providers are skipped as soon as the useful bibliographic, citation, and open-access fields are complete. A provider result is accepted only when its normalized DOI exactly matches the requested DOI. Missing credentials, no result, rate limits, and provider failures are recorded as warnings and do not block saving.

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
  -> user selection
  -> exact DOI enrichment
  -> confirmation and personal-library save
```

Each normalized paper records its provider, exact query, retrieval time, identifiers, and source links. Provider metadata is discovery evidence; technical claims still require a primary PDF or official artifact.

## Pagination, limits, and rate limiting

Provider pages use bounded result counts. HTTP 429 and transient failures are classified as retryable when appropriate, and `Retry-After` is preserved in provider health. Successful providers remain usable when another source fails. A provider page may also return records together with detail-level failures; these warnings are retained in the search run and provider health is reported as `partial`.

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

The normal test suite uses replayable fixtures and does not require network access. To include one live ACL Anthology XML request and one live USENIX paper lookup in the existing integration smoke, set `PAPER_AGENT_LIVE_OFFICIAL_PROVIDERS=1` before running `npm run test:live`.
