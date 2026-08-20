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
