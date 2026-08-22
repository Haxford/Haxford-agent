# haxford documentation

haxford is a single-process terminal AI coding agent. It assembles a system prompt with tool schemas, streams model output, executes tool calls in one process, and feeds results back until the model stops calling tools. Sessions persist as append-only JSONL so they resume and fork without rewrite.

## Start here

- [Getting started](getting-started.md) - install, authenticate, and run a first session.
- [Using haxford](usage.md) - CLI reference, interactive mode, context files, print mode.
- [Providers](providers.md) - all eight providers, auth precedence, `/connect`, model specs.
- [Tools](tools.md) - the ten built-in tools, their caps and defaults.
- [Permissions](permissions.md) - modes, rule syntax, scoped trust, always-allow persistence.
- [Commands](commands.md) - slash commands, autocomplete, keybindings.
- [Security](security.md) - trust model, credential handling, vulnerability reporting.

## Customization

- [Extending](extending.md) - skills, TypeScript extensions (commands, tools, hooks), and TUI themes.
- [Configuration](configuration.md) - config files, merge rules, full schema.
- [Environment variables](environment-variables.md) - every variable haxford reads.
- [Sessions](sessions.md) - storage layout, resume, fork, compaction.

## Reference

- [Session format](session-format.md) - JSONL transcript schema and entry types.
- [Architecture](architecture.md) - loop → events → store, frozen contracts, contributing.
- [`AGENTS.md`](../AGENTS.md) - the contributor convention contract.

## Feature map

| Capability | Status | Where to read more |
|---|---|---|
| Interactive TUI | Yes — Ink/React, 16-color palette, left-rail grouping, `<Static>` transcript | [Getting started](getting-started.md) |
| Print mode (`-p`) | Yes — non-interactive, streams to stdout | [Usage → print mode](usage.md#print-mode) |
| Providers | 8 built-in (Anthropic, OpenAI, OpenRouter, Ollama, z.ai, Moonshot, opencode zen, codex) + custom gateways | [Providers](providers.md) |
| Live model catalog | OpenRouter catalog with pricing, cached 1h | [Providers → model picker](providers.md#model-picker) |
| Permission modes | `build`, `auto`, `plan` — rule engine + scoped trust + always-allow persistence | [Permissions](permissions.md) |
| Tools | Ten built-in: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todowrite`, `todoread`, `task`, `webfetch` — extensions can add more | [Tools](tools.md) |
| Slash commands | 10 built-in with autocomplete; extensions register more | [Commands](commands.md) |
| Skills | `SKILL.md` folders indexed into the prompt, body read on demand | [Extending → skills](extending.md#1-skills) |
| Themes | JSON colour-token files, 16 ANSI colors, `HAXFORD_THEME` or config | [Extending → themes](extending.md#3-themes) |
| Sessions | JSONL append-only, resume, fork, compaction | [Sessions](sessions.md) · [Session format](session-format.md) |
| Subagents | `task` tool spawns a nested loop, inherits mode, cannot prompt, hard 30-turn budget | [Tools → task](tools.md#task) |
| Retry | Classifier-driven, exponential backoff, quota errors fail fast | [Sessions → retry](sessions.md#tools-retry-and-the-loop) |
| Image input | No — text parts only (the message contract reserves an image part) | [Session format](session-format.md#parts) |
| MCP | No — not yet | — |

## Where to start

- New to haxford? [Getting started](getting-started.md).
- Setting up a provider key? [Providers](providers.md).
- Want to approve fewer prompts? [Permissions](permissions.md) — `auto` mode and scoped trust.
- Configuring defaults? [Configuration](configuration.md).
- Contributing? [Architecture](architecture.md) and [`AGENTS.md`](../AGENTS.md).
