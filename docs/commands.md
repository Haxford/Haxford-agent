# Commands

haxford has ten built-in slash commands; extensions can register more (see [Extending](extending.md)). In the TUI, type `/` to open autocomplete; `↑`/`↓` moves the selection, `Enter` accepts, `Esc` dismisses.

## Slash command reference

| Command | Description | Takes an argument |
|---|---|---|
| `/help` | Show in-app command and keybinding help. | No — runs immediately on accept. |
| `/model` | Open the model picker (live catalog with pricing). | No. |
| `/connect` | Connect or re-key a provider without leaving the TUI. | No — runs immediately. |
| `/sessions` | Open the session picker for this project. | No — runs immediately. |
| `/compact` | Compact the conversation now. See [Sessions → compaction](sessions.md#compaction). | No — runs immediately. |
| `/init` | Analyze the codebase and create/improve `AGENTS.md`. | No (sends a canned prompt). |
| `/mode [build\|auto\|plan]` | Switch permission mode. With no arg, cycles build → auto → plan → build. | Yes — or omit to cycle. |
| `/clear` | Start a fresh session. | No — runs immediately. |
| `/reload` | Rescan skills, extensions, and themes. See [Extending](extending.md#4-reload). | No — runs immediately. |
| `/exit` | Quit haxford. | No — runs immediately. |

Commands that take no argument submit and run as soon as autocomplete lands on a single match. Commands that take an argument (`/mode`) complete the token and add a trailing space for you to type the value; `Enter` then submits.

Unknown commands (anything not in the table and not registered by an extension) open the help panel and emit a notice.

## Autocomplete

- Type `/` to open the popup. It lists every command whose name is a case-insensitive prefix of what you've typed.
- `↑` / `↓` moves the selection; the popup wraps.
- `Enter` accepts the selected completion into the composer. For no-argument commands you then press `Enter` again to submit — haxford never auto-runs from a partial prefix like `/e`.
- `Esc` dismisses the popup and leaves the typed text in place.

## Keybindings

| Key | Action |
|---|---|
| `Enter` | Send the prompt, or run the current slash command. |
| `Esc` | Abort the running turn; close any open overlay; deny a pending permission request. |
| `Tab` | Cycle permission mode — only when the composer is empty, idle, and no overlay is open. |
| `↑` / `↓` | Navigate prompt history in the composer, or a picker list when an overlay is open. |
| `a` / `l` / `d` | While a permission dialog is open: allow once / always (session) / deny. |
| `ctrl+o` | Expand or collapse tool output across the transcript. |
| `ctrl+c` | Interrupt the run; pressed twice in a row when idle, quit. |

`Esc` has a strict precedence: a pending permission dialog is modal and consumes `Esc` as a denial first. If no dialog is open and a turn is running, `Esc` aborts the turn. If no turn is running, `Esc` closes any open overlay (help, sessions picker, model picker).

`ctrl+c` outranks everything, including a pending permission dialog. When the composer is idle it arms an exit confirmation — the second press quits; any other key cancels it.

## Permission dialog

When a tool action lands on `ask` in `build` mode, a dialog renders inline above the composer with the tool name, subject, and a preview of the arguments. Press:

- `a` — allow this one request.
- `l` — always allow matching requests for this session (and persist to `.haxford/settings.local.json`).
- `d` — deny the request.
- `Esc` — deny.

See [Permissions](permissions.md) for the full rule engine and the always-allow persistence.

## Next

- [Usage](usage.md) - the CLI flags and interactive-mode behavior behind these commands.
- [Permissions](permissions.md) - the three modes and rule syntax.
- [Sessions](sessions.md) - `/sessions`, `/compact`, and `/clear` in detail.
