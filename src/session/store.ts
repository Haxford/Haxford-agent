import { appendFile } from "node:fs/promises"
import { readdirSync } from "node:fs"
import path from "node:path"

import type { Message, Part } from "../types/message.ts"
import type { SessionInfo } from "../types/session.ts"
import {
  ensureDir,
  sessionFile,
  sessionMetaFile,
  sessionsDir,
} from "./paths.ts"

/** Current epoch milliseconds. */
function now(): number {
  return Date.now()
}

/** Serialize a value as a single JSONL line (no trailing newline in the value). */
function toLine(value: unknown): string {
  return JSON.stringify(value)
}

// Appends are serialized per-file via a promise queue to guarantee ordering
// across rapid concurrent appends. Each append is a single O(1) `appendFile`
// call rather than a read-modify-write of the whole transcript.
const appendQueues = new Map<string, Promise<void>>()

function queuedAppend(file: string, value: unknown): Promise<void> {
  const prev = appendQueues.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    const line = toLine(value) + "\n"
    await appendFile(file, line, "utf8")
  })
  appendQueues.set(file, next.catch(() => {}))
  return next
}

/** Create a brand new session for a project directory. */
export async function createSession(
  directory: string,
  title?: string,
): Promise<SessionInfo> {
  const id = crypto.randomUUID()
  const ts = now()
  const info: SessionInfo = {
    id,
    title: title ?? "Untitled session",
    directory: path.resolve(directory),
    time: { created: ts, updated: ts },
  }
  ensureDir(sessionsDir(directory))
  await writeMeta(directory, info)
  // Touch the (possibly empty) transcript file.
  await Bun.write(sessionFile(directory, id), "")
  return info
}

/** Persist/refresh a session's metadata file. */
export async function updateSessionInfo(
  directory: string,
  info: SessionInfo,
): Promise<void> {
  await writeMeta(directory, info)
}

async function writeMeta(directory: string, info: SessionInfo): Promise<void> {
  ensureDir(sessionsDir(directory))
  await Bun.write(sessionMetaFile(directory, info.id), toLine(info))
}

/** Append a message snapshot to the session transcript. */
export async function appendMessage(
  directory: string,
  sessionID: string,
  message: Message,
): Promise<void> {
  const file = sessionFile(directory, sessionID)
  ensureDir(sessionsDir(directory))
  await queuedAppend(file, message)
  // Best-effort: bump the session's updated time. A failure here (e.g. a
  // corrupt or missing meta) must not poison a successful transcript write.
  try {
    const existing = await getSession(directory, sessionID)
    if (existing !== undefined) {
      existing.time.updated = now()
      await writeMeta(directory, existing)
    }
  } catch {
    // ignore — the message is already persisted.
  }
}

/** Read a session's metadata, or undefined if it does not exist or is corrupt. */
export async function getSession(
  directory: string,
  sessionID: string,
): Promise<SessionInfo | undefined> {
  let metaPath: string
  try {
    metaPath = sessionMetaFile(directory, sessionID)
  } catch {
    // An id that is not a name (a traversal attempt from `-s`) names no
    // session, which is exactly what "not found" means to every caller.
    return undefined
  }
  const file = Bun.file(metaPath)
  if (!(await file.exists())) return undefined
  try {
    return (await file.json()) as SessionInfo
  } catch {
    // Corrupt meta — treat as absent so callers (appendMessage, fork) skip it
    // rather than throwing after a transcript write already succeeded.
    return undefined
  }
}

/** List all sessions for a project, sorted by time.updated descending. */
export async function listSessions(
  directory: string,
): Promise<SessionInfo[]> {
  const dir = sessionsDir(directory)
  ensureDir(dir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const metas = names.filter((n) => n.endsWith(".meta.json"))
  const infos: SessionInfo[] = []
  for (const name of metas) {
    const file = Bun.file(path.join(dir, name))
    if (!(await file.exists())) continue
    try {
      infos.push((await file.json()) as SessionInfo)
    } catch {
      // Corrupt meta — skip.
    }
  }
  infos.sort((a, b) => b.time.updated - a.time.updated)
  return infos
}

/**
 * Replay a session transcript, deduplicating by message id and keeping the
 * last-written version of each. Preserves original insertion order of first
 * appearance.
 */
export async function loadHistory(
  directory: string,
  sessionID: string,
): Promise<Message[]> {
  const file = Bun.file(sessionFile(directory, sessionID))
  if (!(await file.exists())) return []
  const text = await file.text()
  if (text.length === 0) return []

  const byId = new Map<string, Message>()
  const order: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue
    }
    const msg = parsed as Message
    if (typeof msg.id !== "string") continue
    // A record with no parts array is a half-written or hand-edited line.
    // Every consumer maps over `parts` — `forkSession` does it directly —
    // so admitting one turns a corrupt transcript into a crash on resume.
    if (!Array.isArray(msg.parts)) continue
    if (!byId.has(msg.id)) order.push(msg.id)
    byId.set(msg.id, msg)
  }
  const out: Message[] = []
  for (const id of order) {
    const m = byId.get(id)
    if (m !== undefined) out.push(m)
  }
  return out
}

/** Fork a session: copy transcript + meta under a new id, rewriting records. */
export async function forkSession(
  directory: string,
  sessionID: string,
): Promise<SessionInfo> {
  const original = await getSession(directory, sessionID)
  if (original === undefined) {
    throw new Error(`forkSession: session ${sessionID} not found`)
  }

  const newID = crypto.randomUUID()
  const ts = now()

  const history = await loadHistory(directory, sessionID)
  const rewritten: Message[] = history.map((m) => ({
    ...m,
    sessionID: newID,
    // Preserve part identity but give the message a fresh lifecycle.
    parts: m.parts.map((p: Part): Part => ({ ...p })),
  }))

  ensureDir(sessionsDir(directory))
  const file = sessionFile(directory, newID)
  if (rewritten.length > 0) {
    const body = rewritten.map((m) => toLine(m)).join("\n") + "\n"
    await Bun.write(file, body)
  } else {
    await Bun.write(file, "")
  }

  const forked: SessionInfo = {
    ...original,
    id: newID,
    title: `${original.title} (fork)`,
    time: { created: ts, updated: ts },
  }
  await writeMeta(directory, forked)
  return forked
}

// Re-export path helpers for convenience.
export {
  dataRoot,
  projectDir,
  projectSlug,
  sessionFile as sessionFilePath,
  sessionMetaFile as sessionMetaPath,
  sessionsDir as sessionsDirPath,
  todosFile as todosFilePath,
} from "./paths.ts"
