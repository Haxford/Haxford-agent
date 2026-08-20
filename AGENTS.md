# AGENTS.md — haxford

A terminal AI agent harness with a TUI. Bun + TypeScript (strict), Vercel AI SDK for
providers, Ink for the TUI. Single process. This file is the shared convention contract —
follow it exactly.

## Commands

- `bun run dev "<prompt>"` — run the CLI
- `bun test` — run all tests
- `bun run typecheck` — must be clean before any task is considered done
- `bun run compile` — build standalone binary

## Layout & ownership (do not cross boundaries)

| Path | Owner | Contents |
|---|---|---|
| `src/types/` | coordinator (FROZEN) | Shared contracts. Import from here; never modify. |
| `src/agent/` | claude | The agentic loop, system prompt assembly |
| `src/providers/` | claude | AI SDK model/provider resolution |
| `src/tools/` | claude | Tool implementations (read/write/edit/bash/glob/grep/todo/task) |
| `src/permission/` | claude | Permission rule engine |
| `src/session/` | pi | JSONL session persistence, resume, fork |
| `src/tui/` | pi | Ink TUI: transcript, composer, dialogs, slash commands |
| `tests/` | pi | Test suites |
| `src/index.ts`, `src/config/` | coordinator | Entrypoint, wiring, config loading |

## Rules

1. **Contracts are frozen.** Everything in `src/types/` is fixed. If a contract is
   insufficient, report it — do not edit it.
2. **No new dependencies** without listing them in your final report with justification.
3. Strict TS must pass: `bun run typecheck`. Use `import type` for type-only imports
   (`verbatimModuleSyntax` is on). Use `.ts` extensions in relative imports
   (`allowImportingTsExtensions` is on). `noUncheckedIndexedAccess` is on — handle
   `undefined` from index access.
4. Runtime is **Bun**: use `Bun.file`, `Bun.write`, `Bun.spawn`, `bun:sqlite` etc.
   over node equivalents where available.
5. **Errors returned to the model are strings, not throws.** A tool that fails returns a
   `ToolResult` (or a tool state of `error`) describing the failure. Only programmer
   errors throw.
6. Tool `output` enters the model's context — truncate long output (files, bash) and say
   so in the output.
7. Small modules, async/await, no classes unless state genuinely demands it.
8. Tests use `bun test` (import from `bun:test`).
9. Markdown files like this one may exist per-directory; follow the nearest one.

## Architecture in one paragraph

A single-process agent loop: assemble system prompt + history + tool schemas → stream
from the model → execute tool calls (each gated by the permission engine) → feed results
back → repeat until the model stops calling tools. All visible state changes are emitted
as `AgentEvent`s; the Ink TUI reduces them into render state. Sessions persist as
append-only JSONL so they can be resumed and forked.
