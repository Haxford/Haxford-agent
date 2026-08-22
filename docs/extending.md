# Extending haxford

haxford reads four directories under `~/.haxford`. Nothing here needs a build
step, a manifest, or a restart of anything but haxford itself.

| Layer | Lives in | What it is |
|---|---|---|
| **Agents** | `~/.haxford/agents/<name>.md` or `.haxford/agents/<name>.md` | Personas with system-prompt addendum and optional model/mode/tool overrides. |
| **Skills** | `~/.haxford/skills/<name>/SKILL.md` | Instructions the model pulls into context when relevant. |
| **Extensions** | `~/.haxford/extensions/*.ts` | Code: slash commands, tools, lifecycle hooks. |
| **Themes** | `~/.haxford/themes/<name>.json` | Colour tokens for the TUI. |

Run `/reload` after changing any of them.

---

## 1. Skills

A skill is a folder with a `SKILL.md`. Its frontmatter is indexed at startup and
listed in the system prompt; the body is *not* loaded until the model decides the
skill is relevant and reads the file with its `read` tool. That is the whole
point — a hundred skills cost a hundred lines of prompt, not a hundred documents.

```markdown
---
name: release
description: Cut a release — version bump, changelog, tag, GitHub release.
---

# Cutting a release

1. Bump `version` in package.json.
2. Update CHANGELOG.md with everything since the last tag.
3. `git tag -a v$VERSION` and push.
```

Rules:

- `description` must be a **single line**. It is what the model sees when
  deciding whether to open the file, so write it as a trigger condition, not a
  title: "Cut a release — version bump, changelog, tag" beats "Release process".
- `name` is optional and defaults to the directory name.
- Everything after the closing `---` is the body. Write it for a reader who has
  already decided to follow it.

---

## 2. Extensions

A file in `~/.haxford/extensions/` that default-exports a function. Bun runs
TypeScript directly, so `.ts` needs no compilation. Files load in **filename
order** — prefix with `10-`, `20-` if one must run before another.

```ts
export default function (haxford) {
  haxford.registerCommand("ping", "reply with pong", () => "pong")
}
```

Save that as `~/.haxford/extensions/ping.ts`, run `/reload`, and `/ping` works.

### The API

```ts
interface HaxfordExtensionAPI {
  registerCommand(name: string, description: string, handler: CommandHandler): void
  registerTool(tool: Tool): void
  onStart(fn: (ctx: { cwd: string; sessionID: string }) => void | Promise<void>): void
  onMessage(fn: (message: Message) => void | Promise<void>): void
  onToolCall(fn: (call: ToolCallInfo) => void | Promise<void>): void
}

type CommandHandler = (ctx: {
  args: string          // everything typed after the command name
  cwd: string
  sessionID?: string
}) => string | void | Promise<string | void>

interface ToolCallInfo {
  tool: string
  args: Record<string, unknown>
  sessionID: string
  agent: string
}
```

Returning a string from a command handler shows it to the user. Returning
nothing means the handler dealt with its own output.

### Hooks and when they fire

| Hook | Fires |
|---|---|
| `onStart` | Once per session, before the first turn runs. |
| `onMessage` | Once per completed message — your prompt, then each assistant turn. |
| `onToolCall` | Immediately before a tool executes, after the permission gate. |

Hooks fire in registration order (filename order across files, declaration
order within one). They are awaited, so an `async` hook delays what follows —
keep them quick. A hook that throws is caught, recorded, and skipped; the turn
carries on.

### Adding a tool

A tool is the same shape the built-ins use: an id, a description the model
reads, a zod schema, and an `execute` returning `{ title, output }`.

```ts
import { z } from "zod"

export default function (haxford) {
  haxford.registerTool({
    id: "wordcount",
    description:
      "Count words in a file. Use when the user asks how long a document is.",
    parameters: z.object({
      filePath: z.string().describe("Absolute path to the file"),
    }),
    async execute({ filePath }) {
      const text = await Bun.file(filePath).text()
      const words = text.split(/\s+/).filter(Boolean).length
      return { title: `${words} words`, output: `${filePath}: ${words} words` }
    },
  })
}
```

`output` goes into the model's context — truncate anything large and say that
you did. Return a description of the failure rather than throwing; the model
can act on a message and cannot act on a stack trace.

Rejected registrations (and why you would see one):

- A tool id that collides with a built-in or another extension. Built-ins win.
- A command name that collides with a built-in (`/help`, `/model`, `/connect`,
  `/sessions`, `/compact`, `/init`, `/mode`, `/clear`, `/exit`, `/reload`).
- `parameters` that is not a zod schema, or `execute` that is not a function.

None of these are fatal. The registration is dropped, the reason is recorded,
and everything else still loads.

---

## 3. Themes

A JSON file of colour tokens. Unknown tokens are ignored with a warning;
tokens you leave out keep their default, so a theme can be three lines.

```json
{
  "accent": "magenta",
  "success": "green",
  "user": "cyan",
  "rail": "gray"
}
```

Save as `~/.haxford/themes/violet.json`, then either:

- `HAXFORD_THEME=violet haxford` — one run, or
- `"theme": "violet"` in `~/.config/haxford/haxford.json` — every run.

The env var wins. Values are Ink colour names — the 16 ANSI colours
(`cyan`, `green`, `yellow`, `red`, `magenta`, `gray`, `black`, `white`, …).
Named colours are deliberate: they map to the palette *your terminal* is
configured with, so haxford looks right in any scheme instead of asserting
one. `""` means "inherit the terminal's own foreground".

Tokens: `accent`, `text`, `muted`, `dim`, `success`, `warning`, `error`,
`info`, `rail`, `railAccent`, `selectedBg`, `selectedFg`, `panelBg`,
`diffAdd`, `diffDel`, `diffCtx`, `codeSpan`, `user`, `toolIcon`.

---

## 4. /reload

`/reload` disposes every registered command, tool and hook, then rescans all
three directories. No restart, no lost session.

One limit worth knowing: reload re-evaluates each extension **entry file**, but
modules those files import keep the version first loaded. If you edit a shared
`./helper.ts`, restart haxford.

---

## 5. Named agents

Named agents customize the loop per-project. They live in `.haxford/agents/<name>.md` (project, takes precedence) or `~/.haxford/agents/<name>.md` (global). Each agent is a markdown file with frontmatter and a body.

```markdown
---
description: Code reviewer with strict standards
model: anthropic/claude-sonnet-5
mode: build
tools: [read, grep, bash]
---

# Code Reviewer

You are a strict code reviewer. Your job is to identify:
- Bugs and security issues
- Performance problems
- Style violations against the project's conventions

Be concise and direct.
```

Rules:

- `description` is a single line shown in the `/agent` picker.
- `model` (optional) overrides the default for this agent.
- `mode` (optional) sets the permission posture: `plan`, `build`, or `auto`.
- `tools` (optional) restricts which tools the agent can call; absent means all.
- Everything after the closing `---` is appended to the system prompt.

Switch agents with `--agent <name>` on the CLI or `/agent <name>` in the TUI.

---

## 6. Writing one from inside haxford

You can ask haxford to extend itself — it has this document and a `write` tool:

> read ~/.haxford/EXTENDING.md, then add a /standup command that summarises
> today's commits

It will read the doc, write the file into `~/.haxford/extensions/`, and tell
you to run `/reload`.
