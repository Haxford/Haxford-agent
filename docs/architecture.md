# Architecture

haxford is a single-process agent loop: assemble system prompt + history + tool schemas → stream from the model → execute tool calls (each gated by the permission engine) → feed results back → repeat until the model stops calling tools. All visible state changes flow through one event stream; the Ink TUI reduces them into render state.

## Loop → events → store

```
┌─────────────────────────────────────────────────────────────┐
│  src/index.ts (host)                                        │
│    parseArgs → loadConfig → openSession                     │
│    ┌──────────────────────────────────────────────────┐     │
│    │ runAgentLoop (src/agent/loop.ts)                 │     │
│    │   assemble system prompt + history + tools      │     │
│    │   streamText ──▶ one turn                        │     │
│    │     │                                            │     │
│    │     ▼  yields AgentEvent                         │     │
│    │   tool calls? ── askPermission ──▶ run tool      │     │
│    │     │                  (src/permission/engine)    │     │
│    │     ▼  append results to conversation            │     │
│    │   more turns? ──yes──▶ streamText again          │     │
│    │   no  ──▶ loop.end(reason)                       │     │
│    └──────────────────────────────────────────────────┘     │
│           │ AgentEvent stream                               │
│           ▼                                                 │
│    createTuiStore.dispatch(event)   (src/tui/store.ts)      │
│           │ useSyncExternalStore                            │
│           ▼                                                 │
│    HaxfordApp (src/tui/app.tsx)                             │
│      <Static> finalized · <Transcript> live tail            │
│      <Composer> · <StatusBar>                               │
└─────────────────────────────────────────────────────────────┘
```

Key properties:

- **One process.** Provider calls, tool execution, permission checks, and the TUI all run in one Bun process. There is no server, no daemon, no language server.
- **Events are the only mutation path.** The loop emits `AgentEvent`s (`message.updated`, `part.updated`, `part.delta`, `permission.request`, `usage`, `turn.start`/`end`, `loop.end`, `error`, `notice`). The TUI store reduces them; Ink diffs and renders. Print mode (`-p`) consumes the same stream and writes to stdout/stderr instead.
- **`<Static>` for finalized transcript.** Settled messages render inside Ink's `<Static>` so streaming re-renders only the in-flight tail, not the whole history. `splitTranscript` derives the finalized prefix from the message list.
- **JSONL append-only.** Each message snapshot is one line; a later line with the same id supersedes earlier ones on load. [Sessions](sessions.md) resume and fork without rewrite.

## Contracts are frozen

Everything in `src/types/` is fixed. These types define the boundary between the loop, the tools, and the TUI — changing them forces every consumer to change, so they are not edited in flight. If a contract is insufficient, report it; do not modify it. This is enforced by the [AGENTS.md](../AGENTS.md) rule 1.

The key contracts:

| Contract | What it pins |
|---|---|
| `types/message.ts` | `Message`, `Part` (text/reasoning/tool), `TokenUsage` |
| `types/tool.ts` | `Tool`, `ToolResult`, `ToolContext`, `PermissionRequest`/`Decision` |
| `types/events.ts` | `AgentEvent`, `LoopEndReason` |
| `types/config.ts` | `HaxfordConfig`, `PermissionRules`, `PermissionAction` |
| `types/session.ts` | `SessionInfo` |

## Permission gates every tool call

`createAskHandler` (in `src/permission/engine.ts`) evaluates the rule set + mode before any tool runs. In the TUI it bridges to the approval dialog via `ApprovalBridge`; in print mode it denies on `ask`. Subagents (the `task` tool) inherit the parent's mode and rules, with `onAsk: () => "deny"` so anything that would prompt the user is refused outright in a subagent.

## Tools return errors as results

A tool that fails returns a `ToolResult` describing the failure; only programmer errors throw. This keeps the loop running — the model sees the failure as tool output and can recover. Long output (files, bash) is truncated and says so in the result text.

## Source layout

| Path | Contents |
|---|---|
| `src/types/` | Shared contracts (FROZEN — import, never modify). |
| `src/agent/` | Agentic loop, system prompt, retry, compaction. |
| `src/providers/` | AI SDK model/provider resolution and auth. |
| `src/tools/` | Tool implementations: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todo` (read+write), `task` (subagent). |
| `src/permission/` | Permission rule engine and always-allow persistence. |
| `src/session/` | JSONL session persistence, resume, fork. |
| `src/tui/` | Ink TUI: transcript, composer, dialogs, slash commands, theme. |
| `src/index.ts`, `src/config/` | Entrypoint, CLI parsing, config loading. |
| `tests/` | Test suites (`bun test`). |

## Contributing

haxford follows [AGENTS.md](../AGENTS.md) as its convention contract. The short version:

- Strict TypeScript: `bun run typecheck` must be clean. Use `import type` for type-only imports, `.ts` extensions in relative imports, and handle `undefined` from index access (`noUncheckedIndexedAccess` is on).
- Runtime is Bun: prefer `Bun.file`, `Bun.write`, `Bun.spawn` over Node equivalents.
- Small modules, async/await, no classes unless state genuinely demands it.
- Tests use `bun test` (import from `bun:test`).

```bash
bun test            # run all tests
bun run typecheck   # tsc --noEmit; must be clean before any task
bun run dev "<prompt>"   # run the CLI from source
bun run compile           # build a standalone binary
```
