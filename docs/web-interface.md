# Web Interface

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

`paper-agent` opens a local research workspace in the browser, including the built-in Agent chat page. It is the default product interface; `paper-agent agent` remains the advanced original Pi terminal interface.

## Launch and local session

```powershell
paper-agent
paper-agent D:\papers\example.pdf
paper-agent --no-open
paper-agent --port 4317
```

The server binds only to `127.0.0.1`. Each process creates a random session token, places it in the initial URL fragment, moves it into browser session storage, and removes it from the visible URL. The token protects every `/api/*` route and becomes useless when the local process exits. With `--no-open`, copy the complete session URL printed in the terminal; the bare host URL does not contain the token.

Keep the launch terminal open. Stop the workspace with `Ctrl+C`. If a tab reports a missing session token, reopen the interface through the `paper-agent` command.

## Pages

### Dashboard

Shows personal paper count, running/queued/failed work, shortcuts, and recent jobs. Counts and recent-job state refresh while the page is open, so completed imports and background work become visible without restarting the interface. It is an overview, not an evidence report.

### Search papers

1. Enter a research question or explicit query.
2. Select one or more providers and optional year filters.
3. Inspect provider-level status, partial failures, and deduplicated results.
4. Select records to keep.
5. Review the prepared corpus-write manifest and fingerprint.
6. Confirm before the records enter the personal persistent library.

An external-provider failure does not discard successful results from other providers. Retryable search failures keep a checkpoint so the task center can continue from the saved cursor.

### Agent chat

Open **Agent 对话** to use Paper Agent's research tools from a streaming Web conversation. Configure the Provider ID, Model ID, Base URL, and one of `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`, then submit an API key or use the environment variable named by the project model configuration. A model is needed only for this page and the Pi terminal; the rest of the Web workspace continues to work without one.

A key submitted in the page is stored only in the current service process memory. The password field is cleared after a successful submission, and the value is never written to `.paper-agent/config.json`, Pi `auth.json`/`models.json`, browser storage, conversation history, logs, or error responses. Restarting the service discards the key. Clearing the key or changing the endpoint destroys existing Agent sessions so an old runtime cannot retain obsolete credentials.

Sessions are in-memory and can be created, switched, or deleted. `persistent` keeps model context between turns; `once` resets Pi context after each completed turn. The page streams assistant text, shows tool-call cards, supports stopping generation, and renders `confirm`, `select`, and `input` requests as interactive cards. Downloads, persistent writes, team proposals, and configuration changes are never auto-approved; an unanswered, aborted, timed-out, or disposed confirmation is rejected.

For a step-by-step introduction, common research prompts, and an explanation of the automatically loaded `literature-corpus-manager` Skill, see the [Web Agent user guide](web-agent-guide.md) or its [Chinese version](web-agent-guide.zh-CN.md).

### Personal library

Search titles, authors, abstracts, identifiers, tags, and notes, then filter the result by screening state (`unreviewed`, `include`, `maybe`, or `exclude`). Selecting a paper opens its stored PDF versions, personal notes, screening decision, and derived-memory count.

The curation panel can apply tags, append a private note, and set a screening decision for the selected papers. It can also export the selection—or the whole namespace when nothing is selected—as JSON, Markdown, CSV, or BibTeX. Annotation, export, and batch PDF download are material writes and therefore use the same prepare/confirm/execute flow. Personal notes and screening decisions are never included automatically in a team proposal.

### Task center

Long operations run in a persistent local queue. Running work may be paused or cancelled. Only read-only literature search, PDF analysis, and artifact discovery can be retried directly. Downloads, corpus writes, corrections, team proposals, reviews, token changes, and backups require a fresh review and confirmation.

### PDF & Artifact workspace

Enter an absolute or workspace-relative local PDF path. The page can:

- analyze figures, tables, algorithms, captions, sections, and body mentions;
- display candidate regions over the rendered PDF;
- map rotated PDF.js viewports back to `pdftotext` page coordinates;
- move or resize a crop and save a hash-bound manual correction;
- discover artifact links without downloading them;
- select candidates, review the acquisition manifest, and explicitly acquire them;
- inspect the bounded local file tree and acquisition provenance.

See [PDF and artifact workspace](pdf-artifact-workspace.md).

### Quality evaluation

This page is a researcher-operated labeling workspace for the fixed Artifact discovery evaluation set. It is intentionally separate from ordinary Artifact discovery and acquisition.

The left column selects one of the pinned papers. The center column renders the hash-verified PDF and requires an explicit checkbox for every physical page. The right column requires an independent decision for every detector candidate: either map it to a real paper Artifact, or mark it ignored with a reason. Detector misses can be added manually. Multiple URL aliases may share one gold Artifact ID.

Edits are recovered from browser `localStorage` using the paper slug and PDF SHA-256. This recovery state is only a local draft: it is not a reviewed annotation, is not read by the evaluator, and must not be presented as gold. Saving requires a named real reviewer, all physical pages, every candidate decision, server-side schema checks, and the standard exact-plan confirmation. The server then writes the annotation atomically under `eval-data/artifacts/annotations/`.

The page never auto-accepts detector output and never claims that an AI/model performed human review. Until at least 30 real researchers' paper reviews meet the strict thresholds, `npm run eval:artifacts:check` remains intentionally failing. See [Artifact discovery human evaluation](artifact-evaluation.md).

### Team knowledge base

The page reports the authenticated identity and its capabilities. Limited identities remain connected even if they cannot call reader-only endpoints. Readers can search shared papers by text and publication-year range and continue through cursor-paginated results without loading an unrestricted namespace scan into the browser.

For a local one-person exercise, run `paper-agent --team demo`. It starts the loopback team service, injects an ephemeral demo connection into the Web process without writing the bearer token to project configuration, and opens this page. Stop the retained service with `paper-agent --team stop`.

- `reader`: inspect approved shared content and statistics;
- `contributor`: submit privacy-scrubbed proposals;
- `reviewer`: inspect pending papers/events and approve or reject supported resources;
- `admin`: all capabilities plus identity-token management and backup.

New identity tokens are held only in React memory, shown once, and cleared from the page after **Copy and hide**. Team bearer tokens are read by the local process from environment variables; they are not sent to browser storage.

### Research workspace

Create and revise skim cards, comparison matrices, and evidence graphs. Every reusable claim should carry a paper ID and, when available, page and quote locators. AI-assisted drafts cannot overwrite human records or human conclusions. Only human-reviewed records can be proposed to the team service.

### Settings & diagnostics

Configure the default namespace, data paths, browser behavior, model endpoint metadata, and team connection metadata. This settings page never accepts secret values; it stores only environment-variable names. The separate Agent chat page can accept an ephemeral model key held only in service-process memory. Unsaved changes are marked by the save action, and changing any model identity, URL, API type, or key-variable name clears the previous tool-calling verification so stale evidence cannot be reused.

Automatic capability probing is available for `openai-completions` and `openai-responses` endpoints. It may consume a small amount of provider quota and therefore requires confirmation. `anthropic-messages` and `google-generative-ai` configurations are accepted by Pi, but Paper Agent clearly requires a real tool-using Pi session for their capability check instead of reporting an unimplemented automatic probe as a model failure.

## Confirmation model

Every material write follows three stages:

```text
prepare exact plan
  -> show targets, risk, details, and manifest fingerprint
  -> explicit user confirmation
  -> one-time short-lived grant
  -> execute the matching plan
```

A changed plan or expired/mismatched grant is rejected. Background write jobs cannot be restarted with an old grant.

The gate is implemented in the operation code rather than relying only on agent instructions. It covers search-result and citation-network imports, local PDF/BibTeX/JSON imports, rejection logs, PDF downloads, artifact acquisition, crop corrections, human Artifact-evaluation gold writes, personal tags/notes/screening state, derived-memory writes, corpus exports, team proposals and reviews, identity-token changes, backups, configuration writes, and quota-consuming model probes. Confirmation buttons are locked while execution is in flight, and cancelling a card does not execute the prepared operation.

## Troubleshooting

- **Blank or stale page:** stop the server, rebuild with `paper-agent --setup`, and restart.
- **Missing local session token:** launch from the command again instead of reusing an old bookmark.
- **PDF fails to load:** confirm the file exists and `paper-agent --doctor` finds Poppler.
- **Quality evaluation is empty or reports an invalid source:** fetch and hash-pin the Artifact evaluation PDFs, then regenerate machine candidate snapshots; do not create gold files to silence the warning.
- **A recovered review disappeared after the PDF changed:** browser drafts are keyed by the pinned PDF SHA-256 so an old review cannot silently carry over to another version.
- **Team shows configured but disconnected:** verify the token environment variable exists in the process that launches Paper Agent and that the service URL is reachable.
- **A team section is hidden:** the connection is valid, but the identity lacks the required role.
- **Agent chat asks for a key after restart:** Web-entered model keys are intentionally process-memory-only; enter it again or set the environment variable named by the project model configuration before launching Paper Agent.
- **Agent chat rejects an HTTP Base URL:** use HTTPS except for a local test endpoint on `localhost`, `127.0.0.1`, or `::1`.
- **Model probe is disabled:** save pending model edits first; then confirm that the API-key environment variable is visible to the current process. Anthropic Messages and Google Generative AI configurations require a real tool-using Pi session instead of the automatic probe.
