import { dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { checkAbsolute, errorText, hasRead, recordRead } from "./shared.ts"

const parameters = z.object({
  filePath: z.string().describe("Absolute path of the file to write."),
  content: z.string().describe("Full contents to write to the file."),
})

type Args = z.infer<typeof parameters>

export const writeTool: Tool<Args> = {
  id: "write",
  description: `Write a file to the filesystem, creating it or overwriting it entirely.

Usage:
- filePath MUST be an absolute path. Relative paths are rejected.
- content is the COMPLETE file contents. This tool does not append or patch —
  whatever you pass replaces the whole file.
- If the file already exists you MUST read it first. Writing over a file you
  have not read in this session is refused, so you never destroy content you
  have not seen.
- Missing parent directories are created automatically.
- Prefer edit for changing part of an existing file; use write for new files
  or a full rewrite.
- The user is asked to approve this action before it takes effect, and may
  decline.
- Do not create documentation, README, or example files unless asked to.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const invalid = checkAbsolute(args.filePath)
    if (invalid) return { title: "write failed", output: `Error: ${invalid}` }

    const path = args.filePath

    try {
      const file = Bun.file(path)
      const exists = await file.exists()

      if (exists && !hasRead(ctx.sessionID, path)) {
        return {
          title: `write ${path}`,
          output:
            `Error: ${path} already exists and has not been read in this session. ` +
            `Use read on it first so you do not overwrite content you have not seen.`,
        }
      }

      const decision = await ctx.askPermission({
        tool: "write",
        args: { filePath: path },
        title: `${exists ? "Overwrite" : "Create"} ${path}`,
        sessionID: ctx.sessionID,
      })
      if (decision === "deny") {
        return {
          title: `write ${path}`,
          output: `The user declined this write. ${path} was not modified. Do not retry it without new instructions.`,
        }
      }

      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, args.content)

      // The freshly written content is now what the model has "seen".
      recordRead(ctx.sessionID, path)

      const lines = args.content === "" ? 0 : args.content.split("\n").length
      return {
        title: `${exists ? "Updated" : "Created"} ${path}`,
        output: `${exists ? "Updated" : "Created"} ${path} (${lines} lines, ${args.content.length} bytes).`,
        metadata: {
          path,
          created: !exists,
          bytes: args.content.length,
          lines,
        },
      }
    } catch (error) {
      return {
        title: `write ${path}`,
        output: `Error writing ${path}: ${errorText(error)}`,
      }
    }
  },
}
