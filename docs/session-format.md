# Session format

haxford persists sessions as append-only JSONL under a per-project directory. This page specifies the on-disk format; [Sessions](sessions.md) covers resume, fork, and compaction behavior.

## File layout

```
<data root>/projects/<base64url(cwd)>/sessions/<session-id>.jsonl         transcript
<data root>/projects/<base64url(cwd)>/sessions/<session-id>.meta.json     metadata
<data root>/projects/<base64url(cwd)>/sessions/<session-id>.todos.json    todo list
```

`<data root>` resolves to `$HAXFORD_DATA_DIR`, `$XDG_DATA_HOME/haxford`, or `~/.local/share/haxford`. The project slug is the base64url encoding of the resolved working directory, which keeps sessions per-project.

## Transcript entries

Each line of `<id>.jsonl` is one JSON object: a snapshot of a single message. The loop appends a new line as an assistant message grows, so multiple snapshots of the same id may exist.

**Load semantics** (`loadHistory`): replay all lines, deduplicate by `id`, keep the **last-written** version of each, preserve first-appearance order, skip lines that fail to parse. A corrupt line never blocks a resume.

A per-file promise queue serializes appends so concurrent writes cannot interleave out of order.

### Message

```json
{
  "id": "uuid",
  "sessionID": "uuid",
  "role": "user" | "assistant",
  "agent": "build",
  "model": "openrouter/deepseek/deepseek-chat-v3.1",
  "parts": [ ... ],
  "usage": { "input": 0, "output": 0 },
  "error": "optional error text",
  "time": { "created": 1755000000000, "completed": 1755000001234 }
}
```

| Field | Present | Notes |
|---|---|---|
| `id` | always | Message identity across snapshots; dedup key. |
| `sessionID` | always | Rewritten on fork. |
| `role` | always | `user` or `assistant`. |
| `agent` | assistant | Which agent produced it (`build`, or a subagent name). |
| `model` | assistant | The `"provider/model"` spec that generated it. |
| `parts` | always | Ordered content parts — see below. |
| `usage` | assistant | Token counts when known: `input`, `output`, optional `reasoning`. Drives auto-compaction. |
| `error` | rare | Set when the turn failed. |
| `time.created` | always | Epoch milliseconds. |
| `time.completed` | finished turns | |

### Parts

| Type | Shape | Notes |
|---|---|---|
| `text` | `{id, type, text}` | Prompt or reply text. |
| `image` | `{id, type, mime, data, source?}` | Base64 image contract; reserved for future use — haxford sends text parts only today. |
| `reasoning` | `{id, type, text}` | Reasoning summaries from thinking models. |
| `tool` | `{id, type, tool, callID, state}` | One per tool invocation. |

Tool part `state` is a small state machine:

| Status | Extra fields |
|---|---|
| `pending` | — |
| `running` | `input`, `time.start` |
| `completed` | `input`, `output` (text returned to the model), `title` (UI label), optional `metadata`, `time.start/end` |
| `error` | `input`, `error`, `time.start/end` |

### Compaction summaries

A summary is stored as a synthetic **user** message whose first text part begins with `[compacted summary of earlier conversation]`. Its id is deterministic — `compaction-<sessionID>` — so a later compaction supersedes the previous summary line instead of stacking another.

## Metadata file

`<id>.meta.json` is rewritten in place:

```json
{
  "id": "uuid",
  "title": "explain src/index.ts",
  "directory": "/home/you/project",
  "time": { "created": 1755000000000, "updated": 1755000300000 }
}
```

The title starts as `"Untitled session"` and becomes the first 60 characters of the session's first prompt. `/sessions` sorts by `time.updated`. A missing or corrupt meta file degrades gracefully — the transcript still loads; only picker metadata is lost.

## Todos file

`<id>.todos.json` holds `{ "todos": [{ "id", "content", "status" }] }` with status `pending`, `in_progress`, or `completed`. Written by [`todowrite`](tools.md#todowrite--todoread), loaded lazily on resume, absent for fresh sessions.

## Forking

`forkSession` copies every transcript line and the meta under a new uuid, rewriting `sessionID` on each message and cloning each part. The copy is titled `"<original> (fork)"`; its todo tracking starts fresh. The original is untouched.
