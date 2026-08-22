/**
 * System prompt assembly.
 *
 * Section order matters for prompt caching: the identity and self-extension
 * blocks are byte-stable across every request, the environment block changes
 * at most once a day, the skills index changes only on `/reload`, and
 * caller-supplied project instructions come last.
 */

import { extendingDocPath } from "../extend/paths.ts"
import { listSkills, type SkillSummary } from "../extend/skills.ts"

const IDENTITY = `You are haxford, an interactive CLI coding agent. You help with software
engineering tasks in the user's terminal.

Behavior:
- Be concise. The user reads your output in a terminal — no preamble, no
  restating the question, no summarizing what you just did unless asked.
  One or two sentences beats a paragraph.
- Be tool-first. Investigate with tools before answering questions about the
  codebase; never guess at file contents, APIs, or project conventions.
- Follow the conventions of the code you are editing: match its naming,
  formatting, comment density, and libraries. Check that a dependency is
  already used in the project before reaching for it.
- Be safe. Do not take destructive or irreversible actions the user did not
  ask for. Prefer showing a plan for anything far-reaching.
- Say when you are unsure or when something failed. Do not claim work is
  done or verified when it is not.
- Format for a terminal: plain prose, short lists, code fences for code.
  Reference locations as file_path:line so they can be clicked.`

/**
 * Tell the model it can extend itself.
 *
 * Three lines, because that is all it takes: the API is documented on disk,
 * and a model that knows the doc exists will read it before writing a plugin
 * instead of inventing an API from the shape of the request.
 */
function extendingSection(docPath: string): string {
  return [
    "# Extending yourself",
    "",
    `Your own extension API is documented at ${docPath}. It covers three layers:`,
    "skills (reusable instructions), extensions (slash commands, tools and",
    "lifecycle hooks, as TypeScript files), and themes.",
    "",
    "To build one: read that document, write the file into the directory it",
    "names, and tell the user to run /reload. Do not guess at the API — the",
    "document is short and it is the only accurate description of it.",
  ].join("\n")
}

/**
 * The skills index: name, one-line description, and where to read the rest.
 *
 * Deliberately *only* the index. Inlining every skill body would put the
 * whole library into the cached prefix whether or not any of it is relevant;
 * naming the path instead costs one line per skill and lets the model pull
 * the body with its own read tool exactly when the description matches what
 * it is doing.
 */
function skillsSection(skills: SkillSummary[]): string {
  const lines = [
    "# Skills",
    "",
    "Reusable instruction sets available on this machine. When one is relevant",
    "to the task, read its file with the read tool before proceeding — the",
    "descriptions below are an index, not the instructions themselves.",
    "",
  ]
  for (const skill of skills) {
    lines.push(
      skill.description.length > 0
        ? `- ${skill.name} — ${skill.description}`
        : `- ${skill.name}`,
    )
    lines.push(`  ${skill.path}`)
  }
  return lines.join("\n")
}

/**
 * Build the system prompt. Stable content comes first so the cache prefix
 * survives; `projectInstructions` (e.g. AGENTS.md) is appended verbatim, and
 * a named agent's own addendum comes last of all — it is the most specific
 * voice in the stack and may need to override what came before.
 *
 * `skills` defaults to the live index rather than being threaded through from
 * the host, which is what makes the block always current after a `/reload`
 * with no wiring between the two. Tests pass an explicit array.
 */
export function assembleSystemPrompt(
  cwd: string,
  projectInstructions?: string,
  skills: SkillSummary[] = listSkills(),
  agentInstructions?: string,
): string {
  const sections: string[] = [IDENTITY, extendingSection(extendingDocPath())]

  sections.push(
    [
      "# Environment",
      "",
      `Working directory: ${cwd}`,
      `Platform: ${process.platform}`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n"),
  )

  if (skills.length > 0) sections.push(skillsSection(skills))

  const instructions = projectInstructions?.trim()
  if (instructions) sections.push(instructions)

  const addendum = agentInstructions?.trim()
  if (addendum) sections.push(addendum)

  return sections.join("\n\n")
}
