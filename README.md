# haxford

A terminal AI coding agent that works across your whole codebase. It assembles a system prompt with tool schemas, streams model output, executes tool calls in one process (no daemon), and feeds results back until the model stops calling tools. Sessions persist as append-only JSONL so they resume and fork without rewrite.

- **One process** — no daemon, no language server, no background services.
- **Bring-your-own-key** — eight built-in providers plus the live OpenRouter catalog.
- **Permission-gated** — every mutating action is judged by a rule engine and prompts before it runs.
- **Ten tools** — read, write, edit, bash, glob, grep, todo tracking, webfetch, and a `task` subagent.
- **Resumable sessions** — JSONL transcripts with compaction, resume, and fork.
- **Extensible without a fork** — skills, TypeScript extensions, and themes load from `~/.haxford`; `/reload` picks up changes.

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

To uninstall, delete the binary: `rm ~/.local/bin/haxford`.

### Build from source

Requires [Bun](https://bun.sh) >= 1.2:

```bash
git clone https://github.com/Haxford/Haxford-agent.git && cd Haxford-agent
bun install
bun run compile          # build the standalone ./haxford binary
ln -s "$PWD/haxford" ~/.local/bin/haxford   # put it on PATH
```

## Quickstart

Set a provider key, or reuse one already in opencode's auth store (`~/.local/share/opencode/auth.json` — haxford reads it read-only):

```bash
export ANTHROPIC_API_KEY="sk-..."   # or OPENROUTER_API_KEY, OPENAI_API_KEY, …
```

Then run it in a project directory:

```bash
haxford                          # open the TUI in this directory
haxford "explain src/index.ts"   # start with an initial prompt
haxford -c                       # resume the most recent session here
haxford -m openrouter/z-ai/glm-5.2   # pick a model for this run
haxford --mode plan              # read-only research mode
haxford -p "list the tsconfig settings"   # non-interactive, streams to stdout
```

Type a request and press Enter. The model streams its reply; tool calls run inline. Mutating actions (`write`, `edit`, `bash`) prompt a confirmation — press `a` to allow once, `l` to always allow, or `d` to deny. Run `/help` any time for in-app help.

For the full first-run flow, see [Getting started](docs/getting-started.md).

## Documentation

| Page | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first run, what you see on screen |
| [Using haxford](docs/usage.md) | CLI reference, interactive mode, context files, print mode |
| [Tools](docs/tools.md) | All ten built-in tools, their limits, and defaults |
| [Providers](docs/providers.md) | All eight providers, auth precedence, `/connect`, model spec format |
| [Permissions](docs/permissions.md) | Modes, rule syntax, compound commands, always-allow persistence |
| [Commands](docs/commands.md) | Slash command reference, autocomplete, keybindings |
| [Extending](docs/extending.md) | Skills, extensions (commands/tools/hooks), themes, `/reload` |
| [Configuration](docs/configuration.md) | Config files, merge rules, annotated example |
| [Sessions](docs/sessions.md) | Storage layout, resume, fork, compaction |
| [Session format](docs/session-format.md) | JSONL transcript schema and entry types |
| [Security](docs/security.md) | Trust model, key handling, vulnerability reporting |
| [Environment variables](docs/environment-variables.md) | Every variable haxford reads, in one place |
| [Architecture](docs/architecture.md) | Loop → events → store, contracts, contributing |

## How it works

A single-process agent loop: system prompt + history + tool schemas → stream from the model → execute tool calls (each gated by the permission engine) → feed results back → repeat until the model stops calling tools. All visible state changes are emitted as `AgentEvent`s; the Ink TUI reduces them into render state. See [Architecture](docs/architecture.md) for the full picture.

## Status & limits

Single-process by design — no MCP support yet. Image input is not supported; only text parts are sent to the model. There is no built-in sandboxing; haxford runs with the permissions of the user and process that launched it. Read [Security](docs/security.md) before running it in `auto` mode or against an unfamiliar checkout.

## Contributing

Issues and pull requests are welcome. [`AGENTS.md`](AGENTS.md) is the convention contract: strict TypeScript that passes `bun run typecheck`, Bun runtime APIs over Node equivalents, small modules, and tests via `bun test`. See [Architecture](docs/architecture.md#contributing) for the short version and the source layout.

```bash
bun install
bun test            # run all tests
bun run typecheck   # must be clean before any change lands
```

## License

[MIT](LICENSE)
