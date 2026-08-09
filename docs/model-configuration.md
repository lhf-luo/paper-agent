# Model Configuration

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

Most of the local Web workspace does not require a model. A provider is needed only for the built-in **Agent 对话** page or the advanced Pi terminal interface.

## Web Agent chat

Start the normal Web workspace with `paper-agent`, then open **Agent 对话**. The page accepts:

- Provider ID;
- Model ID;
- Base URL;
- API type: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`;
- API key.

The Base URL must use HTTPS. Plain HTTP is accepted only for loopback test services on `localhost`, `127.0.0.1`, or `::1`.

An API key entered in the Web page is ephemeral: it remains only in the current Paper Agent service process, the password field is cleared after a successful submission, and a restart discards it. The value is not written to project configuration, Pi `auth.json`/`models.json`, browser storage, transcripts, logs, or returned errors. Clearing the key or changing the endpoint also destroys existing Agent sessions.

As an alternative, configure a model in **Settings & diagnostics** with an API-key environment-variable name and set that variable in the process that launches Paper Agent. The project configuration stores only the variable name. Environment credentials apply only to the provider, model, Base URL, and API type for which they were configured; if that endpoint identity changes, supply a new Web key or update and restart with matching project configuration.

For the complete first-use flow—from opening the page through creating a session and starting a literature task—see the [Web Agent user guide](web-agent-guide.md) or its [Chinese version](web-agent-guide.zh-CN.md).

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

These are user-private Pi credentials, separate from the Web Agent's process-memory key. Never commit them to this repository or paste them into issues, logs, or shared transcripts.

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

The Web **Settings & diagnostics** page can store the provider ID, model ID, API type, base URL, and API-key environment-variable name. It never stores the key value. Save model edits before probing; changing an endpoint field clears any older stored verification result. The separate **Agent 对话** page can use that environment credential or accept a process-memory-only key for the current service run.

## Literature providers

The following variables are optional:

```powershell
$env:OPENALEX_MAILTO = "researcher@example.org"
$env:CROSSREF_POLITE_EMAIL = "researcher@example.org"
$env:S2_API_KEY = "optional-semantic-scholar-key"
```

OpenAlex and Crossref use the email values for polite API traffic. Semantic Scholar may work without a key at a lower public rate limit.
