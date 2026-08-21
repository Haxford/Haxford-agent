# haxford

A single-process terminal AI agent harness, written in TypeScript on Bun with
an Ink (React) TUI. It streams model output, runs tools (read, write, edit,
bash, glob, grep, todo, task), and gates mutating actions behind a permission
engine — all in one process, with sessions persisted as append-only JSONL so
they can be resumed and forked. It is inspired by opencode and Claude Code.

## Install

```bash
bun install              # dependencies
bun run dev "<prompt>"  # run the CLI directly
bun run compile          # build a standalone ./haxford binary
```

## Quickstart

Set a key for one provider (Anthropic shown):

```bash
export ANTHROPIC_API_KEY="sk-..."
bun run dev "explain the entrypoint"
```

A full-screen TUI opens: type a prompt and press Enter. The model streams its
reply; tools run inline and their results fold into the conversation. Mutating
actions (write/edit/bash) prompt a confirmation dialog — press `a` to allow,
`l` to always allow this session, or `d` to deny.

For non-interactive use:

```bash
bun run dev -p "list the tsconfig settings"   # streams to stdout, exits
```

## CLI flags

Run `haxford -h` for the canonical list.

| Flag | Description |
|---|---|
| `haxford [prompt...]` | Start a session, optionally with an initial prompt |
| `-c`, `--continue` | Resume the most recent session for this directory |
| `-s`, `--session <id>` | Resume a specific session by id |
| `-p`, `--print` | Non-interactive print mode (streams to stdout) |
| `-m`, `--model <spec>` | `provider/model` override |
| `--mode <mode>` | `build` \| `auto` \| `plan` (default `build`) |
| `-h`, `--help` | Show help |

## Configuration

haxford loads two JSON config files and deep-merges them (project wins on
scalar conflicts):

- Global: `~/.config/haxford/haxford.json` (or `$XDG_CONFIG_HOME/haxford/...`)
- Project: `./haxford.json` in the working directory

An `AGENTS.md` in the project root is read verbatim and appended to the system
prompt as project instructions.

```json
{
  "model": "anthropic/claude-sonnet-5",
  "providers": {
    "anthropic": { "apiKey": "sk-..." },
    "openrouter": {
      "apiKey": "sk-or-...",
      "baseURL": "https://openrouter.ai/api/v1",
      "models": ["anthropic/claude-sonnet-4", "openai/gpt-5"]
    }
  },
  "permission": {
    "bash": { "ls *": "allow", "rm *": "deny", "*": "ask" },
    "write": "ask",
    "read": "allow"
  },
  "maxTurns": 100,
  "autoCompactAt": 0.9
}
```

### Fields

| Field | Description |
|---|---|
| `model` | Default `"provider/model"` spec, e.g. `anthropic/claude-sonnet-5`. |
| `providers` | Per-provider `{ apiKey, baseURL, models }`. `apiKey` overrides the env var; `baseURL` proxies/gateways; `models` adds entries to the picker. |
| `permission` | Rule set (see [Permission](#permission)). |
| `maxTurns` | Max loop turns per prompt before stopping. Default `100`. |
| `autoCompactAt` | Auto-compact when context usage exceeds this fraction (0–1). Default `0.9`. |

## Providers

Specs are `"provider/model"`. Model ids may contain slashes (e.g.
`openrouter/anthropic/claude-sonnet-4`), so the spec splits on the **first**
slash. `HAXFORD_MODEL` overrides the default spec.

| Provider | Env key | Default base URL | Notes |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | — | Anthropic Messages API. |
| `openai` | `OPENAI_API_KEY` | — | OpenAI Responses API. |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | OpenAI-compatible chat. |
| `ollama` | `OLLAMA_API_KEY`, `OLLAMA_HOST` | `http://localhost:11434/v1` | Local-first: no key needed against a local daemon. When `OLLAMA_API_KEY` is set and no local host is pinned, targets `https://ollama.com/v1` instead. |
| `zai` | `Z_AI_API_KEY` | `https://api.z.ai/api/paas/v4` | GLM models. |
| `moonshot` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | Kimi models. `kimi` is an alias. |
| `opencode` | `OPENCODE_API_KEY` | `https://opencode.ai/zen/v1` | OpenAI-compatible chat. |
| `codex` | — | `https://chatgpt.com/backend-api/codex` | Reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) written by the `codex` CLI after `codex login`. **Token refresh is out of scope** — when the stored `access_token` expires the provider returns 401 and you must re-run `codex login`. |

## Permission

Every tool action is gated by a rule engine with three modes (the `--mode`
flag):

- **build** — evaluate rules; anything landing on `ask` prompts the user.
  `always` answers are remembered per tool + matched pattern for the session;
  denials are never remembered.
- **auto** — allow everything except what a rule explicitly denies. No prompt.
- **plan** — read-only. Mutating tools (`write`/`edit`/`bash`/`task`) are
  denied outright without prompting; read tools are allowed.

### Rules

A tool maps to either a blanket action (`"allow"` / `"ask"` / `"deny"`) or to
a pattern record. Patterns are glob-style, matched against a tool-specific
subject: the command string for `bash`, the file path for `read`/`write`/
`edit`, and ignored for tools with no subject. **Longest matching pattern
wins**; a bare action beats patterns.

- `*` matches one path segment (no slashes); `**` crosses separators.
  `**/*.ts` matches a top-level `a.ts`.
- For `bash`, `*` and `**` both match anything (a shell command has no path
  structure), so `rm *` matches `rm -rf /`.
- A lone `*` is the tool-wide default.

```json
{
  "permission": {
    "read": "allow",
    "write": "ask",
    "bash": {
      "ls *": "allow",
      "git status": "allow",
      "rm *": "deny",
      "*": "ask"
    }
  }
}
```

Tool defaults (no rule): `read`, `glob`, `grep`, `todoread`, `todowrite` →
`allow`; `write`, `edit`, `bash` → `ask`.

## TUI

### Keys

| Key | Action |
|---|---|
| Enter | Send the prompt (or the current slash command) |
| ↑ / ↓ | Navigate prompt history (in the composer) or list items (pickers) |
| Esc | Abort the running turn; close any open overlay; deny a pending permission request |
| `a` / `l` / `d` | While a permission dialog is open: allow once / always (session) / deny |

### Slash commands

| Command | Description |
|---|---|
| `/exit` | Quit haxford |
| `/clear` | Start a fresh session |
| `/sessions` | Resume a previous session (picker) |
| `/model` | Switch the active model (picker) |
| `/help` | Show in-app help |

## Sessions

Sessions persist as append-only JSONL under the data root (one transcript
line per message snapshot; a later line with the same message id supersedes
earlier ones on load). The data root resolves as:

1. `$HAXFORD_DATA_DIR`
2. `$XDG_DATA_HOME/haxford`
3. `~/.local/share/haxford`

Layout: `<data>/projects/<base64url(projectDir)>/sessions/<id>.jsonl` plus a
sibling `<id>.meta.json`. Sessions are per-project (keyed by the working
directory), so resuming only shows sessions from the current project.

Resume with `-c` (latest) or `-s <id>` (specific). `/sessions` opens the
in-app picker.

## Development

### Layout

| Path | Owner | Contents |
|---|---|---|
| `src/types/` | coordinator (FROZEN) | Shared contracts — import, never modify. |
| `src/agent/` | agent | The agentic loop, system prompt assembly. |
| `src/providers/` | providers | AI SDK model/provider resolution. |
| `src/tools/` | tools | Tool implementations (read/write/edit/bash/glob/grep/todo/task). |
| `src/permission/` | permission | Permission rule engine. |
| `src/session/` | session | JSONL session persistence, resume, fork. |
| `src/tui/` | tui | Ink TUI: transcript, composer, dialogs, slash commands. |
| `tests/` | all | Test suites (`bun test`). |
| `src/index.ts`, `src/config/` | coordinator | Entrypoint, wiring, config loading. |

### Commands

```bash
bun test            # run all tests
bun run typecheck   # tsc --noEmit; must be clean
bun run dev "<prompt>"   # run the CLI
bun run compile           # build a standalone binary
```

Strict TypeScript is enforced (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`).
Runtime is Bun — prefer `Bun.file`/`Bun.write`/`Bun.spawn` over Node
equivalents. See `AGENTS.md` for the full convention contract.
