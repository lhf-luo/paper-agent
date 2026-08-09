# Web Agent User Guide

[Documentation index](README.md) | [简体中文](web-agent-guide.zh-CN.md)

Paper Agent's **Agent chat** page is the primary conversational interface for literature research in the browser. It combines the dedicated `literature-corpus-manager` Skill with Paper Agent's paper search, PDF, Artifact, personal-library, team-library, and research-workspace tools.

The Skill is loaded automatically. You do not need a slash command or need to name the Skill in every request.

## 1. Open Agent chat

Start the installed application:

```powershell
paper-agent
```

Keep the launch terminal open, then select **Agent chat** in the navigation. If the browser does not open automatically, run:

```powershell
paper-agent --no-open
```

Copy the complete session URL printed in the terminal, including its `#token=...` fragment. The bare loopback URL does not contain the local session credential.

The other Web pages work without a model. A model is required only for Agent chat or the advanced Pi terminal.

## 2. Configure the model

The **Model and credentials** panel accepts:

| Field | What to enter |
| --- | --- |
| Provider ID | A stable local name for the provider or relay, such as `research-relay` |
| Model ID | The exact model identifier accepted by that endpoint |
| Base URL | The provider or relay API root |
| API type | The protocol implemented by the endpoint |
| API key | An optional key held only for the current service process |

Choose the API type that the endpoint actually implements:

| Endpoint protocol | API type |
| --- | --- |
| OpenAI-compatible Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Google Generative AI | `google-generative-ai` |

The Base URL must use HTTPS. Plain HTTP is accepted only for a loopback service on `localhost`, `127.0.0.1`, or `::1`.

Select **Apply configuration (`应用配置`)**. When configuration and credentials are usable, the page reports **Ready to chat (`可开始对话`)**. Leaving the key field empty keeps the current credential instead of replacing it.

The endpoint must support streaming, tool/function calling, JSON Schema arguments, and enough context for the requested research task. A successful model connection does not by itself prove that tool calling works.

## 3. Understand credential lifetime

A key entered on the Agent chat page:

- stays only in the current Paper Agent service process memory;
- is cleared from the password field after a successful submission;
- is not written to project configuration, Pi files, browser storage, transcripts, logs, or returned errors;
- is lost when Paper Agent restarts.

For a reusable launch configuration, set an API-key environment-variable name in **Settings & diagnostics**, set that variable before launching Paper Agent, and then start the service from the same terminal. The project stores only the variable name, never its value. Replace the example name with the one saved in project settings:

```powershell
$env:PAPER_AGENT_RELAY_API_KEY = "your-private-key"
paper-agent
```

```bash
export PAPER_AGENT_RELAY_API_KEY="your-private-key"
paper-agent
```

Clearing the memory key or changing the Provider ID, Model ID, Base URL, or API type destroys existing Agent sessions. This prevents an old runtime from retaining obsolete credentials.

## 4. Create the first session

1. Choose `once` or `persistent` in the session panel.
2. Select **New session (`新建会话`)**.
3. Choose a common-task template or write a request directly.
4. Replace template placeholders with the research topic, paper IDs, or an absolute local PDF path.
5. Select **Send (`发送`)**, or press `Ctrl+Enter` / `Cmd+Enter`.
6. Follow the streamed answer, tool cards, and any confirmation cards.

A safe first request is:

```text
Find high-relevance papers about memory-safe systems programming. First search the existing personal library, then run a one-off multi-source search. Show the queries, inclusion criteria, provenance, duplicates, and provider failures. Do not persist records or download files.
```

## 5. Choose conversation mode, task lifetime, and knowledge scope

Paper Agent has three related but distinct controls:

| Layer | Choices | Meaning |
| --- | --- | --- |
| Web conversation context | `once` / `persistent` | `once` disposes Pi model context after each turn; `persistent` keeps it for follow-up questions |
| Research-task lifetime | `once` / `persistent` | `once` keeps collection disposable; `persistent` prepares reusable personal-library writes, which still require confirmation |
| Knowledge scope | `personal` / `team` | `personal` is private and unreviewed; `team` is approved shared knowledge or an explicit proposal workflow |

The selector beside **New session (`新建会话`)** controls only Web conversation context and currently opens on `persistent`. It does not authorize any corpus write. The `literature-corpus-manager` Skill defaults an unstated research-task lifetime and scope to `once + personal`.

State task lifetime and scope when they matter. A persistent conversation can still perform disposable research:

```text
Keep this conversation available for follow-up questions, but run the literature collection as once + personal. Search existing knowledge first, and do not persist records or propose anything to the team library.
```

For reusable collection, ask explicitly and expect a confirmation card before anything is written:

```text
Use persistent + personal for this literature collection. Show the exact records and write plan before saving anything, and wait for my confirmation.
```

## 6. How the literature-research Skill works

For research requests, the automatically loaded `literature-corpus-manager` Skill guides the Agent to:

1. identify the research question and expected deliverable;
2. choose or confirm `once`/`persistent` and `personal`/`team`;
3. search existing personal or team knowledge before repeating collection;
4. expand queries with acronyms, synonyms, title/author variants, and adjacent terms;
5. use bounded multi-provider search and preserve partial provider failures;
6. review provenance, deduplication, and possible duplicates;
7. require explicit confirmation before persistence, downloads, Artifact acquisition, or team proposals;
8. report evidence boundaries and work that still needs human reading or experimental verification.

Search metadata is discovery evidence, not proof of a technical claim. Ask the Agent to open the primary PDF or official Artifact and cite physical pages, quotations, figures, tables, URLs, hashes, or commits when making substantive claims.

## 7. Common workflows

### Collect papers about a topic

```text
Collect high-relevance papers about "replace with topic". Search existing knowledge first, show query variants and inclusion criteria, then perform a once + personal search. Do not persist or download automatically.
```

### Analyze a local PDF

```text
Analyze this local PDF: D:\papers\paper.pdf. Verify its identity and page count, then explain the research question, method, main evidence, limitations, and reproducibility boundary. Cite physical PDF pages. Do not acquire Artifacts automatically.
```

### Query the personal library

```text
Search the default personal library for records related to "replace with topic". Explain why each result matched and distinguish source metadata, private notes, and unresolved evidence gaps. Do not write changes.
```

### Compare several papers

```text
Compare these papers by research question, assumptions, method, dataset, baselines, key results, limitations, and reproducibility: paste paper IDs, titles, or PDF paths here. Use primary evidence and identify claims that cannot yet be verified.
```

### Inspect official Artifacts

```text
Inspect the official Artifact candidates for this paper: D:\papers\paper.pdf. Show the source evidence, final URLs, expected type, license information, and version boundary. Discover candidates first and do not download or clone without confirmation.
```

### Use team knowledge

```text
Search approved team knowledge for "replace with topic". If selected personal records should be proposed, show exactly what would be submitted, remove private notes and screening opinions, and wait for explicit confirmation.
```

The left-side templates insert equivalent starter prompts into the input box; edit them before sending.

## 8. Tool cards and human confirmation

Tool cards show the Paper Agent operation name, status, input, and output. Read-only searches, PDF analysis, and Artifact discovery can run directly. Material actions create a `confirm`, `select`, or `input` card in the conversation.

Review the targets, risk, details, and manifest fingerprint before selecting **Explicitly approve (`明确同意`)**. Select **Reject / cancel (`拒绝 / 取消`)** whenever the proposed action is broader than intended. Rejection, timeout, stopping generation, deleting the session, or shutting down the service never counts as approval.

Operations that require confirmation include downloads, persistent corpus writes, PDF or Artifact acquisition, personal curation, derived-memory writes, exports, team proposals and reviews, token changes, backups, and configuration writes.

## 9. Manage conversations

- **Stop generation (`停止生成`)** aborts the current model turn without approving a pending operation.
- Select another session to switch conversations.
- Delete a session when its in-memory transcript and model context are no longer needed.
- `persistent` sessions keep context only while the current Paper Agent process is running.
- Restarting the service removes all Web Agent sessions.

Use separate sessions for unrelated research questions so model context and pending confirmations do not mix.

## 10. Troubleshooting

- **Needs model configuration or key:** apply a complete endpoint configuration and submit a memory key, or launch Paper Agent with the project-configured environment variable set.
- **Key missing after restart:** expected behavior for a Web-entered key; enter it again or use the environment-variable option.
- **HTTP Base URL rejected:** use HTTPS unless the endpoint is a loopback test service.
- **Text works but tools fail:** confirm that the selected model and relay support tool/function calling and JSON Schema arguments.
- **Local PDF cannot be found:** provide an absolute path visible to the Paper Agent process.
- **Team search is unavailable:** configure a team service or use `paper-agent --team demo` for a local exercise.
- **Stream reports reconnecting:** keep the launch terminal open and reopen the complete session URL if the local session token was lost.

## 11. Web Agent versus the Pi terminal

Agent chat is the normal browser interface and uses process-memory credentials plus in-memory sessions. `paper-agent agent` starts the advanced original Pi terminal interface, which has its own Pi login, model configuration, and interactive commands. A key entered in the Web page is not copied into Pi configuration.
