import { describe, expect, test } from "bun:test"

import type { Message } from "../src/types/message.ts"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"

function userMsg(id: string, text: string): Message {
  return {
    id,
    sessionID: "s",
    role: "user",
    parts: [{ id: `${id}-p`, type: "text", text }],
    time: { created: 1 },
  }
}

describe("TuiStore", () => {
  test("getState returns a snapshot seeded by initial messages (cloned)", () => {
    const seed = [userMsg("u1", "hi")]
    const store = createTuiStore(seed)
    const s = store.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.id).toBe("u1")
    // Mutating the seed after construction does not affect the store.
    seed[0]!.parts.push({ id: "x", type: "text", text: "extra" })
    expect(store.getState().messages[0]?.parts).toHaveLength(1)
  })

  test("getState is stable until a dispatch changes state", () => {
    const store = createTuiStore([])
    const a = store.getState()
    const b = store.getState()
    expect(a).toBe(b) // same reference
    store.dispatch({ type: "turn.start", turn: 1 })
    const c = store.getState()
    expect(c).not.toBe(a)
  })

  test("dispatch with a no-op event does not change the snapshot reference", () => {
    const store = createTuiStore([])
    store.dispatch({ type: "turn.start", turn: 1 })
    const before = store.getState()
    // part.delta for an unknown message is a no-op in the reducer.
    store.dispatch({ type: "part.delta", messageID: "ghost", partID: "x", delta: "nope" })
    expect(store.getState()).toBe(before)
  })

  test("dispatch applies events in order", () => {
    const store = createTuiStore([])
    store.dispatch({ type: "message.updated", message: userMsg("m1", "hello") })
    store.dispatch({ type: "message.updated", message: userMsg("m2", "world") })
    const s = store.getState()
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]?.id).toBe("m1")
    expect(s.messages[1]?.id).toBe("m2")
  })

  test("subscribe fires on dispatch that changes state", () => {
    const store = createTuiStore([])
    let calls = 0
    const unsub = store.subscribe(() => calls++)
    store.dispatch({ type: "turn.start", turn: 1 })
    expect(calls).toBe(1)
    store.dispatch({ type: "turn.end", turn: 1 })
    expect(calls).toBe(2)
    unsub()
  })

  test("subscribe does not fire on no-op dispatch", () => {
    const store = createTuiStore([])
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch({ type: "part.delta", messageID: "ghost", partID: "x", delta: "nope" })
    expect(calls).toBe(0)
  })

  test("unsubscribe stops notifications", () => {
    const store = createTuiStore([])
    let calls = 0
    const unsub = store.subscribe(() => calls++)
    unsub()
    store.dispatch({ type: "turn.start", turn: 1 })
    expect(calls).toBe(0)
  })

  test("multiple subscribers all fire", () => {
    const store = createTuiStore([])
    let a = 0, b = 0
    const u1 = store.subscribe(() => a++)
    const u2 = store.subscribe(() => b++)
    store.dispatch({ type: "notice", message: "hi" })
    expect(a).toBe(1)
    expect(b).toBe(1)
    u1()
    u2()
  })

  test("reset replaces messages and clears notices/usage/turn", () => {
    const store = createTuiStore([])
    store.dispatch({ type: "turn.start", turn: 3 })
    store.dispatch({ type: "notice", message: "old notice" })
    store.dispatch({ type: "usage", messageID: "x", usage: { input: 10, output: 5 } })
    store.dispatch({ type: "message.updated", message: userMsg("old", "bye") })

    store.reset([userMsg("new1", "fresh"), userMsg("new2", "also fresh")])

    const s = store.getState()
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]?.id).toBe("new1")
    expect(s.messages[1]?.id).toBe("new2")
    expect(s.turn).toBe(0)
    expect(s.usage).toEqual({ input: 0, output: 0, reasoning: 0 })
    expect(s.notices).toEqual([])
    expect(s.status).toBe("idle")
  })

  test("reset to empty array is a clean slate", () => {
    const store = createTuiStore([userMsg("seed", "x")])
    store.dispatch({ type: "notice", message: "n" })
    store.reset([])
    const s = store.getState()
    expect(s.messages).toHaveLength(0)
    expect(s.notices).toEqual([])
  })

  test("reset notifies subscribers", () => {
    const store = createTuiStore([])
    let calls = 0
    store.subscribe(() => calls++)
    store.reset([userMsg("r", "x")])
    expect(calls).toBe(1)
    expect(store.getState().messages[0]?.id).toBe("r")
  })

  test("reset clones the input array (no aliasing)", () => {
    const seed = [userMsg("a", "x")]
    const store = createTuiStore([])
    store.reset(seed)
    seed[0]!.parts.push({ id: "extra", type: "text", text: "!" })
    expect(store.getState().messages[0]?.parts).toHaveLength(1)
  })

  test("notice events accumulate through dispatch", () => {
    const store = createTuiStore([])
    store.dispatch({ type: "notice", message: "first" })
    store.dispatch({ type: "notice", message: "second" })
    const s = store.getState()
    expect(s.notices).toEqual(["first", "second"])
  })

  test("store type is exported and constructable", () => {
    const s: TuiStore = createTuiStore([])
    expect(typeof s.getState).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.reset).toBe("function")
    expect(typeof s.subscribe).toBe("function")
  })
})
