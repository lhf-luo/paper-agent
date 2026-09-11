# Corpus policy

## Scope and lifetime

| Choice | Meaning | Default use |
| --- | --- | --- |
| personal | Private working namespace; may contain unreviewed records | New collection |
| team | Shared namespace containing proposed and reviewed records | Reuse or explicit proposal/review only |
| once | Persist the search run for later selection, but do not merge candidate papers into the library | Exploration |
| persistent | Reusable records, search cache, derived outputs, and exports | Continuing projects |

Search the authenticated team service first when it is configured. Treat team records as reusable discovery memory, not primary-source proof. Store new searches, private notes, and personal screening only in personal scope.

A team path may point to a mounted group directory. Paper-agent serializes local writes with an atomic lock, but a multi-host network share must use the single-writer service because cross-host filesystem-lock guarantees vary. Run one service instance per corpus root and use tested backups.

Tool entrypoints live in feature `presentation/` directories; corpus state must still be read or written only through the approved application services, repositories, and consent helpers. Do not edit `personal.sqlite`, personal PDF directories, search runs, PDF versions, search indexes, or artifact manifests by hand. Research note bodies are Markdown under `.paper-agent/notes/{namespace}/`; SQLite stores their index, revision, hash, and paper relationships. Old `.paper-agent/research/` JSON files and `audit.jsonl` are obsolete.

## Provenance minimum

Each paper record must retain provider, query, retrieval time, provider record id when available, identifiers, and final links. Search runs must retain query variants, filters, provider counts, pagination bounds, deduplication count, discovery paths, candidate-table rows, and failures.

Downloaded PDFs require source/final URL, retrieval time, content type, byte size, SHA-256, and stored path. Personal PDFs use readable, title-based filenames under the namespace and paper directory; SHA-256 is retained for integrity, exact duplicate detection, and transfer verification. Team storage may continue to use content-addressed blobs. Artifact acquisitions require candidate context, status, local path, final URL, SHA-256 or Git commit, detected license files, and failure reason.

Zotero exchange uses the official loopback Local API, never direct access to `zotero.sqlite`. Preserve complete collection ancestry and multiple memberships in both directions. Transfers are explicit copy/update operations and never propagate deletion. Do not transfer personal notes, screening state, research records, Artifacts, Zotero annotations, or child notes.

Saved selections require a durable source `search_run_id`, selected paper ids, target personal namespace, contributor, confirmation fingerprint, write outcomes, and missing ids. Material packages require paper id, metadata summary, PDF version summary, stored PDF path or link, artifact manifest/acquisition summary, discovery source, screening status, reading status, and latest update time.

## Reuse and proposal

Persistent identical searches may use the cache. Derived analysis is reusable only when its key includes input hashes, operation, pipeline version, model/prompt version when applicable, and normalized configuration.

Sharing is one-way from personal to team and must be explicit. A proposal records its contributor and enters `team-proposed`; a reviewer must set `team-approved` or `team-rejected`. It does not delete or mutate the personal source. Personal notes and screening decisions are excluded, and the server repeats this privacy scrub. Preserve proposer, reviewer, timestamps, and reason.

Do not use `collect_literature` persistent mode or citation expansion to write directly into team scope. Collect and screen in personal scope, then use the local promotion workflow or the authenticated team-service proposal workflow.

Use reading status only as workflow state. It can say unread, queued, reading, read, or skimmed; it is not proof that every claim in the paper was verified.

Research notes may link only papers in the same personal namespace. Deleting a paper removes its links from notes but does not delete the Markdown notes themselves.

## Security

Generic and PDF retrieval may use public HTTP(S), while artifact-file acquisition and Git repositories require public HTTPS. Treat HTTP transport as untrusted, prefer HTTPS, and rely on the recorded hash to detect later byte changes rather than as proof of origin. Reject credentials, local/private/reserved addresses, and unsafe redirects. Bound response sizes and use atomic writes. Artifact acquisition defaults to 200 MB per item and cannot exceed 500 MB, including a Git working tree and `.git` data. Clone shallowly without submodules or LFS smudging. Recompute downloaded hashes and re-read Git commit/remote before reusing cached artifacts. Never execute acquired code, install its dependencies, open archives, or trust license status automatically.

On Windows, never rename Git paths that NTFS cannot represent. Exclude them and conventional committed build/run output with sparse checkout, keep ordinary source paths unchanged, and record safely named excluded directories in the acquisition snapshot.

When PDF, LaTeX, and DOI evidence has no credible paper-owned Artifact, bounded public GitHub repository search must prioritize implementation names and project acronyms supported by explicit author language in the stored abstract or PDF abstract/introduction. Every search must retain that tool-name evidence or state that no name was found. Names guessed only from title punctuation, generic words, conference labels, or standalone domain acronyms are invalid. Without a verified name, search by DOI, then exact title plus author surname, then distinctive method terms plus author surname; never use a generic title token alone. Automatically generated queries remain candidates and must be reviewed. Only high-confidence GitHub fallback matches with ownership or author-release evidence are selected by default; a README citation or exact-title mention alone is insufficient. Model memory is not provenance: after deterministic discovery fails it may suggest an untrusted lead, but that URL must be verified against public README, author/lab organization, DOI, title, or author evidence before entering `additional_candidate_urls`. `additional_candidate_urls` is per-operation evidence, not persistent configuration. An optional `credentials.json` `githubToken` is redacted, sent only to `api.github.com`, never forwarded across redirects, and must not expose private repositories to automatic discovery.

Use the team server's native HTTPS listener for non-loopback access, per-user bearer tokens, least-privilege roles, independent backup retention, and periodic restore tests.

Team access must come from the validated, Git-ignored access file created from a `pateam1.` string. Never read or print `.paper-agent/team-access.json`, Pi credential files, or process environment values merely to check whether credentials exist; use redacted status surfaces instead.
