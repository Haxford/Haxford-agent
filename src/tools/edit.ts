import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { checkAbsolute, errorText, hasRead, recordRead } from "./shared.ts"

const editSchema = z.object({
  oldText: z.string().describe("Exact text for one targeted replacement."),
  newText: z.string().describe("Replacement text for this targeted edit."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
})

const parameters = z.object({
  filePath: z.string().describe("Absolute path of the file to edit."),
  edits: z
    .array(editSchema)
    .optional()
    .describe(
      "One or more targeted replacements. Each edit is matched against the " +
        "original file, not incrementally. Do not include overlapping or " +
        "nested edits.",
    ),
  oldString: z
    .string()
    .optional()
    .describe("Exact text to replace (flat single-edit form)."),
  newString: z
    .string()
    .optional()
    .describe("Text to replace it with (flat single-edit form)."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence instead of requiring a unique match " +
        "(flat single-edit form).",
    ),
})

type EditOp = {
  oldString: string
  newString: string
  replaceAll?: boolean
}

type Args = z.infer<typeof parameters>

/** Normalize the flat single-edit form into an edits array. */
function normalizeEdits(args: Args): EditOp[] | string {
  const flat: EditOp[] = []
  if (args.oldString !== undefined || args.newString !== undefined) {
    if (args.edits !== undefined) {
      return "Error: pass either edits[] or oldString/newString, not both."
    }
    const oldS = args.oldString ?? ""
    const newS = args.newString ?? ""
    flat.push({
      oldString: oldS,
      newString: newS,
      ...(args.replaceAll !== undefined ? { replaceAll: args.replaceAll } : {}),
    })
    return flat
  }
  if (args.edits === undefined) {
    return "Error: no edits provided. Pass edits[] or oldString/newString."
  }
  if (args.edits.length === 0) {
    return "Error: edits[] is empty. Provide at least one edit."
  }
  return args.edits.map((e) => ({
    oldString: e.oldText,
    newString: e.newText,
    ...(e.replaceAll !== undefined ? { replaceAll: e.replaceAll } : {}),
  }))
}

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

/**
 * Resolve a single edit into the spans it would replace on the ORIGINAL file.
 *
 * Returns [start, end] character offsets, or an error string. For a unique
 * match the span is the single occurrence; for replaceAll it is every
 * occurrence (returned as multiple spans).
 */
interface Span {
  start: number
  end: number
  edit: EditOp
}

function resolveSpans(
  content: string,
  edit: EditOp,
  label: string,
): { spans: Span[]; error?: string } {
  if (edit.oldString === "") {
    return { spans: [], error: `${label}: oldString is empty.` }
  }
  if (edit.oldString === edit.newString) {
    return { spans: [], error: `${label}: oldString and newString are identical.` }
  }
  const count = countOccurrences(content, edit.oldString)
  if (count === 0) {
    return {
      spans: [],
      error: `${label}: oldString was not found. The text must match exactly, including indentation and line breaks.`,
    }
  }
  if (count > 1 && !edit.replaceAll) {
    const first = lineOf(content, content.indexOf(edit.oldString))
    return {
      spans: [],
      error: `${label}: found ${count} matches (first at line ${first}). Add surrounding context to make oldString unique, or pass replaceAll: true.`,
    }
  }
  const spans: Span[] = []
  let idx = content.indexOf(edit.oldString)
  while (idx !== -1) {
    spans.push({ start: idx, end: idx + edit.oldString.length, edit })
    idx = content.indexOf(edit.oldString, idx + edit.oldString.length)
  }
  return { spans }
}

/** Check whether two spans overlap or nest. */
function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Produce a unified-diff-style summary of the applied edits.
 * Not a full diff algorithm — a compact per-edit report the model can read.
 */
function diffSummary(
  content: string,
  spans: Span[],
): string {
  const lines: string[] = []
  for (const span of spans) {
    const startLine = lineOf(content, span.start)
    const oldText = content.slice(span.start, span.end)
    const newText = span.edit.newString
    const oldPreview = oldText.length > 80 ? `${oldText.slice(0, 77)}…` : oldText
    const newPreview = newText.length > 80 ? `${newText.slice(0, 77)}…` : newText
    lines.push(`  line ${startLine}: -${JSON.stringify(oldPreview)} +${JSON.stringify(newPreview)}`)
  }
  return lines.join("\n")
}

export const editTool: Tool<Args> = {
  id: "edit",
  description: `Replace exact strings in a file.

Usage:
- filePath MUST be an absolute path. Relative paths are rejected.
- You MUST read the file before editing it.
- Pass edits[] for one or more targeted replacements in a single call. Each
  edits[].oldString is matched against the original file, not after earlier
  edits are applied. Do not include overlapping or nested edits. If two
  changes touch the same block or nearby lines, merge them into one edit
  instead of emitting overlapping edits.
- Keep edits[].oldString as small as possible while still being unique. Do
  not pad with large unchanged regions.
- The flat form (oldString/newString/replaceAll) still works for a single
  replacement, but prefer edits[] for new code.
- oldString must match the file EXACTLY — every space, tab, and newline. Copy
  it from the read output, but strip the line-number/tab prefix that read adds.
- oldString must be unique in the file, or the edit is refused as ambiguous.
  Include surrounding context lines to make it unique, or pass replaceAll: true
  to change every occurrence deliberately.
- oldString and newString must differ.
- To create a new file use write; to delete text pass an empty newString.
- The user is asked to approve this action before it takes effect, and may
  decline.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const invalid = checkAbsolute(args.filePath)
    if (invalid) return { title: "edit failed", output: `Error: ${invalid}` }

    const path = args.filePath

    const normalized = normalizeEdits(args)
    if (typeof normalized === "string") {
      return { title: `edit ${path}`, output: `Error: ${normalized}` }
    }
    const edits = normalized

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

      // Resolve every edit against the ORIGINAL content. An edit that does
      // not match, or is ambiguous, fails the whole call — all-or-nothing.
      const allSpans: Span[] = []
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!
        const label = edits.length === 1 ? "edit" : `edits[${i}]`
        const { spans, error } = resolveSpans(content, edit, label)
        if (error) {
          return {
            title: `edit ${path}`,
            output: `Error: ${error}`,
          }
        }
        allSpans.push(...spans)
      }

      // Reject overlapping or nested spans — they cannot both apply to the
      // original file without one clobbering the other.
      for (let i = 0; i < allSpans.length; i++) {
        for (let j = i + 1; j < allSpans.length; j++) {
          if (overlaps(allSpans[i]!, allSpans[j]!)) {
            const a = allSpans[i]!
            const b = allSpans[j]!
            return {
              title: `edit ${path}`,
              output:
                `Error: edits overlap or nest (lines ${lineOf(content, a.start)} and ${lineOf(content, b.start)}). ` +
                `Merge them into a single edit covering the whole region.`,
            }
          }
        }
      }

      const totalReplaced = allSpans.length

      const decision = await ctx.askPermission({
        tool: "edit",
        args: { filePath: path },
        title: `Edit ${path}${totalReplaced > 1 ? ` (${totalReplaced} occurrences)` : ""}`,
        sessionID: ctx.sessionID,
      })
      if (decision === "deny") {
        return {
          title: `edit ${path}`,
          output: `The user declined this edit. ${path} was not modified. Do not retry it without new instructions.`,
        }
      }

      // The approval above is an await: the user thinks, and meanwhile the
      // file can change under us — a formatter, a git checkout, another
      // agent. Every span is an offset into the content read BEFORE the
      // prompt, so writing now would splice new text at stale positions and
      // silently discard whatever landed in between. Re-read and refuse
      // rather than clobber; the model can read again and retry.
      const current = await Bun.file(path).text()
      if (current !== content) {
        return {
          title: `edit ${path}`,
          output:
            `Error: ${path} changed on disk while this edit was awaiting approval. ` +
            `Nothing was written. Read the file again and reapply the edit against its current contents.`,
        }
      }

      // Apply all spans to the original content in a single pass, building
      // the new string by slicing between spans and inserting newStrings.
      // Spans are sorted by start offset; overlaps were already rejected.
      allSpans.sort((a, b) => a.start - b.start)
      const pieces: string[] = []
      let cursor = 0
      for (const span of allSpans) {
        pieces.push(content.slice(cursor, span.start))
        pieces.push(span.edit.newString)
        cursor = span.end
      }
      pieces.push(content.slice(cursor))
      const updated = pieces.join("")

      await Bun.write(path, updated)
      recordRead(ctx.sessionID, path)

      const diff = diffSummary(content, allSpans)
      return {
        title: `Edited ${path}`,
        output:
          `Replaced ${totalReplaced} occurrence(s) in ${path}.\n${diff}`,
        metadata: { path, replaced: totalReplaced, edits: edits.length },
      }
    } catch (error) {
      return {
        title: `edit ${path}`,
        output: `Error editing ${path}: ${errorText(error)}`,
      }
    }
  },
}
