# Paper Agent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/A6y55/paper-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/A6y55/paper-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-active%20development-orange)](#project-status)

An evidence-first workspace for literature discovery, primary PDFs, public research artifacts, personal libraries, and reviewed team knowledge.

Paper Agent follows the practical research path **search → obtain PDF and artifacts → skim → inspect → experiment → form ideas**. It automates collection, organization, provenance, and reusable memory; deep understanding, experimental judgment, and research ideas remain human responsibilities.

## What you get

- A local Web workspace opened by the single `paper-agent` command, including a built-in streaming Agent chat page.
- Multi-source paper search with query expansion, filtering, pagination, caching, deduplication, provider health, checkpoints, and resumable failures.
- A personal persistent library separated from disposable one-off collection work.
- PDF figure/table/algorithm detection linked to captions, sections, body mentions, context, continued tables, and editable crop regions.
- Automatic discovery of GitHub, GitLab, Zenodo, Figshare, dataset, and supplementary-material links in PDFs.
- Bounded artifact download or shallow Git clone with source URL, final URL, SHA-256, commit, license files, and failure provenance.
- A human-led research workspace for skim cards, comparison matrices, and evidence graphs.
- A role-based team knowledge service with proposals, review, derived memory, artifact manifests, blobs, audit events, token rotation, and backup.
- An advanced original Pi terminal interface for conversational `/paper`, `/collect`, `/library`, and `/team` workflows.

## Quick start

### Requirements

- Git;
- Node.js `>=22.19.0`;
- Poppler `>=22.05` with `pdftotext`, `pdftoppm`, `pdfinfo`, and `pdfimages`;
- Tesseract is optional for OCR-assisted PDFs;
- a model provider is required only for Web Agent chat or the Pi terminal; the other local Web pages and libraries do not require one.

### Windows

```powershell
git clone https://github.com/A6y55/paper-agent.git
Set-Location paper-agent
.\paper-agent.ps1 install
```

If PowerShell blocks local scripts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\paper-agent.ps1 install
```

Open a new terminal after installation, then run:

```powershell
paper-agent init       # optional first-use wizard
paper-agent --doctor
paper-agent
```

`paper-agent` opens the local Web workspace. The installer creates a user-level command that points to this checkout; rerun `install` if the repository is moved.

### macOS / Linux

```bash
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt install poppler-utils
```

```bash
git clone https://github.com/A6y55/paper-agent.git
cd paper-agent
npm ci --ignore-scripts
npm run web:build
./run.sh install
```

If `~/.local/bin` is not already on `PATH`, follow the one-line instruction printed by the installer. Open a new terminal, then use the same command shape as Windows:

```bash
paper-agent init       # optional first-use wizard
paper-agent --doctor
paper-agent
```

The source launcher remains available as `./run.sh`; rerun `./run.sh install` if the checkout is moved.

## Start modes

| Command | Result |
| --- | --- |
| `paper-agent` | Open the local Web workspace |
| `paper-agent paper.pdf` | Open a local PDF in the visual reader |
| `paper-agent --no-open` | Keep the local service running and print a session URL instead of opening it |
| `paper-agent --port 4317` | Use a fixed loopback port |
| `paper-agent init` | Run the first-use configuration wizard |
| `paper-agent --doctor` | Check runtime, Web assets, models, Poppler, and OCR |
| `paper-agent --doctor --probe-model` | Probe OpenAI-compatible tool calls or report that Pi-session verification is required |
| `paper-agent agent` | Start the advanced original Pi terminal interface |
| `paper-agent --agent paper.pdf` | Open a PDF in Pi quick mode |
| `paper-agent --agent --mode full paper.pdf` | Run a deeper Pi paper workflow |
| `paper-agent --team demo` | Open the loopback single-user team demo in the Web workspace |
| `paper-agent --team demo --agent` | Open the same team demo in Pi instead of Web |

See the [complete CLI guide](docs/cli.md) for setup, status, verification profiles, legacy syntax, and uninstall behavior.

## Web workspace

The default interface groups the project around user tasks:

1. **Dashboard** — personal-library and background-job status.
2. **Search papers** — select providers, apply year filters, inspect partial failures, and save chosen results after an exact-plan confirmation.
3. **Agent chat** — configure a model endpoint, create `once` or `persistent` in-memory sessions, stream answers, stop generation, inspect tool calls, and answer confirmation cards.
4. **Personal library** — search and filter reusable records, add private tags/notes/screening decisions, inspect versions, export a selection or namespace, and download selected PDFs.
5. **Task center** — follow long-running work, pause/cancel jobs, and retry read-only failures from checkpoints.
6. **PDF & Artifact workspace** — analyze a local PDF, inspect linked evidence, correct crop boxes, discover artifact candidates, and explicitly approve acquisition.
7. **Team knowledge base** — search paginated shared records, propose private records after privacy scrubbing, review shared content according to role, inspect audit events, and administer tokens or backups.
8. **Research workspace** — create source-linked skim cards, comparison matrices, and evidence graphs while keeping human conclusions separate from AI-assisted drafts.
9. **Settings & diagnostics** — configure paths, providers, model endpoint names, and team-service environment-variable names without storing secrets or reusing stale model-verification results.

The Agent chat page accepts a Provider ID, Model ID, Base URL, API type, and API key. A key entered in the page is held only in the current Paper Agent service process, cleared from the form after a successful submission, and lost when the service restarts. It is not written to project configuration, Pi configuration, browser storage, transcripts, or errors. As an alternative, the service can use the API-key environment variable named by the project model configuration. Downloads, persistent writes, team proposals, and configuration changes still require explicit confirmation in the Web page.

All local API routes are protected by an ephemeral session token and listen only on loopback. Material operations use a code-enforced `prepare → fingerprint → confirm → one-time grant → execute` gate. This includes corpus imports and exports, citation-network saves, PDF downloads, artifact acquisition, personal curation and derived memory, crop corrections, team proposals and reviews, token administration, backups, and model probes. Cancelling or changing the prepared plan invalidates the old path; write jobs cannot be replayed with an old grant.

Start with the [Web Agent user guide](docs/web-agent-guide.md), then see the complete [Web interface reference](docs/web-interface.md).

## Research workflow

```text
research question
  -> search existing personal/team knowledge
  -> query literature providers and deduplicate
  -> obtain primary PDFs and selected public artifacts
  -> skim and screen
  -> inspect methods, figures, evidence, and implementation details
  -> record reusable evidence with provenance
  -> human experiments, judgment, novelty assessment, and ideas
```

The bundled `literature-corpus-manager` Skill makes two independent choices explicit:

| Dimension | Options | Default |
| --- | --- | --- |
| Scope | `personal` or `team` | `personal` |
| Lifetime | `once` or `persistent` | `once` |

This prevents a disposable search from silently becoming permanent knowledge and prevents private notes from entering a team store without review.

## Agent chat, Pi terminal, and model configuration

Open **Agent chat** in the normal Web workspace for the primary conversational interface. Configure the provider, model, Base URL, API type, and an ephemeral key there, or expose the API-key environment variable named in the project model settings to the process that starts Paper Agent. Web-entered keys remain only in service-process memory and must be entered again after a restart.

For the advanced original Pi terminal interface, run:

```powershell
paper-agent agent
```

Inside Pi, use `/login` and `/model` for a built-in provider. For a custom relay, keep the API key in an environment variable and define the provider in:

- Windows: `%USERPROFILE%\.pi\agent\models.json`
- macOS/Linux: `~/.pi/agent/models.json`

The relay must support streaming, tool/function calling, JSON Schema arguments, and sufficient context. A model appearing in `/model` proves only that configuration was parsed. Paper Agent can automatically probe `openai-completions` and `openai-responses`; `anthropic-messages` and `google-generative-ai` must be verified with a real tool-using Pi task.

See [model and relay configuration](docs/model-configuration.md).

## Data, provenance, and safety

Local runtime data is stored under `.paper-agent/` unless configured otherwise. Personal corpora, team data, and disposable runs remain separate.

Paper Agent records normalized identifiers, provider queries, pagination, retries, source URLs, PDF hashes, artifact redirects, checksums, Git commits, license files, failures, review state, and append-only audit events where applicable.

Safety boundaries include:

- local Web service restricted to loopback;
- no API keys or team bearer tokens written to the project configuration; Web-entered model keys stay only in service-process memory, while project configuration may name an environment variable but never stores its value;
- public-network address and redirect validation;
- bounded download size, time, concurrency, and redirect count;
- public HTTPS-only artifact files and Git clones;
- shallow Git clones with hooks, submodules, interactive credentials, and LFS smudge disabled;
- no automatic archive extraction, dependency installation, or execution of acquired code;
- no paywall, authentication, or access-control bypass;
- write operations cannot be retried without a fresh review and confirmation;
- confirmation is enforced by the operation code and a matching manifest fingerprint, not only by agent instructions.

## Documentation

- [Documentation index](docs/README.md)
- [Web Agent user guide](docs/web-agent-guide.md)
- [Web interface](docs/web-interface.md)
- [CLI installation and commands](docs/cli.md)
- [Model and relay configuration](docs/model-configuration.md)
- [Literature providers and recovery](docs/literature-providers.md)
- [PDF and artifact workspace](docs/pdf-artifact-workspace.md)
- [Personal libraries](docs/libraries.md)
- [Research workspace](docs/research-workspace.md)
- [Team knowledge base](docs/team-knowledge-base.md)
- [Research workflow](docs/research-workflow.md)
- [Production team deployment](deployment/team-corpus/README.md)

## Project status

Paper Agent is under active development at source version `0.1.0` and currently runs from a source checkout. The package remains private and is not published to npm.

Known product-hardening targets include rotated or scanned PDFs, non-English and publisher-specific layouts, unusually complex floating objects, live provider variability, and broader cross-platform packaging.

## FAQ

### Why does `node` report an unknown `.ts` extension?

The command used an older system Node.js. Use Node `>=22.19`, or use the installed `paper-agent` launcher, which selects a supported runtime when available.

### Why does Agent chat or Pi report that no model is available?

The non-Agent Web pages can still manage local data, but Agent chat and Pi need usable model credentials. In Agent chat, submit the endpoint and an ephemeral key or set the project-configured environment variable. In the Pi terminal, run `paper-agent agent`, then `/login`, or configure a custom provider whose key is referenced through an environment variable.

### Does Paper Agent download or clone immediately after finding a link?

No. Discovery is read-only. Acquisition shows the exact candidates, targets, and manifest fingerprint, then requires explicit confirmation.

### Does Paper Agent execute downloaded repositories?

No. It records and organizes acquired materials but does not execute code, install dependencies, or automatically extract archives.

### Can one person test team features?

Yes. Run `paper-agent --team demo` for the Web workflow, or `paper-agent --team demo --agent` for Pi, and stop the service with `paper-agent --team stop`. The demo is loopback-only and not a production deployment.
