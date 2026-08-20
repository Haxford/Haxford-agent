/**
 * System prompt assembly.
 *
 * Section order matters for prompt caching: the identity block is byte-stable
 * across every request, the environment block changes at most once a day, and
 * caller-supplied project instructions come last.
 */

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
 * Build the system prompt. Stable content comes first so the cache prefix
 * survives; `projectInstructions` (e.g. AGENTS.md) is appended verbatim.
 */
export function assembleSystemPrompt(
  cwd: string,
  projectInstructions?: string,
): string {
  const sections: string[] = [IDENTITY]

  sections.push(
    [
      "# Environment",
      "",
      `Working directory: ${cwd}`,
      `Platform: ${process.platform}`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n"),
  )

  const instructions = projectInstructions?.trim()
  if (instructions) sections.push(instructions)

  return sections.join("\n\n")
}
