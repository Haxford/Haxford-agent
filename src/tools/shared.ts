import { dirname, isAbsolute, join, resolve } from "node:path"

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

/**
 * Parse a .gitignore file into a list of ignore patterns.
 *
 * Each pattern is { pattern, negate } — a negation starts with `!`. Lines
 * that are blank or start with `#` are dropped. Trailing whitespace is
 * stripped. This is a pragmatic subset of gitignore syntax: it handles the
 * common patterns (directory, glob, negation) without the full spec.
 */
export interface IgnorePattern {
  pattern: string
  negate: boolean
}

export function parseGitignore(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    if (line.startsWith("!")) {
      out.push({ pattern: line.slice(1), negate: true })
    } else {
      out.push({ pattern: line, negate: false })
    }
  }
  return out
}

/**
 * Read .gitignore files walking up from `root` to the filesystem root,
 * accumulating all ignore patterns with the closest .gitignore first.
 * Returns an empty array when no .gitignore is found. Never throws.
 */
export async function readGitignores(root: string): Promise<IgnorePattern[]> {
  const patterns: IgnorePattern[] = []
  let dir = resolve(root)
  const seen = new Set<string>()
  while (true) {
    const gitignore = join(dir, ".gitignore")
    try {
      const file = Bun.file(gitignore)
      if (await file.exists()) {
        const text = await file.text()
        patterns.push(...parseGitignore(text))
      }
    } catch {
      // unreadable — skip
    }
    seen.add(dir)
    const parent = dirname(dir)
    if (parent === dir || seen.has(parent)) break
    dir = parent
  }
  return patterns
}

/**
 * Convert a gitignore glob pattern to a RegExp.
 *
 * - `*` matches within a path segment (`[^/]*`)
 * - `**` matches across segments (`.*`)
 * - `?` matches one non-slash char
 * - everything else is literal (escaped)
 */
function globToRegex(pattern: string): RegExp {
  let regex = "^"
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*"
        i += 2
        if (pattern[i] === "/") i++
      } else {
        regex += "[^/]*"
        i++
      }
    } else if (c === "?") {
      regex += "[^/]"
      i++
    } else if (/[.+^${}()|[\]\\]/.test(c ?? "")) {
      regex += "\\" + (c ?? "")
      i++
    } else {
      regex += c ?? ""
      i++
    }
  }
  regex += "$"
  try {
    return new RegExp(regex)
  } catch {
    return /(?:)/
  }
}

/**
 * Match a relative path against a gitignore pattern.
 *
 * A gitignore pattern without a slash matches any path segment at any depth.
 * A pattern with a slash is matched against the full relative path (anchored).
 * A trailing slash means directory-only. A leading slash anchors to root.
 */
function gitignoreMatch(relativePath: string, pattern: string): boolean {
  let p = pattern
  const path = relativePath.replace(/\/$/, "")

  // Trailing slash → the pattern targets a directory; match any path under it.
  if (p.endsWith("/")) {
    const dir = p.slice(0, -1)
    if (dir.startsWith("/")) {
      const anchored = dir.slice(1)
      return path === anchored || path.startsWith(anchored + "/")
    }
    if (dir.includes("/")) {
      const re = globToRegex(dir)
      return re.test(path) || path.startsWith(dir + "/")
    }
    // Bare directory name → the path must be under a matching segment.
    // `build` (no slash) should NOT match pattern `build/`, but
    // `build/output.ts` SHOULD — the segment must be a prefix, not the leaf.
    const segments = path.split("/")
    for (let s = 0; s < segments.length - 1; s++) {
      if (segments[s] === dir || globToRegex(dir).test(segments[s]!)) return true
    }
    return false
  }

  // Leading slash → anchored to root.
  if (p.startsWith("/")) {
    p = p.slice(1)
    return globToRegex(p).test(path)
  }

  // No slash → match any segment OR the full path.
  if (!p.includes("/")) {
    const re = globToRegex(p)
    const segments = path.split("/")
    if (segments.some((seg) => re.test(seg))) return true
    return re.test(path)
  }

  // Pattern with a slash → match against full path (possibly at any depth).
  const re = globToRegex(p)
  if (re.test(path)) return true
  // Also match if any sub-path starting at a segment boundary matches.
  const segments = path.split("/")
  for (let start = 1; start < segments.length; start++) {
    if (re.test(segments.slice(start).join("/"))) return true
  }
  return false
}

/**
 * Check whether a relative path should be ignored given a set of gitignore
 * patterns. Later patterns override earlier ones (a negation un-ignores).
 */
export function isIgnored(relativePath: string, patterns: IgnorePattern[]): boolean {
  let ignored = false
  for (const { pattern, negate } of patterns) {
    if (gitignoreMatch(relativePath, pattern)) {
      ignored = !negate
    }
  }
  return ignored
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return String(error)
}
