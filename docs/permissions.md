# Permissions

Every tool action is gated by a rule engine. The engine decides `allow` (run without asking), `ask` (prompt the user), or `deny` (refuse outright). Three modes control how aggressively the agent may act.

## Modes

| Mode | Behavior | When to use |
|---|---|---|
| `build` (default) | Evaluate rules; anything landing on `ask` prompts the user. Read-only bash chains with no matching rule also run without a prompt. | Day-to-day work where you want to approve mutations. |
| `auto` | Allow everything except what a rule explicitly `deny`s. No prompts. Narrowed by [scoped trust](#scoped-trust) when configured. | Trusted repetitive work; CI; `bun test` loops. |
| `plan` | Read-only. `write` and `edit` are denied outright without prompting. `bash` is allowed only for commands on the [read-only allowlist](#read-only-bash-allowlist). `task` subagents inherit plan mode. | Exploring an unfamiliar codebase; research; review. |

Switch modes with `--mode build|auto|plan` on the CLI, `/mode [build|auto|plan]` in the TUI, or `tab` in an empty idle composer (cycles build → auto → plan → build).

In print mode (`-p`), there is no UI to ask — gated actions are denied unless the mode allows them. Use `--mode auto` if the prompt must run tools.

## Scoped trust

Auto mode's blanket allow assumes you meant the whole workspace. `permission.trust` narrows it to a scope you name:

```json
{
  "permission": {
    "edit": { "src/generated/**": "deny" },
    "trust": {
      "paths": ["src/**", "docs/*.md"],
      "commands": ["bun test", "git status"]
    }
  }
}
```

In auto mode with a trust block:

- An action inside the scope is allowed with no prompt. `paths` are the same globs rule patterns use, matched against the tool's path subject (relative patterns also match paths inside the project root; a trailing `/` covers everything beneath). `commands` are prefixes, ending on a word boundary — `git status` covers `git status --short` but not `gitstatus`; a prefix containing `*` is matched as a glob. Every command in a chain must be trusted, so trusting `git status` does not vouch for `git status && rm -rf /`.
- An action **outside** the scope escalates to `ask` instead of being allowed. Explicit `allow` rules and the read-only tool defaults (`read`, `glob`, `grep`, `todoread`, `todowrite`) still allow without prompting.
- An explicit `deny` always wins, inside the scope or out.

`trust` is a reserved key under `permission`, not a tool name; it never participates in rule matching. Blocks from the global, project, and project-local layers are additive. With no `trust` block — or one that names no paths and no commands — auto mode behaves exactly as it always has. Trust has no effect in `build` or `plan` mode.

## Rules

Rules live under `permission` in [config](configuration.md). A tool maps to either a blanket action or a pattern record:

```json
{
  "permission": {
    "read": "allow",
    "write": "ask",
    "bash": {
      "git status": "allow",
      "git diff *": "allow",
      "rm *": "deny",
      "*": "ask"
    }
  }
}
```

### Pattern matching

- The pattern is matched against a **tool-specific subject**: the command string for `bash`, the file path for `read`/`write`/`edit`, ignored for tools with no subject.
- `*` matches within one path segment (no `/`) for path subjects; for `bash`, `*` matches anything (a shell command has no path structure, so `rm *` must match `rm -rf /`).
- `**` crosses separators; a trailing `**/` also matches zero segments so `**/*.ts` matches a top-level `a.ts`.
- A lone `*` is the tool-wide default — it matches every subject including paths containing `/`.
- **Longest matching pattern wins.** Equal-length conflicting patterns are ambiguous and fall back to the tool default.

### Tool defaults

When no rule matches, the tool default applies:

| Tool | Default |
|---|---|
| `read`, `glob`, `grep`, `todoread`, `todowrite` | `allow` |
| `write`, `edit`, `bash`, `task` | `ask` |

## Compound bash commands

A `bash` subject may hold a chain like `git status && rm -rf /`. haxford splits it on every command boundary (`&&`, `||`, `;`, `|`, `|&`, `&`, newlines, and the grouping/substitution forms `( ) { }` `$( )`), respecting quotes. **Every part must be permitted; the strictest verdict wins.** A rule written for the first command never vouches for the second.

Wrapper commands — `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `noglob` — are stripped along with their arguments before matching, so `timeout 30 npm test` is judged as `npm test`. Leading `VAR=value` assignments are stripped too. Environment runners (`npx`, `docker exec`, `mise exec`, `devbox run`) are **not** stripped — stripping them would let `Bash(devbox run *)` stand in for `devbox run rm -rf .`.

## Always-allow persistence

When you answer `always` (the `l` key) to a permission prompt, haxford:

1. Remembers the decision for the rest of the process, keyed by `tool + matched pattern` (or `tool` alone for a blanket decision). Later matching requests skip the prompt.
2. Writes the rule to `./.haxford/settings.local.json` in the project directory, so it **survives a restart**. This file is machine-local — add it to `.gitignore`; do not commit it.

The pattern written is derived from the approved command, not the literal invocation: it keeps the leading one or two stable words (command + subcommand) and wildcards the arguments. `git commit -m "wip"` becomes `git commit *`; `ls -la` becomes `ls *`. A command with no stable leading word (`./scripts/deploy.sh`) yields the exact string, because there is no prefix that could be widened without covering scripts you never approved. At most five patterns are written per approval (one per command in a chain).

Denials are **never** remembered — you are asked again next time.

## Read-only bash allowlist

In `plan` mode, and as the build-mode default for unmatched `bash`, haxford decides whether a command "only reads" using an **allowlist** — it answers "no" to anything it does not positively recognise. This is deliberate: a false positive breaks plan mode's one promise.

Allowed unconditionally (read-only):

```
basename cat cksum column comm cut date df diff dirname du fd fgrep file
grep egrep head hostname jq less ls md5sum nl printenv pwd readlink realpath
rg sha1sum sha256sum shasum sort stat tail tr tree type uname uniq wc which whoami yq
```

Special cases:

- **`git`** — only these subcommands: `blame, cat-file, describe, diff, log, ls-files, ls-tree, name-rev, reflog, rev-parse, shortlog, show, status`.
- **`find`** — allowed unless it has any of `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fls`, `-fprint`, `-fprint0`, `-fprintf`.
- **`sed`** — allowed unless it has `-i` / `--in-place`.

Anything containing shell-control characters (`; & | \` $ ( ) { } < > newline return \ !`) is **never** read-only, however safe the first word looks — `ls; rm -rf /` starts with `ls`.

## Next

- [Commands](commands.md) — the `/mode` command and its keybinding.
- [Configuration](configuration.md) — where `permission` rules live.
