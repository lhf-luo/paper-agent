# Paper Agent CLI

[Documentation index](README.md) | [中文 README](../README.zh-CN.md)

## Windows installation

Paper Agent currently runs from a source checkout. Install a user-level command once:

```powershell
git clone https://github.com/lhf-luo/paper-agent.git
Set-Location paper-agent
.\paper-agent.ps1 install
```

The installer:

- selects Node.js `>=22.19.0`;
- installs the exact lockfile dependencies when required;
- builds the Web interface;
- stores the checkout path in the user-level `PAPER_AGENT_HOME` variable;
- creates `%LOCALAPPDATA%\paper-agent\bin\paper-agent.cmd`;
- adds that bin directory to the current user's `PATH`, not the system-wide `PATH`.

The launcher also checks whether the installed dependency metadata is older than the repository lockfile. If the checkout changed, `paper-agent install` repairs the project before reinstalling the command shim. On Windows, close any running Pi/Paper Agent process first because the native clipboard module cannot be replaced while it is loaded.

Open a new PowerShell or CMD window after installation:

```powershell
paper-agent init
paper-agent --doctor
paper-agent
```

`init` is optional. It asks for storage paths, the default personal namespace, local Web behavior, and model endpoint names. Team access is configured separately by pasting a `pateam1.` string in Settings.

To persist a model key without hand-editing JSON, run `paper-agent models add`. The command fetches all models from the provider's `/models` endpoint, writes model metadata to `.paper-agent/config/models.json`, and writes authentication to `.paper-agent/config/auth.json`. New models default to `reasoning: true`; existing declarations are preserved when the same endpoint is refreshed. Use `--no-reasoning` to turn it off for all newly discovered models. Adding a provider does not pick an active model: select one in Agent chat. A previously selected model remains active if it still exists.

All models added or refreshed through this command default to `input: ["text", "image"]`, including relays that only return IDs from `/models`. This is a declared capability, not a verification result: an endpoint may still reject image requests. `models probe-image --model <provider/model>` verifies actual image reading with a generated PNG. New providers default to `openai-completions` with relay-compatible client headers; pass `--api openai-responses` only when the endpoint supports tool-result continuation through the Responses API.

Use `paper-agent models remove --model <provider/model>` to remove one model, or `paper-agent models remove --provider <provider>` to remove a provider and all of its models. Removing the active model clears the active selection unless `--active <provider/model>` names a replacement. A provider credential is deleted automatically when its last model is removed.

Use `paper-agent models probe-image --model <provider/model>` to verify image input with a generated PNG challenge. Discovery alone does not infer multimodal support from a model name.

The shim points to the current checkout. If the repository moves, rerun `.\paper-agent.ps1 install` from the new location.

## Default Web mode

```powershell
# Open the local Web workspace
paper-agent

# Open one PDF in the visual reader
paper-agent D:\papers\example.pdf

# Keep the service running without opening a browser
paper-agent --no-open

# Bind a chosen loopback port
paper-agent --port 43127
```

Relative PDF paths are resolved from the directory where the command is invoked. The local server listens only on loopback and prints its URL. The Web workspace and API do not require a session token. The default configured port is `43127`; `--port` overrides it, and `--port 0` asks the operating system to choose an available port. The Browser Connector requires `43127`.

### Zotero integration

Start Zotero and enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Then open the personal library:

- use **导入 → 从 Zotero 导入** to select Zotero collections or papers;
- use **导出 → Zotero** to copy selected personal-library papers back to Zotero;
- accept the Zotero write dialog on first export, preferably with **Always Allow**.

There is no separate Zotero CLI command. Pi agents can use `search_zotero_library`, `import_zotero_papers`, and `export_papers_to_zotero` with the same local API and confirmation flow.

## Pi agent mode

The conversational Pi interface is explicit:

```powershell
# Interactive Pi session
paper-agent agent

# Paper research workflow
paper-agent --agent D:\papers\example.pdf

# Additional instruction after the PDF
paper-agent --agent D:\papers\example.pdf "Focus on ablations and training cost"
```

The `paper-research` Skill infers one of four research contracts from the natural-language request without adding a CLI mode argument. No goal starts a bounded skim; an explicitly method-only question starts method close reading; ordinary Chinese requests such as `精读` or `深度阅读` start full-paper research with complete physical-page coverage and the fixed 12-section report; reproduction requests add Artifact and configuration inspection after that full-paper contract. The Web visual reader remains the default when only a PDF path is supplied without `--agent`.

## Management commands

| Command | Purpose |
| --- | --- |
| `paper-agent --help` | Show command help |
| `paper-agent --version` | Show source version and checkout path |
| `paper-agent install` | Install/repair dependencies, build Web assets, and install the shim |
| `paper-agent --setup` | Reinstall exact project dependencies and rebuild Web assets |
| `paper-agent init` | Run the first-use configuration wizard |
| `paper-agent models add` | Add discovered models; choose the active one later in Agent chat |
| `paper-agent models remove --model <provider/model>` | Remove one configured model |
| `paper-agent models remove --provider <provider>` | Remove a provider, its models, and its unused credential |
| `paper-agent models list` | List configured models without printing API keys |
| `paper-agent --doctor` | Check Node, dependencies, Web assets, Poppler, OCR, model, and team configuration |
| `paper-agent --doctor --probe-model` | Probe OpenAI-compatible structured tool calling, or report that the configured API requires Pi-session verification |
| `paper-agent --status` | Show command, personal-corpus, Pi, and team status |
| `paper-agent --verify quick` | Run lint, main/Web typechecks, Web build, the main test suite, and CLI/Web/team smoke checks |
| `paper-agent --verify full` | Currently runs the same checks as `quick`; no additional fixed real-PDF gate |
| `paper-agent --verify live` | Include live provider and public-Git smoke checks |
| `paper-agent --team demo` | Start the loopback single-user team demo and open Web |
| `paper-agent --team demo --agent` | Start the same demo in Pi instead of Web |
| `paper-agent --team status` | Check the demo service |
| `paper-agent --team stop` | Stop the verified demo service process |
| `paper-agent --uninstall` | Remove only the command shim and user PATH entry |

The profiles are implemented in `scripts/verify.ts`. They do not run the separate team-server typecheck, team-server Vitest suite, or generated-tool-document check; `npm run check` includes those checks. `npm run release:check` currently aliases `npm run check`. See the [command manual](command-manual.md#8-验证命令) for the remaining CI/release workflow limitations.

## macOS and Linux

After installing Poppler and project dependencies, either add the Poppler executable directory to `PATH` or configure it in `.paper-agent/config/app.json` under `externalTools.commandDirectories`:

```bash
npm ci --ignore-scripts
npm run web:build
./run.sh install
```

The installer creates `~/.local/bin/paper-agent` by default and prints the exact `PATH` instruction when that directory is not currently visible. Open a new shell, then run:

```bash
paper-agent
paper-agent paper.pdf
paper-agent init
paper-agent models add
paper-agent --doctor
paper-agent agent paper.pdf
```

`./run.sh` remains a direct source launcher. It supports the same `--status` and `--verify quick|full|live` management options as Windows. Set `PAPER_AGENT_NODE_BIN` to select a non-default Node executable, or `PAPER_AGENT_CLI_BIN` to choose another user command directory. The installer does not modify shell startup files automatically.

## Uninstall behavior

```powershell
paper-agent --uninstall
```

This removes the user-level shim, its user PATH entry, and `PAPER_AGENT_HOME`. It does not delete the source checkout, personal corpus, team-demo data, Pi credentials, or downloaded materials.

## Troubleshooting

- If the shell cannot find `paper-agent`, open a new terminal so the updated user `PATH` is loaded.
- If the shim reports a missing script, the source checkout moved; reinstall the shim from the new path.
- If `npm ci` reports `EPERM ... clipboard.win32-x64-msvc.node`, close every Pi/Paper Agent process using this checkout and rerun the installer. Windows locks the native clipboard module while it is loaded.
- If Node reports an unknown `.ts` extension, the command is using an old system Node. Run through the installed launcher or upgrade Node to `>=22.19.0`.
- If Pi reports `No models available`, configure a provider as described in [model configuration](model-configuration.md). The Web workspace itself remains usable.
- If PDF tools are missing, install Poppler `>=22.05`, configure the directory containing its commands in `externalTools.commandDirectories`, and rerun `paper-agent --doctor`.
