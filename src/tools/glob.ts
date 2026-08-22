import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { errorText, isNoisePath } from "./shared.ts"

const LIMIT = 100

const parameters = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
  path: z
    .string()
    .optional()
    .describe("Absolute directory to search in. Defaults to the working directory."),
})

type Args = z.infer<typeof parameters>

export const globTool: Tool<Args> = {
  id: "glob",
  description: `Find files by name using a glob pattern.

Usage:
- Patterns are matched relative to the search directory, e.g. "**/*.ts",
  "src/**/*.{ts,tsx}", "**/config.*".
- path, if given, MUST be absolute; it defaults to the working directory.
- Results are absolute paths sorted by modification time, most recent first,
  so the files someone has been working on come first.
- At most ${LIMIT} results are returned; the output says so when it truncates.
  Narrow the pattern rather than paging.
- .git and node_modules are skipped unless your pattern names them.
- Use this to find files by name. To search file CONTENTS use grep.
- When you are exploring, run several globs in parallel in one step.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    if (args.path !== undefined && !isAbsolute(args.path)) {
      return {
        title: "glob failed",
        output: `Error: path must be absolute, got ${JSON.stringify(args.path)}.`,
      }
    }

    const root = args.path ? resolve(args.path) : ctx.cwd

    try {
      const glob = new Bun.Glob(args.pattern)
      const found: string[] = []
      for await (const entry of glob.scan({ cwd: root, onlyFiles: true })) {
        if (isNoisePath(entry, args.pattern)) continue
        found.push(join(root, entry))
      }

      if (found.length === 0) {
        return {
          title: `glob ${args.pattern}`,
          output:
            `No files matched ${args.pattern} under ${root}. ` +
            `Patterns are matched against the whole relative path, so a bare ` +
            `"*.ts" only matches the top level — use "**/*.ts" to search ` +
            `subdirectories. To search file CONTENTS instead, use grep.`,
          metadata: { pattern: args.pattern, root, count: 0 },
        }
      }

      // Sort by mtime desc; unreadable entries sort last rather than failing.
      const withTime = await Promise.all(
        found.map(async (path) => {
          let mtime = 0
          try {
            mtime = Bun.file(path).lastModified
          } catch {
            mtime = 0
          }
          return { path, mtime }
        }),
      )
      withTime.sort((a, b) => b.mtime - a.mtime)

      const shown = withTime.slice(0, LIMIT).map((entry) => entry.path)
      const truncated = withTime.length > LIMIT

      const notes = truncated
        ? `\n\n[Showing ${LIMIT} of ${withTime.length} matches. Narrow the pattern to see the rest.]`
        : ""

      return {
        title: `glob ${args.pattern} (${withTime.length})`,
        output: shown.join("\n") + notes,
        metadata: {
          pattern: args.pattern,
          root,
          count: withTime.length,
          truncated,
        },
      }
    } catch (error) {
      return {
        title: `glob ${args.pattern}`,
        output: `Error globbing ${args.pattern}: ${errorText(error)}`,
      }
    }
  },
}
