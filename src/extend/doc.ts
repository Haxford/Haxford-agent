/**
 * `EXTENDING.md` — the single source of truth for the extension API.
 *
 * The same text is written to `~/.haxford/EXTENDING.md` (once, never
 * overwritten) and committed at `docs/extending.md`. A test asserts the two
 * are identical, so the in-repo copy cannot drift from what users are handed.
 *
 * It lives as a string rather than a file read at runtime because
 * `bun run compile` produces a single binary with no repo beside it.
 */

import { extendingDocPath } from "./paths.ts"

export const EXTENDING_MD = `# Extending haxford

haxford reads three directories under \`~/.haxford\`. Nothing here needs a build
step, a manifest, or a restart of anything but haxford itself.

| Layer | Lives in | What it is |
|---|---|---|
| **Skills** | \`~/.haxford/skills/<name>/SKILL.md\` | Instructions the model pulls into context when relevant. |
| **Extensions** | \`~/.haxford/extensions/*.ts\` | Code: slash commands, tools, lifecycle hooks. |
| **Themes** | \`~/.haxford/themes/<name>.json\` | Colour tokens for the TUI. |

Run \`/reload\` after changing any of them.

---

## 1. Skills

A skill is a folder with a \`SKILL.md\`. Its frontmatter is indexed at startup and
listed in the system prompt; the body is *not* loaded until the model decides the
skill is relevant and reads the file with its \`read\` tool. That is the whole
point — a hundred skills cost a hundred lines of prompt, not a hundred documents.

\`\`\`markdown
---
name: release
description: Cut a release — version bump, changelog, tag, GitHub release.
---

# Cutting a release

1. Bump \`version\` in package.json.
2. Update CHANGELOG.md with everything since the last tag.
3. \`git tag -a v$VERSION\` and push.
\`\`\`

Rules:

- \`description\` must be a **single line**. It is what the model sees when
  deciding whether to open the file, so write it as a trigger condition, not a
  title: "Cut a release — version bump, changelog, tag" beats "Release process".
- \`name\` is optional and defaults to the directory name.
- Everything after the closing \`---\` is the body. Write it for a reader who has
  already decided to follow it.

---

## 2. Extensions

A file in \`~/.haxford/extensions/\` that default-exports a function. Bun runs
TypeScript directly, so \`.ts\` needs no compilation. Files load in **filename
order** — prefix with \`10-\`, \`20-\` if one must run before another.

> **An extension is code you are choosing to run.** haxford imports every file
> in this directory at startup, in the same process, with your user's full
> privileges — your filesystem, your network, your environment. There is no
> sandbox and no permission prompt around an extension itself; the permission
> engine gates what the *model* asks for, not what your own extension code
> does. Treat adding one exactly as you would treat \`curl … | sh\`: read it
> first, and only install extensions you trust. A broken extension is
> contained (an import that throws, a hook that fails, or a bad registration
> is reported as a warning and skipped, and the session continues) — a
> *malicious* one is not.
>
> haxford never passes provider API keys to an extension: the API object below
> is the entire surface, and the credential env vars are stripped from child
> processes. An extension can still read your config files itself, which is
> the point of the paragraph above.

\`\`\`ts
export default function (haxford) {
  haxford.registerCommand("ping", "reply with pong", () => "pong")
}
\`\`\`

Save that as \`~/.haxford/extensions/ping.ts\`, run \`/reload\`, and \`/ping\` works.

### The API

\`\`\`ts
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
\`\`\`

Returning a string from a command handler shows it to the user. Returning
nothing means the handler dealt with its own output.

### Hooks and when they fire

| Hook | Fires |
|---|---|
| \`onStart\` | Once per session, before the first turn runs. |
| \`onMessage\` | Once per completed message — your prompt, then each assistant turn. |
| \`onToolCall\` | Immediately before a tool executes, after the permission gate. |

Hooks fire in registration order (filename order across files, declaration
order within one). They are awaited, so an \`async\` hook delays what follows —
keep them quick. A hook that throws is caught, recorded, and skipped; the turn
carries on.

### Adding a tool

A tool is the same shape the built-ins use: an id, a description the model
reads, a zod schema, and an \`execute\` returning \`{ title, output }\`.

\`\`\`ts
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
      const words = text.split(/\\s+/).filter(Boolean).length
      return { title: \`\${words} words\`, output: \`\${filePath}: \${words} words\` }
    },
  })
}
\`\`\`

\`output\` goes into the model's context — truncate anything large and say that
you did. Return a description of the failure rather than throwing; the model
can act on a message and cannot act on a stack trace.

Rejected registrations (and why you would see one):

- A tool id that collides with a built-in or another extension. Built-ins win.
- A command name that collides with a built-in (\`/help\`, \`/model\`, \`/connect\`,
  \`/sessions\`, \`/compact\`, \`/init\`, \`/mode\`, \`/clear\`, \`/exit\`, \`/reload\`).
- \`parameters\` that is not a zod schema, or \`execute\` that is not a function.

None of these are fatal. The registration is dropped, the reason is recorded,
and everything else still loads.

---

## 3. Themes

A JSON file of colour tokens. Unknown tokens are ignored with a warning;
tokens you leave out keep their default, so a theme can be three lines.

\`\`\`json
{
  "accent": "magenta",
  "success": "green",
  "user": "cyan",
  "rail": "gray"
}
\`\`\`

Save as \`~/.haxford/themes/violet.json\`, then either:

- \`HAXFORD_THEME=violet haxford\` — one run, or
- \`"theme": "violet"\` in \`~/.config/haxford/haxford.json\` — every run.

The env var wins. Values are Ink colour names — the 16 ANSI colours
(\`cyan\`, \`green\`, \`yellow\`, \`red\`, \`magenta\`, \`gray\`, \`black\`, \`white\`, …).
Named colours are deliberate: they map to the palette *your terminal* is
configured with, so haxford looks right in any scheme instead of asserting
one. \`""\` means "inherit the terminal's own foreground".

Tokens: \`accent\`, \`text\`, \`muted\`, \`dim\`, \`success\`, \`warning\`, \`error\`,
\`info\`, \`rail\`, \`railAccent\`, \`selectedBg\`, \`selectedFg\`, \`panelBg\`,
\`diffAdd\`, \`diffDel\`, \`diffCtx\`, \`codeSpan\`, \`user\`, \`toolIcon\`.

---

## 4. /reload

\`/reload\` disposes every registered command, tool and hook, then rescans all
three directories. No restart, no lost session.

One limit worth knowing: reload re-evaluates each extension **entry file**, but
modules those files import keep the version first loaded. If you edit a shared
\`./helper.ts\`, restart haxford.

---

## 5. Writing one from inside haxford

You can ask haxford to extend itself — it has this document and a \`write\` tool:

> read ~/.haxford/EXTENDING.md, then add a /standup command that summarises
> today's commits

It will read the doc, write the file into \`~/.haxford/extensions/\`, and tell
you to run \`/reload\`.
`

/**
 * Write `EXTENDING.md` into the user's haxford home if it is not already there.
 *
 * Never overwrites: the file is the user's once it exists, and silently
 * replacing notes they added to it would be the kind of thing you only notice
 * after losing something.
 */
export async function ensureExtendingDoc(
  file: string = extendingDocPath(),
): Promise<{ path: string; created: boolean; error?: string }> {
  try {
    if (await Bun.file(file).exists()) return { path: file, created: false }
    await Bun.write(file, EXTENDING_MD)
    return { path: file, created: true }
  } catch (error) {
    return {
      path: file,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
