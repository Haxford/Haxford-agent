/**
 * Named agents: user-defined personas as markdown files.
 *
 * `.haxford/agents/<name>.md` (project) and `~/.haxford/agents/<name>.md`
 * (global); the project file wins a name clash. Frontmatter carries the
 * configuration — description, optional model/mode/tool allowlist — and the
 * body is the agent's system-prompt addendum.
 *
 * Loading mirrors the skills scan: cheap, warnings-as-strings, never throws.
 * A broken agent file costs that agent, never the session.
 */

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { haxfordHome } from "../extend/paths.ts"
import { parseFrontmatterFields } from "../extend/skills.ts"
import { clampMode, type Mode } from "../permission/engine.ts"
import type { Tool } from "../types/tool.ts"

/** The agent name that means "no named agent": stock behavior, unchanged. */
export const DEFAULT_AGENT_NAME = "build"

/** The file an agent directory entry must be. */
const AGENT_SUFFIX = ".md"

/** Ceiling on one agent file. Its body is prompt text, not a data store. */
const MAX_AGENT_BYTES = 256 * 1024

/** Valid frontmatter modes, in increasing order of permissiveness. */
const VALID_MODES: readonly Mode[] = ["plan", "build", "auto"]

export interface NamedAgent {
  /** The filename without `.md`. Lowercase, unique across both dirs. */
  name: string
  /** Frontmatter `description`; what pickers and error messages show. */
  description: string
  /** Optional "provider/model" override for the default model chain. */
  model?: string
  /** Optional permission-posture override for the default mode. */
  mode?: Mode
  /** Optional allowlist of tool ids; absent means every tool. */
  tools?: string[]
  /** The body: appended to the system prompt after project instructions. */
  instructions: string
  /** Where this agent came from — project files shadow global ones. */
  source: "project" | "global"
  path: string
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                   */
/* -------------------------------------------------------------------------- */

/** `~/.haxford/agents` — the global set. */
export function globalAgentsDir(): string {
  return path.join(haxfordHome(), "agents")
}

/** `<cwd>/.haxford/agents` — the project set; wins name clashes. */
export function projectAgentsDir(cwd: string): string {
  return path.join(cwd, ".haxford", "agents")
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split a `tools:` value into ids. Accepts both the documented comma form
 * (`read, grep`) and a YAML-ish bracket list (`[read, grep]`), because both
 * appear in the wild and refusing either just generates support questions.
 */
export function parseToolList(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/**
 * Parse one agent markdown file into a NamedAgent.
 *
 * Every problem short of an unreadable file is a warning plus a repaired
 * value: an unknown mode drops the field, a malformed tool list becomes an
 * empty one (which would lock the agent out of everything — so it is dropped
 * too), and missing frontmatter still yields a usable body-only agent.
 */
export async function loadAgent(
  file: string,
  source: "project" | "global",
): Promise<{ agent?: NamedAgent; warnings: string[] }> {
  const warnings: string[] = []
  const name = path.basename(file).slice(0, -AGENT_SUFFIX.length)

  if (!name || name.startsWith(".") || file.endsWith(".md") === false) {
    return { warnings: [`skipped ${file}: not an <name>.md file`] }
  }

  let text: string
  try {
    const handle = Bun.file(file)
    // `getAgents` reads every agent body just to build the picker list, so an
    // oversized file is paid for on every scan — and the body goes into the
    // system prompt, where megabytes are a bill, not a feature.
    if (handle.size > MAX_AGENT_BYTES) {
      return {
        warnings: [
          `agent ${JSON.stringify(name)}: ${handle.size} bytes, over the ${MAX_AGENT_BYTES}-byte limit (skipped)`,
        ],
      }
    }
    text = await handle.text()
  } catch (error) {
    return { warnings: [`agent ${JSON.stringify(name)}: could not read (${errorText(error)})`] }
  }

  const fields = parseFrontmatterFields(text)

  const agent: NamedAgent = {
    name,
    description: fields["description"] ?? "",
    instructions: stripFrontmatterBlock(text),
    source,
    path: file,
  }

  const model = fields["model"]?.trim()
  if (model !== undefined && model.length > 0) {
    if (!model.includes("/")) {
      warnings.push(
        `agent ${JSON.stringify(name)}: model ${JSON.stringify(model)} is not a provider/spec pair (ignoring it)`,
      )
    } else {
      agent.model = model
    }
  }

  const mode = fields["mode"]?.trim().toLowerCase()
  if (mode !== undefined && mode.length > 0) {
    if (!(VALID_MODES as readonly string[]).includes(mode)) {
      warnings.push(
        `agent ${JSON.stringify(name)}: unknown mode ${JSON.stringify(fields["mode"])} (valid: ${VALID_MODES.join(", ")})`,
      )
    } else {
      agent.mode = mode as Mode
    }
  }

  const tools = fields["tools"]
  if (tools !== undefined && tools.trim().length > 0) {
    const ids = parseToolList(tools)
    if (ids.length === 0) {
      warnings.push(
        `agent ${JSON.stringify(name)}: tools ${JSON.stringify(tools)} names no tools (allowlist ignored)`,
      )
    } else {
      agent.tools = ids
    }
  }

  return { agent, warnings }
}

/** Remove the leading frontmatter block, leaving the prompt addendum. */
function stripFrontmatterBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---")) return normalized.trim()
  const lines = normalized.split("\n")
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      return lines.slice(i + 1).join("\n").trim()
    }
  }
  return normalized.trim()
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Scan one directory for `*.md` agents. A missing directory is empty, not an
 * error; an unreadable file is a warning and is skipped.
 */
async function scanAgentDir(
  dir: string,
  source: "project" | "global",
): Promise<{ agents: NamedAgent[]; warnings: string[] }> {
  const warnings: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { agents: [], warnings }
  }

  const found: NamedAgent[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith(AGENT_SUFFIX)) continue
    if (entry.name.startsWith(".")) continue

    // Symlinks are deliberately NOT followed, and saying so out loud matters
    // twice over. An agent body becomes system-prompt text, so following one
    // would let a cloned repo point `.haxford/agents/x.md` at `~/.ssh/id_rsa`
    // and have the contents read out to the model. And because a skipped
    // project entry silently leaves the global agent of the same name in
    // force, a user who symlinked one deliberately would otherwise see the
    // wrong agent run with no explanation.
    if (entry.isSymbolicLink()) {
      warnings.push(
        `skipped ${path.join(dir, entry.name)}: symlinked agent files are not followed ` +
          `(an agent body becomes prompt text, so it must be a real file in the directory)`,
      )
      continue
    }
    if (!entry.isFile()) continue

    const { agent, warnings: fileWarnings } = await loadAgent(
      path.join(dir, entry.name),
      source,
    )
    warnings.push(...fileWarnings)
    if (agent !== undefined) found.push(agent)
  }

  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { agents: found, warnings }
}

/** Scan both directories, project overriding global on name clash. */
export async function getAgents(
  cwd: string,
): Promise<{ agents: NamedAgent[]; warnings: string[] }> {
  const globalSet = await scanAgentDir(globalAgentsDir(), "global")
  const projectSet = await scanAgentDir(projectAgentsDir(cwd), "project")

  const byName = new Map<string, NamedAgent>()
  for (const agent of [...globalSet.agents, ...projectSet.agents]) {
    // Insertion order puts project second, so a clash overwrites the global
    // definition with the project one — the same precedence as config layers.
    byName.set(agent.name.toLowerCase(), agent)
  }

  const agents = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  return { agents, warnings: [...globalSet.warnings, ...projectSet.warnings] }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve which named agent applies, if any.
 *
 * `undefined`/empty/`"build"` means no named agent: default behavior,
 * unchanged. An unknown name resolves to no agent plus a warning that lists
 * what is available — callers surface the string, the run proceeds normally.
 */
export async function resolveAgent(
  cwd: string,
  name?: string,
): Promise<{ agent?: NamedAgent; warnings: string[] }> {
  const wanted = name?.trim().toLowerCase()
  if (wanted === undefined || wanted.length === 0 || wanted === DEFAULT_AGENT_NAME) {
    return { warnings: [] }
  }

  const { agents, warnings } = await getAgents(cwd)
  const agent = agents.find((a) => a.name.toLowerCase() === wanted)
  if (agent === undefined) {
    const known = agents.map((a) => a.name).join(", ") || "none"
    return {
      warnings: [
        `unknown agent ${JSON.stringify(name)} (available: ${known}); using the default agent`,
      ],
    }
  }
  return { agent, warnings }
}

/**
 * The effective permission mode: an explicit `--mode` flag wins, then the
 * named agent's posture, then the CLI default.
 *
 * An agent may only make the posture STRICTER. Declaring `mode: plan` for a
 * read-only reviewer is the feature; declaring `mode: auto` to escape the
 * default `build` is not, because `.haxford/agents/*.md` is read from the
 * project directory and therefore ships with any repository you clone. Auto
 * mode allows everything a rule does not deny, so an unclamped agent file
 * would turn `haxford --agent helper` in a cloned repo into unattended writes
 * and shell access the user never chose.
 *
 * An explicit `--mode` still wins outright in both directions: that is the
 * user typing, not a file in the repo.
 */
export function pickMode(cliMode: Mode, cliExplicit: boolean, agent?: NamedAgent): Mode {
  if (cliExplicit) return cliMode
  return clampMode(agent?.mode, cliMode)
}

/**
 * The effective model spec: explicit `--model`, then the named agent, then
 * the usual chain (project state, config, curated default).
 */
export function pickModel(
  agent: NamedAgent | undefined,
  cliModel: string | undefined,
  projectModel: string | undefined,
  configModel: string | undefined,
  fallback: string,
): string {
  return cliModel ?? agent?.model ?? projectModel ?? configModel ?? fallback
}

/**
 * Filter a tool list down to the agent's allowlist.
 *
 * No allowlist returns the input unchanged (same array, stable order for the
 * cached prefix). Unknown allowlisted ids simply match nothing — a typo in an
 * agent file cannot add a tool that does not exist.
 */
export function filterToolsByAllowlist(tools: Tool[], agent?: NamedAgent): Tool[] {
  const allowed = agent?.tools
  if (allowed === undefined || allowed.length === 0) return tools
  const set = new Set(allowed.map((id) => id.trim().toLowerCase()))
  return tools.filter((tool) => set.has(tool.id))
}

/* -------------------------------------------------------------------------- */
/* Built-in scaffolds                                                          */
/* -------------------------------------------------------------------------- */

/** Example agents written into `~/.haxford/agents` on first run. Never overwritten. */
export const BUILTIN_AGENTS: Record<string, string> = {
  "reviewer.md": `---
description: Review code for correctness and quality. Read-only.
mode: plan
tools: read, glob, grep
---

You are a rigorous code reviewer.

Review the code or diff the user points you at. For each finding report:

- **Location** as file_path:line so it can be clicked.
- **Severity**: blocker (will break), concern (likely wrong or fragile), or nit (style).
- **Why**, in one or two sentences — the failure it causes or the convention it breaks.

Read any file you need for context before judging; never review from the diff
alone. You are read-only by design: report findings, do not attempt fixes.
Finish with a one-line verdict: approve, approve with nits, or changes needed.
`,

  "explainer.md": `---
description: Explain code clearly, asking clarifying questions first.
---

You are a patient technical explainer.

Before explaining, make sure you know what the reader needs: if the request is
ambiguous about depth (a quick orientation vs a line-by-line walkthrough) or
background level, ask one short clarifying question first rather than guessing.

Then explain with the code in view — read the actual files with your tools
before answering, and anchor every claim to a specific file_path:line. Prefer
the mental model first ("what this is for, how data flows"), then details on
request. Use a worked example through the code when one exists. Plain prose,
short lists, no filler.
`,
}

/**
 * Write the built-in example agents, once.
 *
 * Idempotent and never overwriting: the files are the user's the moment they
 * exist. Returns what it created so startup can stay quiet when there is
 * nothing to say.
 */
export async function ensureBuiltinAgents(
  dir: string = globalAgentsDir(),
): Promise<string[]> {
  const created: string[] = []
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const file = path.join(dir, name)
    try {
      if (await Bun.file(file).exists()) continue
      await Bun.write(file, content)
      created.push(file)
    } catch {
      // A read-only home must not block startup over example scaffolding.
    }
  }
  return created
}
