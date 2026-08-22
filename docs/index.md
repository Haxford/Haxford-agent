# haxford docs

haxford is a single-process terminal AI coding agent. It assembles a system prompt with tool schemas, streams model output, executes tool calls in one process, and feeds results back until the model stops calling tools. Sessions persist as append-only JSONL.

## Feature map

| Capability | Status | Where to read more |
|---|---|---|
| Interactive TUI | Yes — Ink/React, 16-color palette, left-rail grouping, `<Static>` transcript | [Getting started](getting-started.md) |
| Print mode (`-p`) | Yes — non-interactive, streams to stdout | [Getting started](getting-started.md#non-interactive-mode) |
| Providers | 8 built-in (Anthropic, OpenAI, OpenRouter, Ollama, z-ai, Moonshot, opencode zen, codex) + custom gateways | [Providers](providers.md) |
| Live model catalog | OpenRouter catalog with pricing, cached 1h | [Providers](providers.md#model-picker) |
| Permission modes | `build`, `auto`, `plan` — rule engine + always-allow persistence | [Permissions](permissions.md) |
| Slash commands | 8 built-in with autocomplete | [Commands](commands.md) |
| Sessions | JSONL append-only, resume, fork, compaction | [Sessions](sessions.md) |
| Subagents | `task` tool spawns a nested loop, inherits mode, hard 30-turn budget | [Architecture](architecture.md) |
| Retry | Classifier-driven, exponential backoff, quota errors fail fast | [Sessions → retry](sessions.md#tools-retry-and-the-loop) |
| Image input | No — text parts only | — |
| MCP / plugins | No — not yet | — |

## Where to start

- New to haxford? [Getting started](getting-started.md).
- Setting up a provider key? [Providers](providers.md).
- Want to approve fewer prompts? [Permissions](permissions.md) — `auto` mode and always-allow.
- Configuring defaults? [Configuration](configuration.md).
- Contributing? [Architecture](architecture.md) and [`AGENTS.md`](../AGENTS.md).
