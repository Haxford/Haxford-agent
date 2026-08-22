import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { redactSecrets } from "../config/secrets.ts"
import {
  checkAbsolute,
  errorText,
  looksBinary,
  recordRead,
} from "./shared.ts"

const DEFAULT_LIMIT = 2000
const MAX_LINE_CHARS = 2000
/** Refuse to buffer more than this; paging is what offset/limit are for. */
const MAX_FILE_BYTES = 50_000_000

const parameters = z.object({
  filePath: z.string().describe("Absolute path to the file to read."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start from. Defaults to 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum lines to return. Defaults to ${DEFAULT_LIMIT}.`),
})

type Args = z.infer<typeof parameters>

/** cat -n style: right-aligned line number, tab, then the line. */
function numberLine(lineNo: number, text: string): string {
  return `${String(lineNo).padStart(5, " ")}\t${text}`
}

export const readTool: Tool<Args> = {
  id: "read",
  description: `Read a file from the filesystem.

Usage:
- filePath MUST be an absolute path. Relative paths are rejected.
- Reads up to ${DEFAULT_LIMIT} lines from the start of the file by default.
  For longer files, page through with offset (1-based line number) and limit.
- Output is line-numbered in cat -n style: the number, a tab, then the line.
  The numbers are for your reference when calling edit — never include them
  in an edit's oldString.
- Lines longer than ${MAX_LINE_CHARS} characters are truncated.
- Binary files are refused; do not retry them.
- You MUST read a file before writing over it or editing it.
- Prefer reading several related files in parallel in a single step rather
  than one at a time.
- Read only what you need. When you already know which part of a large file
  matters, pass offset/limit or grep for it instead of pulling in the whole
  file — everything you read stays in context for the rest of the session.
- Do NOT re-read a file to confirm an edit you just made succeeded. edit and
  write report their own failures; a clean result means the change is on
  disk.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const invalid = checkAbsolute(args.filePath)
    if (invalid) return { title: "read failed", output: `Error: ${invalid}` }

    const path = args.filePath
    const file = Bun.file(path)

    try {
      if (!(await file.exists())) {
        return {
          title: `read ${path}`,
          output:
            `Error: file not found: ${path}. Check the path is right — ` +
            `use glob to locate the file by name rather than guessing another path.`,
        }
      }
      // `file.text()` below buffers the whole file. Without a ceiling, a huge
      // log — or a character device like /dev/zero, which `exists()` happily
      // confirms — takes the process down instead of returning an error the
      // model can act on.
      if (file.size > MAX_FILE_BYTES) {
        return {
          title: `read ${path}`,
          output:
            `Error: ${path} is ${file.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit. ` +
            `Use grep to find what you need, or bash with sed/head to page through it.`,
          metadata: { path, bytes: file.size },
        }
      }
      if (await looksBinary(path)) {
        return {
          title: `read ${path}`,
          output: `Error: ${path} appears to be a binary file and cannot be read as text.`,
        }
      }

      // Mask credentials before the text goes anywhere. Reading
      // `~/.config/haxford/haxford.json`, an `.env`, or a stray auth store
      // otherwise puts a live key into the model's context AND the session
      // JSONL on disk — bash output has been masked since the beginning, and
      // a file read is the same leak by a quieter route.
      const content = redactSecrets(await file.text())

      // Track the read even when paging, so edit/write are unblocked.
      recordRead(ctx.sessionID, path)

      if (content === "") {
        return {
          title: `read ${path}`,
          output: `(${path} is empty)`,
          metadata: { path, lines: 0, empty: true },
        }
      }

      const all = content.split("\n")
      // A trailing newline yields a final empty element that is not a line.
      if (all.length > 0 && all[all.length - 1] === "") all.pop()

      const offset = args.offset ?? 1
      const limit = args.limit ?? DEFAULT_LIMIT

      if (offset > all.length) {
        return {
          title: `read ${path}`,
          output:
            `Error: offset ${offset} is past the end of ${path} ` +
            `(${all.length} lines).`,
          metadata: { path, lines: all.length },
        }
      }

      const selected = all.slice(offset - 1, offset - 1 + limit)
      let longLines = 0
      const rendered = selected.map((line, i) => {
        let text = line
        if (text.length > MAX_LINE_CHARS) {
          longLines++
          text = `${text.slice(0, MAX_LINE_CHARS)}… [line truncated]`
        }
        return numberLine(offset + i, text)
      })

      const lastShown = offset - 1 + selected.length
      const notes: string[] = []
      if (lastShown < all.length) {
        notes.push(
          `[Showing lines ${offset}-${lastShown} of ${all.length}. ` +
            `Use offset=${lastShown + 1} to continue.]`,
        )
      }
      if (longLines > 0) {
        notes.push(
          `[${longLines} line(s) longer than ${MAX_LINE_CHARS} chars were truncated. ` +
            `To see one in full, use bash: sed -n '<line>p' ${path}]`,
        )
      }

      const body = rendered.join("\n")
      return {
        title: `read ${path}`,
        output: notes.length ? `${body}\n\n${notes.join("\n")}` : body,
        metadata: {
          path,
          lines: all.length,
          offset,
          shown: selected.length,
          truncated: lastShown < all.length,
        },
      }
    } catch (error) {
      return {
        title: `read ${path}`,
        output: `Error reading ${path}: ${errorText(error)}`,
      }
    }
  },
}
