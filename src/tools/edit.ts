import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { checkAbsolute, errorText, hasRead, recordRead } from "./shared.ts"

const parameters = z.object({
  filePath: z.string().describe("Absolute path of the file to edit."),
  oldString: z.string().describe("Exact text to replace, including whitespace."),
  newString: z.string().describe("Text to replace it with."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
})

type Args = z.infer<typeof parameters>

/** Count non-overlapping occurrences without building an array. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 1-based line number of a character offset, for error context. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++
  return line
}

export const editTool: Tool<Args> = {
  id: "edit",
  description: `Replace an exact string in a file.

Usage:
- filePath MUST be an absolute path. Relative paths are rejected.
- You MUST read the file before editing it.
- oldString must match the file EXACTLY — every space, tab, and newline. Copy
  it from the read output, but strip the line-number/tab prefix that read adds.
- oldString must be unique in the file, or the edit is refused as ambiguous.
  Include surrounding context lines to make it unique, or pass replaceAll: true
  to change every occurrence deliberately.
- oldString and newString must differ.
- To create a new file use write; to delete text pass an empty newString.
- Prefer making several independent edits to a file in parallel over many
  sequential round trips.
- The user is asked to approve this action before it takes effect, and may
  decline.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const invalid = checkAbsolute(args.filePath)
    if (invalid) return { title: "edit failed", output: `Error: ${invalid}` }

    const path = args.filePath

    if (args.oldString === args.newString) {
      return {
        title: `edit ${path}`,
        output: "Error: oldString and newString are identical — nothing to change.",
      }
    }

    try {
      const file = Bun.file(path)
      if (!(await file.exists())) {
        return {
          title: `edit ${path}`,
          output: `Error: file not found: ${path}. Use write to create it.`,
        }
      }
      if (!hasRead(ctx.sessionID, path)) {
        return {
          title: `edit ${path}`,
          output:
            `Error: ${path} has not been read in this session. ` +
            `Use read on it before editing so your oldString matches the real content.`,
        }
      }

      const content = await file.text()

      if (args.oldString === "") {
        return {
          title: `edit ${path}`,
          output:
            "Error: oldString is empty. Provide the exact text to replace, " +
            "or use write to create/replace the whole file.",
        }
      }

      const matches = countOccurrences(content, args.oldString)
      if (matches === 0) {
        return {
          title: `edit ${path}`,
          output:
            `Error: oldString was not found in ${path}. The text must match ` +
            `exactly, including indentation and line breaks. Re-read the file ` +
            `and copy the target text from it (without the line-number prefix).`,
        }
      }
      if (matches > 1 && !args.replaceAll) {
        const first = lineOf(content, content.indexOf(args.oldString))
        return {
          title: `edit ${path}`,
          output:
            `Error: found ${matches} matches for oldString in ${path} ` +
            `(first at line ${first}). The edit is ambiguous. Add surrounding ` +
            `context to make oldString unique, or pass replaceAll: true to ` +
            `change all ${matches} occurrences.`,
          metadata: { path, matches },
        }
      }

      const decision = await ctx.askPermission({
        tool: "edit",
        args: { filePath: path },
        title: `Edit ${path}${args.replaceAll && matches > 1 ? ` (${matches} occurrences)` : ""}`,
        sessionID: ctx.sessionID,
      })
      if (decision === "deny") {
        return {
          title: `edit ${path}`,
          output: `The user declined this edit. ${path} was not modified. Do not retry it without new instructions.`,
        }
      }

      const updated = args.replaceAll
        ? content.split(args.oldString).join(args.newString)
        : content.replace(args.oldString, args.newString)

      await Bun.write(path, updated)
      recordRead(ctx.sessionID, path)

      const replaced = args.replaceAll ? matches : 1
      const line = lineOf(content, content.indexOf(args.oldString))
      return {
        title: `Edited ${path}`,
        output: `Replaced ${replaced} occurrence(s) in ${path} (first at line ${line}).`,
        metadata: { path, replaced, line },
      }
    } catch (error) {
      return {
        title: `edit ${path}`,
        output: `Error editing ${path}: ${errorText(error)}`,
      }
    }
  },
}
