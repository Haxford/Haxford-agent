# haxford

Single-process terminal AI coding agent with permission-gated tools and an Ink TUI.

- One process — no daemon, no language server, no background services.
- Bring-your-own-key via OpenRouter-compatible providers (Anthropic, OpenAI, OpenRouter, Ollama, z-ai, Moonshot, opencode zen, codex).
- Permission-gated tools — every mutating action is judged by a rule engine and prompts before it runs.

## Description

haxford is a terminal coding agent harness written in TypeScript on Bun with a React/Ink TUI. It assembles a system prompt with tool schemas, streams model output, executes tool calls in a single-process loop, and feeds results back until the model stops calling tools. All state changes flow through one event stream into the TUI store. It is for developers who want a local, scriptable, permission-aware agent they can point at their own codebase. It works today: interactive TUI, print mode, eight providers, session resume/fork, and compaction all function.

## Install

Requires Bun >= 1.2.

```bash
git clone <repo> && cd haxford-agent
bun install
bun run compile               # build the standalone ./haxford binary
mkdir -p ~/.local/bin && ln -s "$PWD/haxford" ~/.local/bin/haxford   # put it on PATH
```

Set a provider key in the environment, or reuse one already stored in opencode's auth store (`~/.local/share/opencode/auth.json`) — haxford reads it read-only and never writes there:

```bash
export OPENROUTER_API_KEY="sk-or-..."   # or ANTHROPIC_API_KEY, OPENAI_API_KEY, …
```

## Quickstart

```bash
haxford                         # open the TUI in this directory
haxford "explain src/index.ts"  # start with an initial prompt
haxford -c                      # resume the most recent session here
haxford -m openrouter/z-ai/glm-5.2   # pick a model for this run
haxford --mode plan             # read-only research mode
haxford -p "list the tsconfig settings"   # non-interactive, streams to stdout
```

## Features

**Agent loop.** Streaming responses, tool calling with retry and exponential backoff (retries only retryable errors; 401/400 are fatal), max-turns cap, and auto-compaction when context usage exceeds the configured fraction.

**Providers and models.** Eight built-in providers (see `src/providers/index.ts`); the `/model` picker lists every curated model plus the live OpenRouter catalog with context window and per-million-token pricing. Availability is probed live for Ollama and truthfully reported for the rest. Codex (ChatGPT login) reads `~/.codex/auth.json`.

**Tools.** `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todo` (read + write), and `task` (a subagent that runs its own loop with inherited permissions).

**Permission modes.** `build` (evaluate rules, ask on `ask`), `auto` (allow all except explicit denies), `plan` (read-only; mutating tools denied, only a read-only command allowlist passes for bash). `always` answers are persisted to `./.haxford/settings.local.json` keyed by tool + matched pattern.

**Compaction.** `/compact` manually summarizes the conversation into a synthetic user message; auto-compact fires above the configured usage fraction.

**Subagents.** The `task` tool spawns a nested loop with its own subagent type and inherited mode.

**Sessions.** Append-only JSONL under a per-project directory; resume latest (`-c`), resume by id (`-s`), or fork by starting a new session. The `/sessions` picker lists prior sessions for the current project.

**Slash commands.** Eight commands with autocomplete (see table below).

**TUI.** Ink/React TUI that borrows the terminal's own 16-color palette (no hardcoded colors), left-rail grouping instead of boxes, `<Static>` for finalized transcript so streaming re-renders only the in-flight tail, and a shared spinner ticker.

## Slash commands

| Command | Description |
|---|---|
| `/help` | Show in-app command and keybinding help |
| `/model` | Switch the active model (live picker with pricing) |
| `/sessions` | Resume a previous session for this directory |
| `/compact` | Compact the conversation now |
| `/init` | Analyze the codebase and create/improve `AGENTS.md` |
| `/mode` | Switch permission mode (`build` \| `auto` \| `plan`) |
| `/clear` | Start a fresh session |
| `/exit` | Quit haxford |

In the TUI, type `/` to open autocomplete; `↑`/`↓` moves, `Enter` accepts.

## Configuration

haxford loads and deep-merges global then project config (project wins on scalar conflicts; permission rules merge per pattern):

- Global: `~/.config/haxford/haxford.json` (or `$XDG_CONFIG_HOME/haxford/haxford.json`)
- Project: `./haxford.json`
- An `AGENTS.md` in the project root is read verbatim and appended to the system prompt.

```json
{
  "model": "anthropic/claude-sonnet-5",
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." }
  },
  "permission": {
    "bash": { "git status": "allow", "rm *": "deny", "*": "ask" },
    "write": "ask",
    "read": "allow"
  },
  "maxTurns": 100,
  "autoCompactAt": 0.9
}
```

Data dir (sessions, metadata): `$HAXFORD_DATA_DIR`, else `$XDG_DATA_HOME/haxford`, else `~/.local/share/haxford`. Layout: `<data>/projects/<base64url(cwd)>/sessions/<id>.jsonl`.

## Architecture

- **Loop → events → store.** `runAgentLoop` streams model output and emits `AgentEvent`s; the TUI store reduces them into render state; Ink diffs and renders.
- **Single process.** Provider calls, tool execution, permission checks, and the TUI all run in one Bun process — no daemon.
- **Permission gates every tool call.** `createAskHandler` evaluates rules + mode before any tool runs; in the TUI it bridges to the approval dialog.
- **JSONL append-only.** Each message snapshot is one line; a later line with the same id supersedes earlier ones on load — so sessions resume and fork without rewrite.
- **Tools return errors as results, not throws.** A failed tool yields a `ToolResult` describing the failure; only programmer errors throw.
- **Per-project sessions.** Keyed by the working directory, so `/sessions` only shows sessions from the current project.

## Development

```bash
bun test            # run all tests
bun run typecheck   # tsc --noEmit; must be clean before any task is done
bun run dev "<prompt>"   # run the CLI
bun run compile           # build a standalone binary
```

| Path | Contents |
|---|---|
| `src/types/` | Shared contracts (FROZEN — import, never modify). |
| `src/agent/` | Agentic loop, system prompt, retry, compaction. |
| `src/providers/` | AI SDK model/provider resolution and auth. |
| `src/tools/` | Tool implementations (read/write/edit/bash/glob/grep/todo/task). |
| `src/permission/` | Permission rule engine and always-allow persistence. |
| `src/session/` | JSONL session persistence, resume, fork. |
| `src/tui/` | Ink TUI: transcript, composer, dialogs, slash commands. |
| `src/index.ts`, `src/config/` | Entrypoint, CLI parsing, config loading. |
| `tests/` | Test suites (`bun test`). |

Strict TypeScript is enforced (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `.ts` import extensions). Runtime is Bun — prefer `Bun.file`/`Bun.write`/`Bun.spawn` over Node equivalents. See `AGENTS.md` for the full convention contract contributors must follow.

## Status & limits

Single-process by design — no MCP server or plugin runtime yet, and none of the built-in tools speak MCP. Image input is not supported; only text parts are sent to the model. Codex (ChatGPT login) token refresh is manual: when the stored `access_token` in `~/.codex/auth.json` expires the provider returns 401 and you must re-run `codex login`. There is no built-in sandboxing or containerization; haxford runs with the permissions of the user and process that launched it.
