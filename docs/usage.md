# Using haxford

This page covers the CLI, interactive mode, context files, and non-interactive use. For what you see on screen during a first run, see [Getting started](getting-started.md).

## CLI reference

```
haxford [prompt...]          Start a session, optionally with an initial prompt
haxford -c                   Resume the most recent session for this directory
haxford -s <session-id>      Resume a specific session
haxford -p "<prompt>"        Print mode: non-interactive, streams to stdout

Options:
  -m, --model <spec>         provider/model (default: config or deepseek/deepseek-chat-v3.1)
      --mode <mode>          build | auto | plan  (default: build)
  -p, --print                Non-interactive print mode
  -c, --continue             Resume latest session
  -s, --session <id>         Resume session by id
  -h, --help                 Show help
```

Notes:

- Everything that is not a recognized flag becomes the initial prompt (words are joined with spaces). `haxford explain the build system` works without quotes.
- `--mode` accepts only `build`, `auto`, or `plan`; anything else silently keeps the default. See [Permissions](permissions.md) for what each mode allows.
- Interactive mode requires a TTY. Piping stdout without `-p` exits with code 2 and a hint to use print mode.

## Model resolution

The active model is resolved in this order, first match wins:

1. `-m` / `--model` on the command line (per-run override).
2. The project's saved model in `.haxford/state.json` — written when you pick a model in the `/model` picker, so your choice survives restarts.
3. The `model` field in global [config](configuration.md).
4. The built-in default (`openrouter/deepseek/deepseek-chat-v3.1`).

`HAXFORD_MODEL` sets the default in step 3 when config does not name one. See [Providers](providers.md) for the spec format and every built-in provider.

Print mode skips step 2 — scripts should pass `-m` explicitly when the project state must not influence them.

## Interactive mode

The TUI has three regions:

- **Transcript** — finalized messages render once; only the streaming tail re-renders.
- **Composer** — colored by permission mode: cyan for `build`, green for `auto`, magenta for `plan`. The left rail always shows which mode you are in.
- **Status bar** — mode, model, and context-window percentage.

Key behaviors:

- **Enter** sends. **Esc** aborts the running turn (or closes an overlay, or denies a pending permission request — see the precedence rules in [Commands](commands.md#keybindings)).
- **Tab** cycles permission mode when the composer is empty and idle.
- Prompt history is available with `↑`/`↓` in the composer.
- Slash commands autocomplete from `/` — see [Commands](commands.md).

The first prompt of a session also names it: the title is set from the first 60 characters unless you resumed a titled session.

## Context files

At startup haxford reads one context file, if present:

- `AGENTS.md` in the current working directory.

Its contents are appended to the system prompt verbatim as project instructions — coding conventions, test commands, things to avoid. There is no global context file and no parent-directory search: if you start haxford in `packages/app`, it reads `packages/app/AGENTS.md`, not the repo root's.

A minimal example:

```markdown
# Project instructions

- Run `bun run typecheck` after code changes.
- Never edit src/generated/**.
- Keep answers short; show diffs instead of full files.
```

Changes to `AGENTS.md` apply to the next process start, not the running session.

## Print mode

For scripts and pipes:

```bash
haxford -p "summarize the entrypoint" | tee summary.txt
cat error.log | haxford -p "what failed here?"
haxford -p --mode auto "run bun test and report failures"
```

Behavior:

- Assistant text streams to **stdout**; tool status lines (`[tool:bash] completed`) and notices/errors go to **stderr**.
- Gated actions are denied — there is no UI to ask. Explicit `allow` rules still run, so you can pre-approve specific commands via [config](configuration.md); or use `--mode auto` to allow everything not explicitly denied.
- Exit code is `0` normally, `1` when the loop ended with an error, `2` for usage errors (no prompt, no TTY).
- A session file is written like any other run, so `haxford -c` afterwards picks up where the script left off.

## Common tasks

### Pick a model

```bash
haxford -m anthropic/claude-sonnet-5
```

or press `/model` inside the TUI to browse the curated lists plus the live OpenRouter catalog with pricing. Providers without credentials are greyed out; `/connect` fixes that without leaving the picker flow — see [Providers](providers.md#connect).

### Approve fewer prompts

Answer `l` (always allow) at a permission prompt — the derived rule persists to `.haxford/settings.local.json`. For wholesale trust, configure [`permission.trust`](permissions.md#scoped-trust) or run `--mode auto`.

### Work read-only

`haxford --mode plan` denies all writes and restricts bash to a [read-only allowlist](permissions.md#read-only-bash-allowlist). Subagents inherit the mode.

### Continue later

Sessions are saved automatically — see [Sessions](sessions.md) for resume, fork, and compaction.

## Next steps

- [Tools](tools.md) — what each tool can do, its caps, and defaults.
- [Permissions](permissions.md) — modes, rules, and trust scopes.
- [Configuration](configuration.md) — the full config schema.
- [Environment variables](environment-variables.md) — everything haxford reads from the environment.
