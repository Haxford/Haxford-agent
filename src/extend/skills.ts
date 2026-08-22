/**
 * Skills: reusable instruction sets the model can pull into context on demand.
 *
 * `~/.haxford/skills/<name>/SKILL.md`, each with a small YAML-ish frontmatter
 * block. The scan is deliberately *cheap*: only the first few KB of each file
 * is read, because the index exists to be pasted into every system prompt and
 * the bodies exist to be read by the model with its own `read` tool when a
 * skill turns out to be relevant. Loading every body at startup would put
 * kilobytes of instructions the model does not need into the cached prefix.
 */

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { skillsDir } from "./paths.ts"

/** The file a skill directory must contain to count as a skill. */
export const SKILL_FILE = "SKILL.md"

/**
 * Bytes read per skill during a scan.
 *
 * Enough for a frontmatter block with room to spare, small enough that a
 * hundred skills cost one page each rather than a hundred whole documents.
 */
export const FRONTMATTER_BYTES = 4096

/** One skill, as it appears in the index and in the system prompt. */
export interface SkillSummary {
  /** Frontmatter `name`, falling back to the directory name. */
  name: string
  /** Frontmatter `description`; empty when the skill declares none. */
  description: string
  /** Absolute path to the SKILL.md, so the model can read the body itself. */
  path: string
}

/**
 * The live index. Read by `assembleSystemPrompt` on every request, which is
 * what makes the prompt's skills block always current after a `/reload`
 * without any wiring between the two.
 */
let index: SkillSummary[] = []

/** The current index. Empty until `scanSkills` has run. */
export function listSkills(): SkillSummary[] {
  return index
}

/** Look one up by name, case-insensitively. */
export function findSkill(name: string): SkillSummary | undefined {
  const want = name.trim().toLowerCase()
  return index.find((skill) => skill.name.toLowerCase() === want)
}

/** Drop the index (used by reload before a rescan). */
export function clearSkills(): void {
  index = []
}

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                 */
/* -------------------------------------------------------------------------- */

/** `value`, `"value"` or `'value'` -> `value`. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Pull every `key: value` pair out of a frontmatter block.
 *
 * One-line scalars only. Anything else — block scalars, nested maps, lists —
 * is ignored rather than half-parsed: this is metadata, and a field that does
 * not fit on a line is better fixed than guessed at. Missing or malformed
 * frontmatter yields an empty result, never a throw.
 *
 * Shared with the named-agents loader (`src/agent/agents.ts`), which reads
 * more keys than skills do; this module owns the parsing so there is exactly
 * one frontmatter dialect on disk.
 */
export function parseFrontmatterFields(head: string): Record<string, string> {
  const text = head.replace(/\r\n/g, "\n")
  if (!text.startsWith("---")) return {}

  const lines = text.split("\n")
  const out: Record<string, string> = {}

  // Skip the opening delimiter; stop at the closing one, or at the end of
  // whatever slice of the file we were handed.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trim() === "---") break
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = (match[1] ?? "").toLowerCase()
    const value = unquote(match[2] ?? "")
    if (value.length === 0) continue
    // A block-scalar marker (`>`, `|`, `>-`, `|+2`, …) introduces a value on
    // the following lines, which this parser deliberately does not read.
    // Taking the marker as the value would put a literal ">" in the prompt.
    if (/^[>|][-+]?\d*$/.test(value)) continue
    if (out[key] === undefined) out[key] = value
  }

  return out
}

/**
 * Pull `name` and `description` out of a frontmatter block.
 *
 * Missing or malformed frontmatter yields an empty result, never a throw.
 */
export function parseFrontmatter(head: string): {
  name?: string
  description?: string
} {
  const fields = parseFrontmatterFields(head)
  return {
    ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
    ...(fields["description"] !== undefined
      ? { description: fields["description"] }
      : {}),
  }
}

/**
 * A SKILL.md with its frontmatter block removed.
 *
 * The frontmatter is already in the index, so repeating it in the body would
 * spend context on something the model has read twice.
 */
export function stripFrontmatter(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---")) return normalized
  const lines = normalized.split("\n")
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\n+/, "")
    }
  }
  // No closing delimiter: the file is not really frontmatter-prefixed.
  return normalized
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rescan the skills directory and replace the index.
 *
 * A missing directory is not an error — most users have no skills — and a
 * skill that cannot be read is reported as a warning and skipped rather than
 * failing the scan, because one unreadable directory must not cost the user
 * every other skill they wrote.
 */
export async function scanSkills(
  dir: string = skillsDir(),
): Promise<{ skills: SkillSummary[]; warnings: string[] }> {
  const warnings: string[] = []
  let entries: Dirent[]

  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // No skills directory at all: an empty index, silently.
    index = []
    return { skills: [], warnings }
  }

  const found: SkillSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".")) continue

    const file = path.join(dir, entry.name, SKILL_FILE)
    const handle = Bun.file(file)
    if (!(await handle.exists())) continue

    let head: string
    try {
      head = await handle.slice(0, FRONTMATTER_BYTES).text()
    } catch (error) {
      warnings.push(
        `skill ${JSON.stringify(entry.name)}: could not read ${SKILL_FILE} (${errorText(error)})`,
      )
      continue
    }

    const front = parseFrontmatter(head)
    found.push({
      name: front.name ?? entry.name,
      description: front.description ?? "",
      path: file,
    })
  }

  // Stable order so the prompt's skills block is byte-identical between
  // requests — a reordered block would invalidate the cached prefix.
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  index = found
  return { skills: found, warnings }
}

/**
 * The full body of one skill, read on demand.
 *
 * Returns undefined for an unknown skill or an unreadable file — this is an
 * index lookup, not a tool, and a caller asking for a skill that is not there
 * wants a miss rather than an exception.
 */
export async function getSkillBody(name: string): Promise<string | undefined> {
  const entry = findSkill(name)
  if (entry === undefined) return undefined
  try {
    return stripFrontmatter(await Bun.file(entry.path).text())
  } catch {
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
