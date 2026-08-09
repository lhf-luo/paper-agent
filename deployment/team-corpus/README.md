# Team corpus deployment

The service is the single writer for a shared, file-backed team corpus. Clients keep private notes in personal stores and send only proposals. The server removes personal notes and screening decisions again before writing `team-proposed` records.

## Credentials and roles

Generate a random bearer token and its SHA-256:

```bash
npm run team-token-hash
```

Give the `token` to one user through a separate secret channel and put only `tokenSha256` in a copy of `auth.example.json`. Do not commit either the real auth file or tokens. Roles are `reader`, `contributor`, `reviewer`, and `admin`; admin implies all roles. Use separate identities and tokens so audit fields identify the actor. After startup, an administrator can create or rotate an identity through the Web team page or the `manage_team_literature_server` tool; the new secret is returned once, persisted atomically as a hash, and recorded in the token audit log. Revocation invalidates the identity without exposing its token. If an operator changes the seed file out of band, restart the service so it reloads the file.

## Run locally

```bash
export PAPER_AGENT_TEAM_AUTH_FILE=/etc/paper-agent/auth.json
export PAPER_AGENT_TEAM_ROOT=/var/lib/paper-agent
export PAPER_AGENT_TEAM_BACKUP_ROOT=/var/backups/paper-agent
export PAPER_AGENT_TEAM_HOST=127.0.0.1
npm run team-server
```

Configure each client with `PAPER_AGENT_TEAM_SERVER_URL` and `PAPER_AGENT_TEAM_TOKEN`. Plain HTTP is supported only for loopback development and must be treated as untrusted transport. For a real team deployment, keep the service bound to loopback and expose it through an HTTPS reverse proxy, or place it on a private host with TLS termination. Set request-size and rate limits at the proxy, restrict `/health` exposure as appropriate, and never log the `Authorization` header.

## Docker Compose

Run the following commands from the repository root, the directory containing `package.json`. The first command makes that assumption explicit. Copy the example credentials, replace every placeholder hash in `auth.json`, and then validate and start the Compose project:

```bash
test -f package.json && test -f deployment/team-corpus/compose.yaml
cp deployment/team-corpus/auth.example.json deployment/team-corpus/auth.json
# Edit deployment/team-corpus/auth.json before continuing.
docker compose -f deployment/team-corpus/compose.yaml config --quiet
docker compose -f deployment/team-corpus/compose.yaml up -d --build
docker compose -f deployment/team-corpus/compose.yaml ps
curl --fail http://127.0.0.1:4317/health
docker compose -f deployment/team-corpus/compose.yaml exec team-corpus sh -c 'test "$(id -u)" -ne 0 && test -w /data && test -w /backups'
```

The data and backup paths are named volumes so the image's non-root `node` user can write them without depending on host bind-mount ownership. The example publishes only to host loopback. Put Caddy, nginx, or an authenticated private network in front of it for remote clients. The included systemd unit is an alternative for a host installation; adjust paths, install Node.js `>=22.19.0`, and create a locked-down `paper-agent` user first. Its startup preflight rejects older Node.js versions.

## Backup and restore

An admin can call the client's `backup` action or use the Web team page. The service writes a manifest-checked bundle containing the namespace, PDF/artifact blobs, token-registry metadata, and audit events while holding its write lock, excludes lock files and symbolic links, and atomically renames the completed snapshot below `PAPER_AGENT_TEAM_BACKUP_ROOT`. Use the `restore-drill` action against a temporary destination to verify the bundle before treating it as a recoverable backup.

Test restoration rather than assuming a backup is usable:

1. Run `restore-drill` against a temporary destination while the production service remains untouched.
2. Verify the SHA-256 file inventory, manifest counts, token-registry metadata, and audit events.
3. For an actual recovery, stop the service so no writer remains and retain the current namespace as a rollback copy.
4. Restore the selected bundle to `PAPER_AGENT_TEAM_ROOT/<namespace>` on the same filesystem and ensure the service user owns it.
5. Start the service, call search and audit, and compare manifest counts.
6. Retain the previous directory until the restored corpus passes inspection.

Run one service instance per corpus root. The file lock protects local concurrent operations but is not a distributed consensus mechanism; do not run multiple replicas against the same network share. Back up to storage with independent retention and access controls. `docker compose down -v` deletes both named volumes, so never use it as routine shutdown and never treat the Compose backup volume as independent retention.
