import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Resolve the haxford data root directory.
 *
 * Priority:
 *   1. HAXFORD_DATA_DIR env var
 *   2. $XDG_DATA_HOME/haxford
 *   3. ~/.local/share/haxford
 */
export function dataRoot(): string {
  const env = process.env["HAXFORD_DATA_DIR"]
  if (env && env.length > 0) return path.resolve(env)

  const xdg = process.env["XDG_DATA_HOME"]
  if (xdg && xdg.length > 0) return path.resolve(path.join(xdg, "haxford"))

  return path.resolve(path.join(homedir(), ".local", "share", "haxford"))
}

/** Encode a project directory path into a filesystem-safe base64url slug. */
export function projectSlug(directory: string): string {
  return Buffer.from(path.resolve(directory), "utf8").toString("base64url")
}

/** Per-project directory: <dataRoot>/projects/<base64url(directory)> */
export function projectDir(directory: string): string {
  return path.join(dataRoot(), "projects", projectSlug(directory))
}

/** Sessions directory for a project: <projectDir>/sessions */
export function sessionsDir(directory: string): string {
  return path.join(projectDir(directory), "sessions")
}

/**
 * Reject a session id that would escape the sessions directory.
 *
 * Every session path is built by interpolating an id into a filename, so an
 * id containing a separator is not a name — it is a path. `-s ../../../../x`
 * would make `getSession` read outside the data root, and the id inside a
 * meta file it finds there is trusted for every subsequent write, so a
 * transcript could be appended anywhere the user can write.
 *
 * Ids are generated with `crypto.randomUUID` and subagents suffix them with
 * `:sub:<uuid>`, so nothing legitimate contains a separator. A caller passing
 * one is a bug or an attack; both should stop here rather than reach the
 * filesystem.
 */
function safeSessionID(sessionID: string): string {
  const id = sessionID.trim()
  if (
    id === "" ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id === ".." ||
    id.startsWith("../") ||
    id.startsWith("..")
  ) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionID)}`)
  }
  return id
}

/** Path to a session's JSONL transcript: <sessionsDir>/<id>.jsonl */
export function sessionFile(directory: string, sessionID: string): string {
  return path.join(sessionsDir(directory), `${safeSessionID(sessionID)}.jsonl`)
}

/** Path to a session's metadata file: <sessionsDir>/<id>.meta.json */
export function sessionMetaFile(directory: string, sessionID: string): string {
  return path.join(sessionsDir(directory), `${safeSessionID(sessionID)}.meta.json`)
}

/** Path to a session's todo list: <sessionsDir>/<id>.todos.json */
export function todosFile(directory: string, sessionID: string): string {
  return path.join(sessionsDir(directory), `${safeSessionID(sessionID)}.todos.json`)
}

/** Ensure a directory exists (and parents), creating on demand. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
