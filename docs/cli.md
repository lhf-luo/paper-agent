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

`init` is optional. It asks for storage paths, the default personal namespace, local Web behavior, model endpoint names, and team connection names. It stores environment-variable names only, never secret values.

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
paper-agent --port 4317
```

Relative PDF paths are resolved from the directory where the command is invoked. The local server listens only on loopback and prints its URL. Browser API calls require the ephemeral session token supplied in the launch URL. When `--no-open` is used, open the complete session URL printed in the terminal rather than the bare host URL.

## Pi agent mode

The conversational Pi interface is explicit:

```powershell
# Interactive Pi session
paper-agent agent

# Quick paper workflow
paper-agent --agent D:\papers\example.pdf

# Methods/full/reproduce workflow
paper-agent --agent --mode methods D:\papers\example.pdf
paper-agent --agent --mode full D:\papers\example.pdf
paper-agent --agent --mode reproduce D:\papers\example.pdf

# Additional instruction after the PDF
paper-agent --agent --mode methods D:\papers\example.pdf "Focus on ablations and training cost"
```

`--mode` selects Pi agent mode automatically. The Web visual reader remains the default when only a PDF path is supplied.

## Management commands

| Command | Purpose |
| --- | --- |
| `paper-agent --help` | Show command help |
| `paper-agent --version` | Show source version and checkout path |
| `paper-agent install` | Install/repair dependencies, build Web assets, and install the shim |
| `paper-agent --setup` | Reinstall exact project dependencies and rebuild Web assets |
| `paper-agent init` | Run the first-use configuration wizard |
| `paper-agent --doctor` | Check Node, dependencies, Web assets, Poppler, OCR, model, and team configuration |
| `paper-agent --doctor --probe-model` | Probe OpenAI-compatible structured tool calling, or report that the configured API requires Pi-session verification |
| `paper-agent --status` | Show command, personal-corpus, Pi, and team status |
| `paper-agent --verify quick` | Run deterministic checks without the fixed real-PDF set |
| `paper-agent --verify full` | Include the fixed real-PDF release gate |
| `paper-agent --verify live` | Include live provider and public-Git smoke checks |
| `paper-agent --team demo` | Start the loopback single-user team demo and open Web |
| `paper-agent --team demo --agent` | Start the same demo in Pi instead of Web |
| `paper-agent --team status` | Check the demo service |
| `paper-agent --team stop` | Stop the verified demo service process |
| `paper-agent --uninstall` | Remove only the command shim and user PATH entry |

Legacy forms such as `paper-agent doctor`, `paper-agent team demo`, and `.\paper-agent.ps1 start` remain supported.

## macOS and Linux

After installing Poppler and project dependencies:

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
paper-agent --doctor
paper-agent agent paper.pdf
```

`./run.sh` remains a direct source launcher. It supports the same `status` and `verify quick|full|live` management commands as Windows. Set `PAPER_AGENT_NODE_BIN` to select a non-default Node executable, or `PAPER_AGENT_CLI_BIN` to choose another user command directory. The installer does not modify shell startup files automatically.

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
- If PDF tools are missing, install Poppler `>=22.05` and rerun `paper-agent --doctor`.
