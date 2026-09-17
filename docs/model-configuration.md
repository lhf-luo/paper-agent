# Model Configuration

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Most of the local Web workspace does not require a model. A provider is needed for Agent conversations, including the built-in **Agent 对话** page and paper-reader conversations, or the advanced Pi terminal interface.

## Web Agent chat

Start the normal Web workspace with `paper-agent`, then open **Settings & diagnostics (`系统设置`)**. The first block on that page is **Model providers (`模型与供应商`)**, where you add and edit the endpoints Agent chat can use.

Select **Add provider (`添加供应商`)** and fill in:

- Base URL;
- Provider ID (`供应商 ID`), inferred from the Base URL host unless you override it;
- API type: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`;
- API key, or the name of an environment variable that holds it;
- the models to enable.

The Base URL must use HTTPS. Plain HTTP is accepted only for loopback test services on `localhost`, `127.0.0.1`, or `::1`.

For `openai-completions` and `openai-responses`, **Load model list (`读取模型列表`)** calls the endpoint's OpenAI-compatible `/models` route and lists what it reports, so you can tick the models you want. The other two API types have no discovery implementation; enter those model IDs manually, one per line.

**Add and save** returns an exact-plan confirmation before writing. Saving stores model declarations in `.paper-agent/config/models.json` and the credential in `.paper-agent/config/auth.json`, keeping the two separate. The key is never returned to the browser through the configuration view: reads substitute `[redacted]`, and an empty key field while reconfiguring a provider leaves the stored credential unchanged. Every model under one provider shares a single credential. The whole `.paper-agent/` directory is gitignored; do not copy those files into commits, issues, logs, or shared transcripts.

The provider block lets you **Set as chat model (`设为对话模型`)** for Agent chat, and remove a single model or a whole provider; those edits save immediately. Removing the current chat model also clears that selection. Reconfiguring a provider replaces its previous model entries, but models whose API and Base URL are unchanged keep their declared context window, input modalities, and stored capability probes.

**Restart the Web service after adding or removing models.** The Web Agent reads the configured model list once at startup, so new entries only appear in the Agent chat selector after a restart. Changing just the current chat model takes effect on the next message.

The `/models` endpoint usually does not report capabilities reliably. Newly discovered models default to `reasoning: true`; use `--no-reasoning` on the CLI to override that for every discovered model. Existing declarations are preserved on a same-endpoint refresh unless a reasoning flag is provided. Reasoning tokens alone do not guarantee that the relay returns visible reasoning content.

Models added or refreshed through `models add`, and models added from the Web dialog, default to `input: ["text", "image"]` even if `/models` only returns IDs. The flag declares capability but does not prove it: an endpoint may reject actual image requests. Use `models probe-image --model <provider/model>` to verify image reading, and the **Probe (`探测`)** button in the provider block (or `paper-agent --doctor --probe-model`) to verify tool calling. `anthropic-messages` and `google-generative-ai` cannot be probed automatically; verify them from `paper-agent agent` with a real tool-using task.

You can also use the CLI for the same operations:

```powershell
paper-agent models add
```

Enter the provider Base URL and API key when prompted. Paper Agent calls the provider's OpenAI-compatible `/models` endpoint, writes Pi-style model metadata to `.paper-agent/config/models.json`, and stores provider authentication separately in `.paper-agent/config/auth.json`. Adding models does not require choosing an active model; select one in Agent chat. A previously selected model remains active if it is still configured. New endpoints default to `openai-completions` and use the same relay-compatible client headers as Pi relay models. Reconfiguring a provider replaces that provider's previous model entries.

Remove one model or an entire provider without editing JSON manually:

```powershell
paper-agent models remove --model research-relay/your-model-id
paper-agent models remove --provider research-relay
```

Removing the active model clears the active selection unless `--active <provider/model>` selects a remaining model. Removing the final model for a provider also removes its stored credential. References to a removed PDF translation model are cleared automatically.

Use `--api openai-responses` only when the relay supports the full Responses lifecycle, including continuation requests containing tool results. Some relays accept the initial Responses request but fail on the continuation with HTTP 502. OpenOX should currently be configured with `openai-completions`.

To verify a visual model explicitly:

```powershell
paper-agent models probe-image --model deepseek/deepseek-flash
```

The probe sends a generated PNG color challenge. A model is marked as supporting image input only when it reads the challenge correctly; a successful HTTP response alone is insufficient. Probe failures are recorded for diagnosis but do not erase an existing manual image declaration, because a gateway may reject images even when the underlying model supports them.

You can also keep keys in the environment by filling **Or environment variable name (`或使用环境变量名`)** when adding a provider, then setting that variable in the process that launches Paper Agent. Environment credentials apply only to the provider, model, Base URL, and API type for which they were configured; if that endpoint identity changes, supply a new key or update and restart with matching project configuration.

For the complete first-use flow, from opening the page through creating a session and starting a literature task, see the [Web Agent user guide](web-agent-guide.md) or its [Chinese version](web-agent-guide.zh-CN.md).

## Advanced Pi terminal with built-in providers

Start the advanced original Pi terminal interface:

```powershell
paper-agent agent
```

Then run inside Pi:

```text
/login
/model
```

These are user-private Pi credentials, separate from the model providers configured for the Web Agent. Never commit them to this repository or paste them into issues, logs, or shared transcripts.

## Split project configuration

Paper Agent now reads configuration from `.paper-agent/config/`:

- `app.json`: local Web and storage defaults;
- `search.json`: literature providers, limits, query expansion, and corpus reuse;
- `models.json`: active model and Pi-style provider/model metadata, including `input`, context window, token limit, and compatibility fields;
- `auth.json`: model-provider API keys or environment-variable references, grouped by provider;
- `network.json`: proxy settings and no-proxy hosts;
- `credentials.json`: literature-provider credentials, polite-contact values, and the optional redacted `githubToken` used only for public GitHub Artifact discovery;
- `.paper-agent/team-access.json`: generated after a `pateam1.` team access string is validated; it is not part of split model configuration.

Paper Agent only reads this split directory. There is no legacy single-file config path.

## Pi built-in tools

The Web Agent reads its Pi built-in tool allowlist from `.paper-agent/config/app.json`:

```json
{
  "agent": {
	"shellPath": "D:\\git\\bin\\bash.exe",
    "builtinTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
  }
}
```

An omitted field or an empty list disables every Pi built-in tool. A read-oriented setup can use
`["read", "grep", "find", "ls"]`; the full list also permits shell commands and workspace changes.
`bash`, `edit`, and `write` are high-trust capabilities and do not use Paper Agent's normal
prepare/confirm operation cards. Restart the Web service after changing this list. Project extension
tools remain available independently of this setting. On Windows, set `shellPath` when Git Bash is
not installed at `C:\Program Files\Git\bin\bash.exe` and its directory is not on `PATH`.

## OpenAI-compatible relay

Pi reads custom model definitions from:

- Windows: `%USERPROFILE%\.pi\agent\models.json`
- macOS/Linux: `~/.pi/agent/models.json`

Keep the secret in an environment variable:

```powershell
$env:PAPER_AGENT_RELAY_API_KEY = "your-private-key"
```

Example provider:

```json
{
  "providers": {
    "research-relay": {
      "baseUrl": "https://relay.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$PAPER_AGENT_RELAY_API_KEY",
      "models": [
        {
          "id": "your-model-id",
          "name": "Research Relay Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Open `/model` again after editing the file. The `id`, API type, context window, and token limit must match the relay's actual behavior. Pi supports `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai` provider APIs.

For Paper Agent, the relay must reliably support streaming, tool/function calling, JSON Schema arguments, and enough context for PDF research. A model appearing in `/model` only proves configuration parsing.

- `openai-completions` and `openai-responses`: run `paper-agent --doctor --probe-model` or use the confirmed Web settings probe. The CLI probe is a one-shot read-only request; the Web probe persists its result only after an exact-plan confirmation. Either request may consume a small amount of provider quota.
- `anthropic-messages` and `google-generative-ai`: Paper Agent accepts and passes these API types to Pi, but its automatic probe does not emulate those protocols. Verify them from `paper-agent agent` with a real `/paper`, `/collect`, or other tool-using task. The doctor and Web interface label this as manual verification rather than a failed model.

The Web **Settings & diagnostics** page is where you store the provider ID, model ID, API type, base URL, and API key (or its environment-variable name); both the **Agent 对话** page and the provider block read the same project configuration. Save model edits before probing, since changing the endpoint invalidates an older stored verification result.

## Literature providers

The following variables are optional:

```powershell
$env:OPENALEX_MAILTO = "researcher@example.org"
$env:CROSSREF_POLITE_EMAIL = "researcher@example.org"
$env:S2_API_KEY = "optional-semantic-scholar-key"
```

OpenAlex and Crossref use the email values for polite API traffic. Semantic Scholar may work without a key at a lower public rate limit.

`.paper-agent/config/search.json` separates keyword discovery from DOI enrichment. `providers` contains only keyword-search sources. `doiEnrichmentProviders` controls the exact-DOI metadata pass that runs before selected search results or local PDFs are saved. The default DOI list is `crossref`, `openalex`, `semanticscholar`, `opencitations`, and `unpaywall`; individual failures are non-blocking warnings.
