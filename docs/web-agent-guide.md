# Web Agent User Guide

[Documentation index](README.md) | [简体中文](web-agent-guide.zh-CN.md)

Paper Agent's **Agent chat** page is the primary conversational interface for literature research in the browser. It combines the `literature-corpus-manager`, `paper-research`, and `research-wiki` Skills with Paper Agent's paper search, PDF, Artifact, personal-library, team-library, research-workspace, and Wiki tools.

The Skills are loaded automatically. You do not need a slash command or need to name a Skill in every request.

## 1. Open Agent chat

Start the installed application:

```powershell
paper-agent
```

Keep the launch terminal open, then select **Agent chat** in the navigation. If the browser does not open automatically, run:

```powershell
paper-agent --no-open
```

Open the loopback URL printed in the terminal. The local Web interface does not require a session token.

Ordinary Web management functions work without a model. Agent conversations, including those in the paper reader, and the advanced Pi terminal require a model.

## 2. Configure the model

Open **Settings & diagnostics (`系统设置`)** in the left navigation. The first block is **Model providers (`模型与供应商`)**. Select **Add provider (`添加供应商`)** and fill in the dialog:

| Field | What to enter |
| --- | --- |
| Base URL | The provider or relay API root |
| Provider ID (`供应商 ID`) | A stable local name for the relay, such as `research-relay`; inferred from the Base URL host by default and editable |
| API type (`API 类型`) | The protocol implemented by the endpoint |
| API key | That provider's key, written to local configuration |
| Or environment variable name (`或使用环境变量名`) | Let Paper Agent read the key from a named environment variable, storing only the variable name |

Choose the API type that the endpoint actually implements:

| Endpoint protocol | API type |
| --- | --- |
| OpenAI-compatible Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Google Generative AI | `google-generative-ai` |

The Base URL must use HTTPS. Plain HTTP is accepted only for a loopback service on `localhost`, `127.0.0.1`, or `::1`.

For `openai-completions` and `openai-responses`, select **Load model list (`读取模型列表`)** after entering the API key. Paper Agent calls that endpoint's `/models` route and lists what it reports; tick the models you want. You can also skip discovery and type one model ID per line under **Enter model IDs manually (`手动填写模型 ID`)**. The `anthropic-messages` and `google-generative-ai` protocols do not support discovery and must be entered manually.

**Add and save (`添加并保存`)** first returns an exact-plan confirmation; after you confirm, Paper Agent writes `.paper-agent/config/models.json` and `.paper-agent/config/auth.json`. The key is never returned to the browser through the configuration view.

Back in the **Model providers** block:

- Each provider lists its models; **Set as chat model (`设为对话模型`)** chooses the one Agent chat uses by default;
- **Remove model** and **Remove provider** save immediately; removing the current chat model also clears that selection;
- Reconfiguring the same provider replaces its previous model entries, while models whose API and Base URL are unchanged keep their existing context window and input capability declarations.

**Restart Paper Agent after adding or removing models** so the new entries appear in the Agent chat model selector. Changing only the current chat model takes effect on the next message.

Every model under one provider shares a single credential, so a new key requires reconfiguring that whole provider.

The endpoint must support streaming, tool/function calling, JSON Schema arguments, and enough context for the requested research task. A successful model connection does not by itself prove that tool calling works; select **Probe (`探测`)** to send one very small tool-calling request and verify it. `anthropic-messages` and `google-generative-ai` cannot be probed automatically; verify them from `paper-agent agent` with a real tool-using task.

## 3. Understand credential lifetime

An API key entered in the **Add provider** dialog:

- is written to `.paper-agent/config/auth.json`, stored separately from the model declarations;
- is never returned to the browser by `/api/config`, which substitutes `[redacted]`;
- is kept unchanged when you leave the key field empty while reconfiguring that provider;
- must not be copied into commits, issues, logs, or shared transcripts — the whole `.paper-agent/` directory is gitignored.

The Agent chat model selector now reads project configuration, so there is no longer a key that exists only in the current service process. For a reusable launch configuration, fill in **Or environment variable name** when adding the provider, set that variable before launching Paper Agent, and then start the service from the same terminal. The project stores only the variable name, never its value:

```powershell
$env:PAPER_AGENT_RELAY_API_KEY = "your-private-key"
paper-agent
```

```bash
export PAPER_AGENT_RELAY_API_KEY="your-private-key"
paper-agent
```

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
| Web conversation runtime | `once` / `persistent` | `once` releases the Pi runtime after each turn; `persistent` reuses it between turns. Both retain saved conversation records |
| Research-task lifetime | `once` / `persistent` | `once` does not merge candidates into the personal paper library; `persistent` prepares reusable library writes under the configured confirmation policy |
| Knowledge scope | `personal` / `team` | `personal` is private working knowledge; `team` uses shared records and a proposal/review workflow. Check the returned review state |

The selector beside **New session (`新建会话`)** controls only Web conversation context and currently opens on `persistent`. It does not authorize any corpus write. The `literature-corpus-manager` Skill defaults an unstated research-task lifetime and scope to `once + personal`.

Each `once` turn uses independent in-memory model context. Later turns and service restarts do not reload earlier Pi context. The interface still saves messages for viewing, and literature collection still persists a local search run for later selection. Saved interface history and search results are not automatically sent back to the model or turned into curated Wiki knowledge. Use a new conversation to separate unrelated questions.

State task lifetime and scope when they matter. A persistent conversation can still perform disposable research:

```text
Keep this conversation available for follow-up questions, but run the literature collection as once + personal. Search existing knowledge first, and do not persist records or propose anything to the team library.
```

For reusable collection, ask explicitly. If you want the Agent to wait before saving, state that requirement in the request; ordinary personal-library writes do not show a confirmation card by default:

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
7. prepare the exact write or acquisition plan, respect any explicit request to wait, and use the operation confirmation policy described below;
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

```text
Pull the approved "replace with topic" team papers into my personal library, including their PDFs. Only approved records; show exactly which papers and PDFs would be written first.
```

Team search only returns approved papers by default, and pulling team papers into the personal library is a confirmed `personal-corpus-write`; personal notes and screening opinions are never copied down.

The left-side templates insert equivalent starter prompts into the input box; edit them before sending.

## 8. Tool cards and human confirmation

Tool cards show the Paper Agent operation name, status, input, and output. Searches, PDF analysis, and Artifact discovery can run without write confirmation. Operations that need user input create a `confirm`, `select`, or `input` card in the conversation.

Review the targets, risk, details, and manifest fingerprint before selecting **Explicitly approve (`明确同意`)**. Select **Reject / cancel (`拒绝 / 取消`)** whenever the proposed action is broader than intended. Rejection, timeout, stopping generation, deleting the session, or shutting down the service never counts as approval.

Ordinary Agent and Web personal-library writes do not ask by default. Personal-library deletion, research-workspace changes, Wiki writes, and PDF/Artifact operations ask by default; these categories have switches in **Settings & diagnostics**. Team operations, token management, backup/restore, configuration writes, model probes, and system file operations always ask. Turning off a confirmation switch still uses the exact plan fingerprint and a one-time grant issued by local policy. An explicit user instruction to wait still applies.

This policy covers Paper Agent's operation tools. Optional high-trust Pi built-in tools such as `bash`, `edit`, and `write` do not pass through these operation cards; see [System guide](system-guide.md#8-安全边界).

## 9. Manage conversations

- **Stop generation (`停止生成`)** aborts the current model turn without approving a pending operation.
- Select another session to switch conversations.
- Deleting a session removes its stored conversation and associated Pi session data.
- General Web conversations are saved under `.paper-agent/web-agent-memory/session-views/`; Pi context files are under `pi-sessions/`. Paper-reader conversations are stored in the personal SQLite database and are isolated by namespace and paper.
- Restarting the service restores saved conversations. It does not resume an interrupted model turn or approve a pending confirmation. Web-entered keys must be supplied again.

Use separate sessions for unrelated research questions so model context and pending confirmations do not mix.

## 10. Troubleshooting

- **Needs model configuration or key:** add a provider in **Settings & diagnostics** with a Base URL and API key, or launch Paper Agent with the configured environment variable set.
- **Key missing after restart:** expected behavior for a Web-entered key; enter it again or use the environment-variable option.
- **HTTP Base URL rejected:** use HTTPS unless the endpoint is a loopback test service.
- **Text works but tools fail:** confirm that the selected model and relay support tool/function calling and JSON Schema arguments.
- **Local PDF cannot be found:** provide an absolute path visible to the Paper Agent process.
- **Team search is unavailable:** configure a team service or use `paper-agent --team demo` for a local exercise.
- **Stream reports reconnecting:** keep the launch terminal open and confirm that the local service is still running.

## 11. Web Agent versus the Pi terminal

Agent chat is the normal browser interface, with persisted conversations and providers configured from **Settings & diagnostics**. It can use a key stored in project configuration or an environment credential. `paper-agent agent` starts the advanced original Pi terminal interface, which has its own Pi login, model configuration, and interactive commands. Web-configured model credentials are not copied into Pi configuration.
