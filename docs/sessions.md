# Sessions

haxford persists every session as append-only JSONL under a per-project directory. Sessions resume and fork without rewriting history — a later line with the same message id supersedes the earlier one on load.

## Storage layout

The data root resolves in this order:

1. `$HAXFORD_DATA_DIR`
2. `$XDG_DATA_HOME/haxford`
3. `~/.local/share/haxford`

Under it:

```
<data>/projects/<base64url(cwd)>/sessions/<session-id>.jsonl
<data>/projects/<base64url(cwd)>/sessions/<session-id>.meta.json
```

The `base64url(cwd)` slug makes sessions per-project — `/sessions` only shows sessions from the current working directory. Each session has:

- `<id>.jsonl` — the transcript. One JSON line per message snapshot; multiple snapshots of the same message id may appear (the loop appends a new line as the assistant message grows), and the last one wins on load.
- `<id>.meta.json` — `{id, title, directory, time:{created,updated}}`.

A per-file promise queue guarantees append ordering across concurrent writes. `loadHistory` replays the transcript, deduplicates by message id, keeps the last-written version of each, and preserves first-appearance order. Corrupt lines are skipped.

## Resume

Three ways to open an existing session:

| Method | What it does |
|---|---|
| `haxford -c` / `--continue` | Resume the most recent session for this directory. |
| `haxford -s <id>` / `--session <id>` | Resume a specific session by id. |
| `/sessions` (TUI) | Open a picker listing prior sessions for this project, sorted by `time.updated` descending. |

If `-c` finds no session, or `-s <id>` does not exist, haxford starts a fresh session.

## Fork

`forkSession` copies a session's transcript and meta under a new uuid, rewriting the `sessionID` on every message and cloning every part. The forked session is titled `"<original> (fork)"`. The fork is a full independent session — it can be resumed and extended without affecting the original.

Fork is a programmatic API in `src/session/store.ts` today; there is no `/fork` slash command yet. A forked session's read/todo tracking is fresh (the fork gets a new session id, so in-process tracking state does not leak across).

## Compaction

When the conversation approaches the context window, haxford summarizes everything older than the tail and keeps `[summary, …tail]`. The summary is a synthetic user message whose text starts with `[compacted summary of earlier conversation]`.

### Auto-compaction

Before every turn, the loop checks context pressure (the latest real `usage.input` from history, falling back to a chars÷4 estimate). When `pressure > limit * autoCompactAt` **and** the conversation is longer than the tail (default 2 messages), it:

1. Summarizes the conversation with the active model.
2. Replaces the working conversation with `[summary, ...tail(2), finalUserMessage]`.
3. Emits the summary as a `message.updated` event so the host persists it. The summary has a deterministic id (`compaction-<sessionID>`) so a later compaction replaces it rather than stacking.

`limit` comes from the static context table in `src/agent/context.ts`. `autoCompactAt` defaults to `0.9` and is configurable. Failure is never fatal — if the summarization call fails, the run continues with the un-compacted history.

### Manual compaction

`/compact` runs `compactConversation` on the current history, emits the summary, and sets `history = [summary, ...history.slice(-2)]`. The TUI store is reset to the new history. Repeated `/compact` does not stack summaries — each one summarizes the current (already-compacted) history.

## Tools, retry, and the loop

The agent loop is one `streamText` call per turn. After a turn whose steps included tool calls, results are appended and another turn runs. The loop ends on `end_turn`, `aborted` (user Esc), `max_turns`, `permission_denied`, or `error`.

Retry is classifier-driven (not the AI SDK's own `maxRetries`, which is set to 0): transient failures (429 without a quota marker, 5xx, network resets, timeouts) retry with exponential backoff (2s → 4s → 8s, capped at 60s, ±25% jitter). Quota/billing errors (`insufficient_quota`, `payment required`, `out of credit`) fail fast — they cannot succeed until a human tops up the account. A server `Retry-After` header wins outright. Retry only happens before any output has been emitted; once the user has seen a token, the turn is not retried.

## Next

- [Architecture](architecture.md) — the loop, events, and store in one diagram.
- [Configuration](configuration.md) — `autoCompactAt` and `maxTurns`.
