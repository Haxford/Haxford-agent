import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { redactSecrets } from "../config/secrets.ts"
import { errorText, isIgnored, looksBinary, readGitignores } from "./shared.ts"

const LIMIT = 100
const MAX_LINE_CHARS = 500
const MAX_FILE_BYTES = 2_000_000

const parameters = z.object({
  pattern: z.string().describe("Regular expression to search file contents for."),
  path: z
    .string()
    .optional()
    .describe("Absolute directory to search in. Defaults to the working directory."),
  include: z
    .string()
    .optional()
    .describe('Glob filter for which files to search, e.g. "*.ts" or "**/*.{js,ts}".'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum matches to return. Defaults to ${LIMIT}.`),
})

type Args = z.infer<typeof parameters>

interface Match {
  path: string
  line: number
  text: string
}

function clampLine(text: string): string {
  const trimmed = text.trimEnd()
  return trimmed.length > MAX_LINE_CHARS
    ? `${trimmed.slice(0, MAX_LINE_CHARS)}… [truncated]`
    : trimmed
}

/** Search with ripgrep. Returns null when rg is unavailable or errored. */
async function ripgrep(
  pattern: string,
  root: string,
  include: string | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<Match[] | null> {
  if (!Bun.which("rg")) return null

  const cmd = [
    "rg",
    "--line-number",
    "--no-heading",
    "--color=never",
    // Ask for one extra match: some rg builds cap --max-count globally
    // instead of per-file, which would hide truncation from us otherwise.
    // Truncation is detected by matches.length > limit downstream.
    "--max-count",
    String(limit + 1),
  ]
  if (include) cmd.push("--glob", include)
  cmd.push("-e", pattern, root)

  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const kill = () => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }
    signal.addEventListener("abort", kill, { once: true })
    let stdout: string
    let exitCode: number
    try {
      ;[stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
    } finally {
      signal.removeEventListener("abort", kill)
    }

    // 0 = matches, 1 = no matches. Anything else: fall back.
    if (exitCode !== 0 && exitCode !== 1) return null

    const matches: Match[] = []
    for (const raw of stdout.split("\n")) {
      if (!raw) continue
      // path:line:content — the path may itself contain colons.
      const first = raw.indexOf(":")
      if (first === -1) continue
      const second = raw.indexOf(":", first + 1)
      if (second === -1) continue
      const line = Number(raw.slice(first + 1, second))
      if (!Number.isFinite(line)) continue
      matches.push({
        path: raw.slice(0, first),
        line,
        text: clampLine(raw.slice(second + 1)),
      })
    }
    return matches
  } catch {
    return null
  }
}

/**
 * Match ripgrep's --glob semantics: a pattern with no slash matches a
 * basename at any depth, so "*.ts" finds src/deep/a.ts and not just ./a.ts.
 */
function includeToGlob(include: string | undefined): string {
  if (!include) return "**/*"
  return include.includes("/") ? include : `**/${include}`
}

/** Fallback scan when ripgrep is not installed. */
async function scanFiles(
  regex: RegExp,
  root: string,
  include: string | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<Match[]> {
  const pattern = includeToGlob(include)
  const glob = new Bun.Glob(pattern)
  // Collect one extra match beyond the limit so the caller can tell
  // "there were more" from "exactly this many" when it truncates.
  const cap = limit + 1
  const matches: Match[] = []
  const ignorePatterns = await readGitignores(root)
  const alwaysIgnore = [".git", "node_modules"]

  for await (const entry of glob.scan({ cwd: root, onlyFiles: true })) {
    if (signal.aborted) break
    if (matches.length >= cap) break
    const segments = entry.split("/")
    if (alwaysIgnore.some((dir) => segments.includes(dir))) continue
    if (ignorePatterns.length > 0 && isIgnored(entry, ignorePatterns)) continue

    const path = join(root, entry)
    try {
      const file = Bun.file(path)
      if (file.size > MAX_FILE_BYTES) continue
      if (await looksBinary(path)) continue

      const lines = (await file.text()).split("\n")
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]
        if (text === undefined) continue
        // Reset between lines so a /g pattern cannot skip matches.
        regex.lastIndex = 0
        if (!regex.test(text)) continue
        matches.push({ path, line: i + 1, text: clampLine(text) })
        if (matches.length >= cap) break
      }
    } catch {
      // Unreadable file — skip it rather than failing the whole search.
    }
  }

  return matches
}

export const grepTool: Tool<Args> = {
  id: "grep",
  description: `Search file contents with a regular expression.

Usage:
- pattern is a regular expression, e.g. "function\\s+\\w+", "TODO|FIXME",
  "import .* from \\"react\\"". Escape characters that are special in regex.
- include filters which files are searched by glob, e.g. "*.ts". Without it,
  every text file under the search directory is searched.
- path, if given, MUST be absolute; it defaults to the working directory.
- Output is one match per line as file:line: content. Long lines are clipped.
- At most ${LIMIT} matches are returned by default; the output says so when it
  truncates and tells you the limit to pass for more. Prefer tightening the
  pattern or the include filter over raising the limit.
- Binary files, .git, and node_modules are skipped. .gitignore'd files are
  skipped — where ripgrep is available it respects .gitignore natively; the
  fallback scan reads the nearest .gitignore files.
- Use this to search contents. To find files by NAME use glob.
- Run several greps in parallel when you are exploring a codebase.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    if (args.path !== undefined && !isAbsolute(args.path)) {
      return {
        title: "grep failed",
        output: `Error: path must be absolute, got ${JSON.stringify(args.path)}.`,
      }
    }

    let regex: RegExp
    try {
      regex = new RegExp(args.pattern)
    } catch (error) {
      return {
        title: "grep failed",
        output: `Error: invalid regular expression ${JSON.stringify(args.pattern)}: ${errorText(error)}`,
      }
    }

    const root = args.path ? resolve(args.path) : ctx.cwd
    const limit = args.limit ?? LIMIT

    try {
      const viaRg = await ripgrep(args.pattern, root, args.include, limit, ctx.abort)
      const engine = viaRg ? "ripgrep" : "fallback"
      const matches =
        viaRg ?? (await scanFiles(regex, root, args.include, limit, ctx.abort))

      if (matches.length === 0) {
        return {
          title: `grep ${args.pattern} (0)`,
          output: `No matches for ${args.pattern} under ${root}${
            args.include ? ` (include: ${args.include})` : ""
          }.`,
          metadata: { pattern: args.pattern, root, count: 0, engine },
        }
      }

      const shown = matches.slice(0, limit)
      // Matched lines are file contents: a grep for "key" across a config
      // directory would otherwise put live credentials into the model's
      // context and the session JSONL. Masked once over the whole body.
      const body = redactSecrets(
        shown.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n"),
      )
      const truncated = matches.length > limit
      const notes = truncated
        ? `\n\n[Showing the first ${limit} matches. ` +
          `Use limit=${limit * 2} for more, or narrow the pattern or include filter.]`
        : ""

      return {
        title: `grep ${args.pattern} (${shown.length})`,
        output: body + notes,
        metadata: {
          pattern: args.pattern,
          root,
          count: shown.length,
          limit,
          truncated,
          engine,
        },
      }
    } catch (error) {
      return {
        title: `grep ${args.pattern}`,
        output: `Error searching for ${args.pattern}: ${errorText(error)}`,
      }
    }
  },
}
