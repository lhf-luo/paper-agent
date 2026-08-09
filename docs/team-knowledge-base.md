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

Demo data is stored below `%LOCALAPPDATA%\paper-agent\team-demo` on Windows and `${XDG_DATA_HOME:-~/.local/share}/paper-agent/team-demo` on macOS/Linux. It is a convenience environment, not a production deployment. The generated token stays in a permission-restricted local file and is passed to the selected interface only through its process environment.

## Roles

Roles are capabilities rather than a strict ladder; `admin` has all capabilities.

| Role | Main capabilities |
| --- | --- |
| `reader` | Search approved papers, read derived/artifact entries and blobs, inspect statistics |
| `contributor` | Propose papers, derived records, and artifact manifests; upload validated blobs |
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

Readers can use the Web team page to search shared paper metadata by free text and a publication-year range. The browser requests bounded pages and follows the opaque cursor returned by the service; it does not download an unrestricted namespace snapshot. The authenticated HTTP service also supports author, venue, publication-type, and open-access filters for client/tool integrations.

## Team content

The service can store:

- normalized paper records;
- reviewed derived memory such as skim cards, comparison matrices, and evidence graphs;
- artifact discovery/acquisition manifests;
- content-addressed PDF or artifact blobs with SHA-256 validation;
- append-only audit events;
- identity metadata with token hashes, never cleartext tokens.

## Token handling

Clients send a bearer token loaded from an environment variable named in Paper Agent configuration. The secret value is not written to the repository or local JSON configuration.

Admins may create or rotate an identity token. The Web UI shows the returned secret once, holds it only in component memory, and clears it after **Copy and hide**. Rotation invalidates the previous token. Revocation invalidates the current token, and an administrator cannot revoke the identity currently authenticating that request.

## Backup and audit

Admins can create namespace backups when the server has a backup root. Backups include team knowledge, blobs, token-registry metadata, and audit events. Production operators should schedule backups, copy them off-host, and perform restore drills rather than assuming an archive is usable.

Reviewers can inspect append-only events for proposal, review, blob, identity, and backup actions according to server policy.

## Network boundary

Plain HTTP is allowed only for loopback development. Remote deployments require HTTPS/TLS termination. Do not log bearer tokens or `Authorization` headers. Use a single authenticated writer service rather than sharing a writable filesystem among multiple clients.

For Docker Compose, systemd, token hashes, TLS placement, and restore procedures, see the [production deployment guide](../deployment/team-corpus/README.md).
