# Getting started

haxford is a terminal coding agent. It runs in one Bun process: no daemon, no language server, no background services. This page covers install, your first run, and what you'll see on screen.

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.
- An API key for at least one [provider](providers.md). Anthropic, OpenAI, or OpenRouter are the simplest.
- A terminal that handles ANSI 16-color output. No truecolor required — haxford borrows the terminal's own palette by design.

## Install

```bash
git clone <repo> && cd haxford-agent
bun install
bun run compile          # build the standalone ./haxford binary
```

Put the binary on your `PATH`:

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/haxford" ~/.local/bin/haxford
```

Or run from source without compiling:

```bash
bun run dev "<prompt>"
```

## Set a key

Pick one provider and export its key. See [Providers](providers.md) for the full list.

```bash
export ANTHROPIC_API_KEY="sk-..."        # or
export OPENROUTER_API_KEY="sk-or-..."    # or
export OPENAI_API_KEY="sk-..."
```

If you already keep keys in opencode's auth store (`~/.local/share/opencode/auth.json`), haxford reads them read-only — no second config needed.

## First run

```bash
haxford
```

The TUI opens for the current directory. You'll see:

- A **banner** with the wordmark, model, context window, and an affordance grid (`/help`, `tab`, `esc`, …).
- A **composer** at the bottom with a left rail colored by [permission mode](permissions.md): cyan for `build`, green for `auto`, magenta for `plan`.
- A **status bar** below the composer with the mode, model, and context percent.

Type a prompt and press **Enter**. The model streams its reply; tool calls run inline and their results fold into the conversation. Mutating actions (`write`, `edit`, `bash`) prompt a confirmation — press `a` to allow once, `l` to always allow for this session, or `d` to deny.

## Non-interactive mode

For scripts and pipes, print mode streams the model's text to stdout and tool status to stderr:

```bash
haxford -p "summarize the entrypoint" | tee summary.txt
```

Gated actions are denied in print mode (there is no UI to ask), so use `--mode auto` if the prompt needs to run tools:

```bash
haxford -p --mode auto "run bun test and report failures"
```

## Next

- [Providers](providers.md) — every built-in provider, the model spec format, and the codex login flow.
- [Permissions](permissions.md) — the three modes and how rules evaluate.
- [Commands](commands.md) — the eight slash commands and their keybindings.
