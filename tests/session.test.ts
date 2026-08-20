import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Message } from "../src/types/message.ts"
import {
  appendMessage,
  createSession,
  forkSession,
  getSession,
  listSessions,
  loadHistory,
  updateSessionInfo,
} from "../src/session/store.ts"

let dataDir: string
let directory: string

function msg(
  sessionID: string,
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): Message {
  return {
    id,
    sessionID,
    role,
    parts: [{ id: `${id}-p`, type: "text", text }],
    time: { created: Date.now() },
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "haxford-test-"))
  process.env["HAXFORD_DATA_DIR"] = dataDir
  directory = mkdtempSync(path.join(tmpdir(), "haxford-project-"))
})

afterEach(() => {
  delete process.env["HAXFORD_DATA_DIR"]
})

describe("session store", () => {
  test("createSession writes meta and returns SessionInfo", async () => {
    const info = await createSession(directory, "My session")
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(info.title).toBe("My session")
    expect(info.directory).toBe(path.resolve(directory))
    expect(info.time.created).toBe(info.time.updated)

    const got = await getSession(directory, info.id)
    expect(got).toBeDefined()
    expect(got?.id).toBe(info.id)
    expect(got?.title).toBe("My session")
  })

  test("getSession returns undefined for missing id", async () => {
    expect(await getSession(directory, "nope")).toBeUndefined()
  })

  test("appendMessage + loadHistory roundtrip", async () => {
    const info = await createSession(directory)
    await appendMessage(directory, info.id, msg(info.id, "m1", "hello"))
    await appendMessage(directory, info.id, msg(info.id, "m2", "world", "assistant"))

    const history = await loadHistory(directory, info.id)
    expect(history).toHaveLength(2)
    expect(history[0]?.id).toBe("m1")
    expect(history[0]?.parts[0]?.type).toBe("text")
    expect((history[0]?.parts[0] as { text: string }).text).toBe("hello")
    expect(history[1]?.id).toBe("m2")
    expect(history[1]?.role).toBe("assistant")
  })

  test("dedupe by message id keeps last version", async () => {
    const info = await createSession(directory)
    await appendMessage(directory, info.id, msg(info.id, "dup", "first"))
    await appendMessage(directory, info.id, msg(info.id, "dup", "second"))
    await appendMessage(directory, info.id, msg(info.id, "dup", "third"))

    const history = await loadHistory(directory, info.id)
    expect(history).toHaveLength(1)
    const m = history[0]
    expect(m?.id).toBe("dup")
    expect((m?.parts[0] as { text: string }).text).toBe("third")
  })

  test("loadHistory on missing session returns []", async () => {
    expect(await loadHistory(directory, "missing")).toEqual([])
  })

  test("forkSession creates new id with same content", async () => {
    const info = await createSession(directory, "origin")
    await appendMessage(directory, info.id, msg(info.id, "a", "alpha"))
    await appendMessage(directory, info.id, msg(info.id, "b", "beta", "assistant"))

    const fork = await forkSession(directory, info.id)
    expect(fork.id).not.toBe(info.id)
    expect(fork.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fork.title).toContain("fork")
    expect(fork.directory).toBe(info.directory)
    expect(fork.time.created).toBeGreaterThanOrEqual(info.time.created)

    const forkMeta = await getSession(directory, fork.id)
    expect(forkMeta).toBeDefined()
    expect(forkMeta?.id).toBe(fork.id)

    const forkHistory = await loadHistory(directory, fork.id)
    expect(forkHistory).toHaveLength(2)
    // ids preserved, but sessionID rewritten.
    expect(forkHistory[0]?.id).toBe("a")
    expect(forkHistory[0]?.sessionID).toBe(fork.id)
    expect(forkHistory[1]?.id).toBe("b")
    expect(forkHistory[1]?.sessionID).toBe(fork.id)

    // Original untouched.
    const origHistory = await loadHistory(directory, info.id)
    expect(origHistory).toHaveLength(2)
    expect(origHistory[0]?.sessionID).toBe(info.id)
  })

  test("listSessions sorted by time.updated descending", async () => {
    const a = await createSession(directory, "a")
    // Force distinct updated timestamps.
    a.time.updated = 1000
    await updateSessionInfo(directory, a)

    const b = await createSession(directory, "b")
    b.time.updated = 3000
    await updateSessionInfo(directory, b)

    const c = await createSession(directory, "c")
    c.time.updated = 2000
    await updateSessionInfo(directory, c)

    const list = await listSessions(directory)
    expect(list).toHaveLength(3)
    expect(list[0]?.id).toBe(b.id)
    expect(list[1]?.id).toBe(c.id)
    expect(list[2]?.id).toBe(a.id)
  })

  test("appendMessage bumps session updated time", async () => {
    const info = await createSession(directory)
    const before = info.time.updated
    // ensure clock advances
    await new Promise((r) => setTimeout(r, 5))
    await appendMessage(directory, info.id, msg(info.id, "x", "hi"))
    const after = await getSession(directory, info.id)
    expect(after?.time.updated).toBeGreaterThanOrEqual(before)
  })

  test("updateSessionInfo persists changes", async () => {
    const info = await createSession(directory, "orig")
    info.title = "renamed"
    info.tokens = { input: 10, output: 20 }
    info.cost = 0.5
    await updateSessionInfo(directory, info)

    const got = await getSession(directory, info.id)
    expect(got?.title).toBe("renamed")
    expect(got?.tokens).toEqual({ input: 10, output: 20 })
    expect(got?.cost).toBe(0.5)
  })
})
