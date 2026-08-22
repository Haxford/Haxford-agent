# haxford

Single-process terminal AI coding agent that works across your whole codebase — reads, edits, and runs commands across many files per turn — with permission-gated tools and an Ink TUI. It assembles a system prompt with tool schemas, streams model output, executes tool calls in one process (no daemon), and feeds results back until the model stops calling tools. Sessions persist as append-only JSONL so they resume and fork without rewrite.

- **One process** — no daemon, no language server, no background services.
- **Bring-your-own-key** — eight built-in providers plus the live OpenRouter catalog.
- **Permission-gated** — every mutating action is judged by a rule engine and prompts before it runs.

## Install

One line — downloads the prebuilt binary for your platform, verifies its checksum, and installs to `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/Haxford/Haxford-agent/main/install.sh | bash
```

Re-run it any time to upgrade; it is a no-op when you are already on the latest release. Builds are published for Linux (x64, arm64, glibc and musl) and macOS (Intel and Apple silicon), including `-baseline` variants for x86-64 CPUs without AVX2 — the installer detects which one your machine needs.

| Variable | Effect |
|---|---|
| `HAXFORD_VERSION=v0.1.0` | install a specific release instead of the latest |
| `HAXFORD_INSTALL_DIR=<dir>` | install somewhere other than `~/.local/bin` |
| `HAXFORD_NO_MODIFY_PATH=1` | never touch your shell rc files |
| `HAXFORD_FORCE=1` | reinstall even if the current version is already present |

Or build from source — requires [Bun](https://bun.sh) >= 1.2:

```bash
git clone https://github.com/Haxford/Haxford-agent.git && cd Haxford-agent
bun install
bun run compile          # build the standalone ./haxford binary
ln -s "$PWD/haxford" ~/.local/bin/haxford   # put it on PATH
```

To uninstall, delete the binary: `rm ~/.local/bin/haxford`.

Set a provider key, or reuse one already in opencode's auth store (`~/.local/share/opencode/auth.json` — haxford reads it read-only):

```bash
export ANTHROPIC_API_KEY="sk-..."   # or OPENROUTER_API_KEY, OPENAI_API_KEY, …
```

## Quickstart

```bash
haxford                          # open the TUI in this directory
haxford "explain src/index.ts"   # start with an initial prompt
haxford -c                       # resume the most recent session here
haxford -m openrouter/z-ai/glm-5.2   # pick a model for this run
haxford --mode plan              # read-only research mode
haxford -p "list the tsconfig settings"   # non-interactive, streams to stdout
```

## Documentation

| Page | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first run, what you see |
| [Providers](docs/providers.md) | All eight providers, auth precedence, model spec format |
| [Permissions](docs/permissions.md) | Modes, rule syntax, compound commands, always-allow |
| [Commands](docs/commands.md) | Slash command reference, autocomplete, keybindings |
| [Configuration](docs/configuration.md) | Config files, merge rules, annotated example |
| [Sessions](docs/sessions.md) | Storage layout, resume, fork, compaction |
| [Architecture](docs/architecture.md) | Loop → events → store, contracts, contributing |

## Status & limits

Single-process by design — no MCP server or plugin runtime yet. Image input is not supported; only text parts are sent to the model. There is no built-in sandboxing; haxford runs with the permissions of the user and process that launched it.
