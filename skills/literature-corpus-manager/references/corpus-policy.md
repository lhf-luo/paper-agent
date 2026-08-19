# Corpus policy

## Scope and lifetime

| Choice | Meaning | Default use |
| --- | --- | --- |
| personal | Private working namespace; may contain unreviewed records | New collection |
| team | Shared namespace containing proposed and reviewed records | Reuse or explicit proposal/review only |
| once | No corpus write or persistent cache | Exploration |
| persistent | Reusable records, search cache, derived outputs, and exports | Continuing projects |

Search the authenticated team service first when it is configured. Treat team records as reusable discovery memory, not primary-source proof. Store new searches, private notes, and personal screening only in personal scope.

A team path may point to a mounted group directory. Paper-agent serializes local writes with an atomic lock, but a multi-host network share must use the single-writer service because cross-host filesystem-lock guarantees vary. Run one service instance per corpus root and use tested backups.

Tool entrypoints live under `src/tools/`; corpus state must still be read or written only through the approved store and consent helpers under `src/`. Do not edit records, search runs, PDF versions, or artifact manifests by hand.

## Provenance minimum

Each paper record must retain provider, query, retrieval time, provider record id when available, identifiers, and final links. Search runs must retain query variants, filters, provider counts, pagination bounds, deduplication count, discovery paths, candidate-table rows, and failures.

Downloaded PDFs require source/final URL, retrieval time, content type, byte size, SHA-256, and content-addressed blob path. Artifact acquisitions require candidate context, status, local path, final URL, SHA-256 or Git commit, detected license files, and failure reason.

Saved selections require a durable source `search_run_id`, selected paper ids, target personal namespace, contributor, confirmation fingerprint, write outcomes, and missing ids. Material packages require paper id, metadata summary, PDF version summary, PDF blob path or link, artifact manifest/acquisition summary, discovery source, screening status, reading status, and latest update time.

## Reuse and proposal

Persistent identical searches may use the cache. Derived analysis is reusable only when its key includes input hashes, operation, pipeline version, model/prompt version when applicable, and normalized configuration.

Sharing is one-way from personal to team and must be explicit. A proposal records its contributor and enters `team-proposed`; a reviewer must set `team-approved` or `team-rejected`. It does not delete or mutate the personal source. Personal notes and screening decisions are excluded, and the server repeats this privacy scrub. Preserve proposer, reviewer, timestamps, and reason.

Do not use `collect_literature` persistent mode or citation expansion to write directly into team scope. Collect and screen in personal scope, then use the local promotion workflow or the authenticated team-service proposal workflow.

Use reading status only as workflow state. It can say unread, queued, reading, read, or skimmed; it is not proof that every claim in the paper was verified.

## Security

Generic and PDF retrieval may use public HTTP(S), while artifact-file acquisition and Git repositories require public HTTPS. Treat HTTP transport as untrusted, prefer HTTPS, and rely on the recorded hash to detect later byte changes rather than as proof of origin. Reject credentials, local/private/reserved addresses, and unsafe redirects. Bound response sizes and use atomic writes. Clone shallowly without submodules or LFS smudging. Recompute downloaded hashes and re-read Git commit/remote before reusing cached artifacts. Never execute acquired code, install its dependencies, open archives, or trust license status automatically.

Use HTTPS for non-loopback team access, per-user bearer tokens, least-privilege roles, an HTTPS proxy that does not log authorization headers, independent backup retention, and periodic restore tests.
