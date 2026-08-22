# Tools

haxford ships ten built-in tools. The model sees all of them on every turn; the [permission engine](permissions.md) decides which run without asking. Tools that fail return an error description as their result — the loop keeps going and the model can recover.

| Tool | What it does | Default verdict |
|---|---|---|
| `read` | Read a file | allow |
| `write` | Create or overwrite a file | ask |
| `edit` | Patch exact strings in a file | ask |
| `bash` | Run a shell command | ask |
| `glob` | Find files by pattern | allow |
| `grep` | Search file contents by regex | allow |
| `todowrite` / `todoread` | Track a task list for the session | allow |
| `task` | Spawn a subagent for a subtask | ask |
| `webfetch` | Fetch a URL and read its content | ask |

## read

Reads a file from disk, line-numbered in `cat -n` style so `edit` targets are unambiguous.

- Paths must be absolute.
- Returns up to 2000 lines from the top by default; page through larger files with `offset` (1-based) and `limit`.
- Lines longer than 2000 characters are truncated, with a note counting how many were.
- Binary files are refused.
- The agent must read a file before `edit`ing it or `write`ing over it — both refuse to touch content it has not seen this session.

## write

Creates a file or replaces one entirely.

- `content` is the complete file; there is no append or patch form.
- Overwriting requires a prior `read` in the same session.
- Missing parent directories are created automatically.

## edit

Replaces exact strings in a file.

- Preferred form is `edits[]`: several targeted replacements in one call. Each `oldString` is matched against the original file — overlapping or nested edits within one call are rejected; merge them instead.
- A flat single-edit form (`oldString`/`newString`/`replaceAll`) still works.
- `oldString` must match exactly and be unique; otherwise the edit is refused as ambiguous unless `replaceAll: true`.
- An empty `newString` deletes text. New files should use `write`.

## bash

Runs a shell command with output capture.

- Timeout: 120 s default, 600 s maximum. On timeout or abort, orphaned child processes are reaped so pipes close cleanly.
- Output is capped at the **last** 2000 lines / 50 000 characters — the tail of a failing build matters more than its head — and says so when truncated.
- The permission subject is the command string. Compound commands (`&&`, `||`, `;`, pipes, substitutions) are split and every part must be permitted — see [compound bash commands](permissions.md#compound-bash-commands).

## glob

Finds files by pattern (`src/**/*.ts`), optionally rooted at a directory. Returns up to 100 paths.

## grep

Searches file contents with a regular expression.

- Optional directory root (default: working directory) and an `include` glob filter such as `"*.ts"`.
- Returns up to 100 matches; matched-line text is truncated at 500 characters.
- Files over 2 MB are skipped. Backed by ripgrep where available, with a built-in fallback — truncation notes are engine-independent.

## todowrite / todoread

A structured task list the model maintains for multi-step work: `{id, content, status}` with status `pending`, `in_progress`, or `completed`. The list persists per session under the data root (`<sessions dir>/<session-id>.todos.json`) and reloads on resume. A forked session starts clean.

## task

Spawns a subagent: a nested agent loop with the same tools and system prompt, given one self-contained instruction.

- **Same permissions, no prompts.** The subagent inherits the parent's mode and rules, but anything that would prompt the user is denied outright — a background worker cannot block on input.
- Hard budget of 30 turns; if it hits the cap the report says it may be incomplete.
- Returns only the subagent's final report, truncated at 10 000 characters. Its intermediate tool calls never enter your transcript.

## webfetch

Fetches a URL and returns its content as text.

- **HTTPS only**, except `http://localhost` and loopback addresses — credentials in cleartext URLs will not be sent to remote hosts.
- HTML pages are stripped to a markdown-ish rendering (headings, links, lists, code blocks preserved); other content types pass through as-is.
- Caps: 20-second timeout, 1 MB response body decoded, 50 000 characters of output. Redirects are followed.
- A per-run cache means refetching the same URL within five minutes returns the cached text without a second request.
- Permission patterns match the **host** part of the URL, so `"webfetch": {"github.com": "allow"}` approves every fetch to that host.
- In `plan` mode webfetch counts as read-only and runs without prompting; in `build` mode the default is `ask`.

See [Security](security.md#untrusted-content) for what fetched pages mean for prompt injection.

## Adding tools

There is no plugin runtime yet — tools are compiled in. To add one, implement the `Tool` contract from `src/types/tool.ts` and register it in `allTools()` (`src/tools/index.ts`); see [Architecture](architecture.md).
