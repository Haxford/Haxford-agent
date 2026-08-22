import { isAbsolute, resolve } from "node:path"

/**
 * Files the model has read, per session. `write` (on an existing file) and
 * `edit` require a prior read so the model never clobbers content it has not
 * seen. Keyed by session so concurrent sessions never share state.
 */
const readPaths = new Map<string, Set<string>>()

export function recordRead(sessionID: string, path: string): void {
  let paths = readPaths.get(sessionID)
  if (!paths) {
    paths = new Set()
    readPaths.set(sessionID, paths)
  }
  paths.add(resolve(path))
}

export function hasRead(sessionID: string, path: string): boolean {
  return readPaths.get(sessionID)?.has(resolve(path)) ?? false
}

/** Drop a session's read tracking (session end / fork). */
export function forgetReads(sessionID: string): void {
  readPaths.delete(sessionID)
}

/** Thrown-free path validation: returns an error string, or null when valid. */
export function checkAbsolute(filePath: string): string | null {
  if (!filePath.trim()) return "filePath is empty. Provide an absolute path."
  if (!isAbsolute(filePath)) {
    return (
      `filePath must be an absolute path, got ${JSON.stringify(filePath)}. ` +
      `Prefix it with the working directory.`
    )
  }
  return null
}

/** A file is treated as binary if a NUL byte appears in its first bytes. */
export async function looksBinary(path: string): Promise<boolean> {
  const bytes = new Uint8Array(
    await Bun.file(path).slice(0, 4096).arrayBuffer(),
  )
  return bytes.includes(0)
}

export interface Truncation {
  text: string
  truncated: boolean
}

/** Clamp text to `max` characters, reporting whether anything was dropped. */
export function truncateText(text: string, max: number): Truncation {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

export interface TailTruncation {
  text: string
  truncated: boolean
  /** Which limit bit first, or null when nothing was dropped. */
  truncatedBy: "lines" | "chars" | null
  totalChars: number
  totalLines: number
  /** Lines actually present in `text`. */
  shownLines: number
}

export interface TailLimits {
  maxChars: number
  maxLines: number
}

/** Count lines the way a reader would: a trailing newline ends the last line. */
function countLines(text: string): number {
  if (text === "") return 0
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines++
  // A trailing newline closes the final line rather than opening a new one.
  return text.endsWith("\n") ? lines - 1 : lines
}

/**
 * Keep the END of a long output rather than the start.
 *
 * Program output puts what matters last: the failing assertion, the stack
 * trace, the exit summary. Keeping the head and dropping the tail — which is
 * what a plain `slice(0, max)` does — throws away exactly the part the model
 * needs and leaves it the build spam it does not.
 *
 * Both limits apply; whichever bites first is reported. When the character
 * limit cuts mid-line the partial leading line is dropped, so the result
 * always starts at a line boundary.
 */
export function truncateTail(text: string, limits: TailLimits): TailTruncation {
  const totalChars = text.length
  const totalLines = countLines(text)

  if (totalChars <= limits.maxChars && totalLines <= limits.maxLines) {
    return {
      text,
      truncated: false,
      truncatedBy: null,
      totalChars,
      totalLines,
      shownLines: totalLines,
    }
  }

  let out = text
  let truncatedBy: "lines" | "chars" = "lines"

  if (totalLines > limits.maxLines) {
    const lines = text.split("\n")
    // Drop the trailing empty element a final newline produces before slicing,
    // so `maxLines` counts real lines.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    out = lines.slice(-limits.maxLines).join("\n")
  }

  if (out.length > limits.maxChars) {
    truncatedBy = "chars"
    out = out.slice(out.length - limits.maxChars)
    // The slice almost certainly landed mid-line; drop that fragment.
    const firstBreak = out.indexOf("\n")
    if (firstBreak !== -1) out = out.slice(firstBreak + 1)
  }

  return {
    text: out,
    truncated: true,
    truncatedBy,
    totalChars,
    totalLines,
    shownLines: countLines(out),
  }
}

/** Directories that would otherwise flood glob/grep results. */
const NOISE = [".git", "node_modules"]

/**
 * Skip noisy directories unless the caller's pattern explicitly names them,
 * so `**\/node_modules/**` still works while `**\/*.ts` stays useful.
 */
export function isNoisePath(path: string, pattern: string): boolean {
  return NOISE.some(
    (dir) => !pattern.includes(dir) && path.split("/").includes(dir),
  )
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return String(error)
}
