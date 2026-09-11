# Team Knowledge Base

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

The team service is separate from every researcher's personal corpus. It provides shared reviewed records without turning private notes into an automatic upload stream.

## One-person demo

On Windows, macOS, or Linux, one user can exercise the proposal and review workflow on loopback:

```text
paper-agent --team demo
```

This opens the Web **Team knowledge base** page with an ephemeral administrator connection. To use the Pi `/team` workflow instead:

```text
paper-agent --team demo --agent
```

From another terminal:

```powershell
paper-agent --team status
paper-agent --team stop
```

Demo data is stored below `%LOCALAPPDATA%\paper-agent\team-demo` on Windows and `${XDG_DATA_HOME:-~/.local/share}/paper-agent/team-demo` on macOS/Linux. It is a convenience environment, not a production deployment. The demo creates a permission-restricted temporary `team-access.json` and points the selected interface to it.

## Roles

Roles are capabilities rather than a strict ladder; `admin` has all capabilities.

| Role | Main capabilities |
| --- | --- |
| `reader` | Search approved papers, read derived/artifact entries and blobs, pull approved papers into the personal library, inspect statistics |
| `contributor` | Propose papers, derived records, and artifact manifests; upload validated blobs; list and withdraw their own pending proposals |
| `reviewer` | Inspect pending paper proposals and audit events; approve or reject supported entries |
| `admin` | All capabilities, identity-token rotation/revocation, and namespace backup |

An identity may combine roles. For example, a practical reviewer usually has both `reader` and `reviewer`. The Web UI keeps contributor-only or reviewer-only identities connected and hides sections that require an absent capability.

## Proposal and review flow

```text
personal record
  -> remove private notes and screening opinions
  -> show exact proposal preview and fingerprint
  -> explicit local confirmation
  -> team-proposed
  -> reviewer approves or rejects
```

The same review state applies to team derived memory and artifact manifests. Search metadata and proposed records remain discovery evidence; opening the primary PDF or official artifact is still required for technical claims.

**Only approved papers are visible to readers.** `GET /search` returns `team-approved` records unless the caller is a `reviewer`/`admin` and explicitly asks for `status=team-proposed` or `status=team-rejected`; `GET /papers/{paperId}` and `GET /papers/{paperId}/versions` return 404 for anything else, so pending and rejected records never leak their existence.

**Changing a paper never interrupts readers.** Re-proposing identical content keeps the existing decision. The content a decision vouches for is the normalized title and abstract, the year, the identifiers, and the `pdf`/`artifact` download links. When any of those change on an approved record, the approved copy stays exactly as reviewed and visible, and the merged content is parked as a pending revision that appears in the reviewer queue flagged as a revision. Approving it replaces the record; rejecting it discards the revision and leaves the approved copy untouched, which is also the rollback for an unwanted merge. Author lists, venues, citation counts, provenance, and landing links merge freely without a revision, so a second member re-proposing the same paper from a different search does not create review noise.

**An id always means the same paper.** A proposal that reuses an existing team id for a record whose identifiers point at a different paper is rejected with HTTP 409 before anything is written, so nobody can merge foreign titles or download links into an approved record by copying its id.

Contributors can list their own pending proposals (`mine=true` / the Web "My pending proposals" panel) and withdraw one that has never been reviewed. Withdrawing a new proposal deletes the record from the team corpus; withdrawing a pending revision only discards the revision. Both write a `paper.withdraw` audit event. Ownership is matched by stable member id, so renaming a member does not strand their proposals.

Readers can use the Web team page to search shared paper metadata by free text and a publication-year range. The browser requests bounded pages and follows the opaque cursor returned by the service; it does not download an unrestricted namespace snapshot. The authenticated HTTP service also supports author, venue, publication-type, and open-access filters for client/tool integrations.

## Pulling from the team

Approved team papers can be brought back into the personal library, optionally with their PDFs:

- Web: tick records in **Shared search** or **Shared papers** and use **Pull to personal library**, optionally with **include PDF**.
- Pi tool: `manage_team_literature_server` action `pull` with `paper_ids`, optional `personal_namespace`, `personal_corpus_root` and `include_pdf`.
- HTTP: `POST /api/team/pull/prepare` then `/api/team/pull/execute`.

Pulling is a confirmed `personal-corpus-write`. The manifest lists every paper id/title and whether a downloadable PDF version exists. Personal notes and screening are cleared on the way down; `tags`, `reading`, and the `teamReview` provenance marker are kept so the copy is recognisable as team-sourced. PDFs are verified against the version `sha256` before being stored, and one failed PDF does not block the other papers — failures are reported per paper.

## Team content

The service can store:

- normalized paper records;
- reviewed derived memory such as skim cards, comparison matrices, and evidence graphs;
- artifact discovery/acquisition manifests;
- content-addressed PDF or artifact blobs with SHA-256 validation;
- append-only audit events;
- identity metadata with token hashes, never cleartext tokens.

## Token handling

Clients send a bearer token from the Git-ignored local team access file. That file is created only after a pasted `pateam1.` string passes CA, health, identity, and namespace validation. The secret is never written to tracked project configuration.

Admins may create or rotate an identity token. The Web UI shows the returned secret once, holds it only in component memory, and clears it after **Copy and hide**. Rotation invalidates the previous token. Revocation invalidates the current token, and an administrator cannot revoke the identity currently authenticating that request.

## Backup and audit

Admins can create namespace backups when the server has a backup root. Backups include team knowledge, blobs, token-registry metadata, and audit events. Production operators should schedule backups (see the `paper-agent-team-backup.timer` unit), copy them off-host, prune old bundles with `npm --prefix team-server run prune-backups`, and perform real restores with `npm --prefix team-server run restore` instead of assuming an archive is usable.

Reviewers can inspect append-only events for proposal, review, blob, identity, and backup actions according to server policy.

## Network boundary

Plain HTTP is allowed only for loopback development. Remote deployments use the team server's native HTTPS listener on port `14713`, with an IP SAN certificate and a private CA carried in the encoded access string. Do not log bearer tokens or `Authorization` headers. Use a single authenticated writer service rather than sharing a writable filesystem among multiple clients.

For Docker Compose, systemd, token hashes, TLS placement, and restore procedures, see the [standalone server guide](../team-server/README.md).
