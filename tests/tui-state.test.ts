import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "../src/types/events.ts"
import type { Message } from "../src/types/message.ts"
import { fromMessages, initialTuiState, reduce, reduceAll } from "../src/tui/state.ts"

function userMsg(id: string, text: string): Message {
  return {
    id,
    sessionID: "s",
    role: "user",
    parts: [{ id: `${id}-p`, type: "text", text }],
    time: { created: 1 },
  }
}

function asstMsg(id: string, text = ""): Message {
  return {
    id,
    sessionID: "s",
    role: "assistant",
    model: "mock/m",
    parts: [{ id: `${id}-p`, type: "text", text }],
    time: { created: 2 },
  }
}

function msgEvent(m: Message): AgentEvent {
  return { type: "message.updated", message: m }
}

describe("tui reducer", () => {
  test("message.updated inserts in order, replaces by id", () => {
    let s = reduce(initialTuiState, msgEvent(userMsg("u1", "hi")))
    s = reduce(s, msgEvent(userMsg("u2", "there")))
    s = reduce(s, msgEvent(userMsg("u1", "hi (edited)")))

    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]?.id).toBe("u1")
    expect(s.messages[1]?.id).toBe("u2")
    expect((s.messages[0]?.parts[0] as { text: string }).text).toBe("hi (edited)")
  })

  test("part.delta accumulates onto a text part", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a1")))
    s = reduce(s, { type: "part.delta", messageID: "a1", partID: "a1-p", delta: "Hello" })
    s = reduce(s, { type: "part.delta", messageID: "a1", partID: "a1-p", delta: " world" })

    const part = s.messages[0]?.parts[0]
    expect(part?.type).toBe("text")
    expect((part as { text: string }).text).toBe("Hello world")
  })

  test("part.delta with newline preserves newlines", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a2")))
    s = reduce(s, { type: "part.delta", messageID: "a2", partID: "a2-p", delta: "line1\n" })
    s = reduce(s, { type: "part.delta", messageID: "a2", partID: "a2-p", delta: "line2" })
    expect((s.messages[0]?.parts[0] as { text: string }).text).toBe("line1\nline2")
  })

  test("part.delta on a reasoning part accumulates text, preserving type", () => {
    const m: Message = {
      id: "a3", sessionID: "s", role: "assistant",
      parts: [{ id: "r1", type: "reasoning", text: "" }],
      time: { created: 2 },
    }
    let s = reduce(initialTuiState, msgEvent(m))
    s = reduce(s, { type: "part.delta", messageID: "a3", partID: "r1", delta: "thinking" })
    const part = s.messages[0]?.parts[0]
    expect(part?.type).toBe("reasoning")
    expect((part as { text: string }).text).toBe("thinking")
  })

  test("part.delta ignores unknown message/part", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a4")))
    s = reduce(s, { type: "part.delta", messageID: "missing", partID: "x", delta: "nope" })
    s = reduce(s, { type: "part.delta", messageID: "a4", partID: "x", delta: "nope" })
    expect(s.messages).toHaveLength(1)
    expect((s.messages[0]?.parts[0] as { text: string }).text).toBe("")
  })

  test("part.updated replaces an existing part in place", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a5")))
    s = reduce(s, {
      type: "part.updated",
      messageID: "a5",
      part: { id: "a5-p", type: "text", text: "replaced fully" },
    })
    expect((s.messages[0]?.parts[0] as { text: string }).text).toBe("replaced fully")
    expect(s.messages[0]?.parts).toHaveLength(1)
  })

  test("part.updated appends a new part if id is unknown", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a6")))
    s = reduce(s, {
      type: "part.updated",
      messageID: "a6",
      part: { id: "a6-p2", type: "text", text: "second part" },
    })
    expect(s.messages[0]?.parts).toHaveLength(2)
    expect(s.messages[0]?.parts[1]?.id).toBe("a6-p2")
  })

  test("part.updated does not mutate original state (purity)", () => {
    const s0 = reduce(initialTuiState, msgEvent(asstMsg("a7", "orig")))
    const s1 = reduce(s0, {
      type: "part.updated",
      messageID: "a7",
      part: { id: "a7-p", type: "text", text: "new" },
    })
    // s0 untouched
    expect((s0.messages[0]?.parts[0] as { text: string }).text).toBe("orig")
    expect((s1.messages[0]?.parts[0] as { text: string }).text).toBe("new")
  })

  test("usage accumulates across events and attaches to message", () => {
    let s = reduce(initialTuiState, msgEvent(asstMsg("a8")))
    s = reduce(s, { type: "usage", messageID: "a8", usage: { input: 10, output: 5 } })
    s = reduce(s, { type: "usage", messageID: "a8", usage: { input: 3, output: 7, reasoning: 2 } })
    expect(s.usage).toEqual({ input: 13, output: 12, reasoning: 2 })
    expect(s.messages[0]?.usage).toEqual({ input: 3, output: 7, reasoning: 2 })
  })

  test("usage for unknown message still accumulates totals", () => {
    const s = reduce(initialTuiState, {
      type: "usage", messageID: "ghost", usage: { input: 5, output: 5 },
    })
    expect(s.usage).toEqual({ input: 5, output: 5, reasoning: 0 })
    expect(s.messages).toHaveLength(0)
  })

  test("turn.start sets running + turn; turn.end advances; loop.end sets ended", () => {
    let s = reduce(initialTuiState, { type: "turn.start", turn: 1 })
    expect(s.status).toBe("running")
    expect(s.turn).toBe(1)
    s = reduce(s, { type: "turn.end", turn: 1 })
    expect(s.turn).toBe(1)
    s = reduce(s, { type: "loop.end", reason: "end_turn" })
    expect(s.status).toBe("ended")
    expect(s.endReason).toBe("end_turn")
  })

  test("error event sets status error + message", () => {
    const s = reduce(initialTuiState, { type: "error", message: "boom" })
    expect(s.status).toBe("error")
    expect(s.error).toBe("boom")
  })

  test("notice appends to notices (default [])", () => {
    let s = reduce(initialTuiState, { type: "notice", message: "hello" })
    expect(initialTuiState.notices).toEqual([])
    expect(s.notices).toEqual(["hello"])
    s = reduce(s, { type: "notice", message: "world" })
    expect(s.notices).toEqual(["hello", "world"])
  })

  test("notice does not mutate prior state", () => {
    const s0 = reduce(initialTuiState, { type: "notice", message: "one" })
    const s1 = reduce(s0, { type: "notice", message: "two" })
    expect(s0.notices).toEqual(["one"])
    expect(s1.notices).toEqual(["one", "two"])
  })

  test("notice caps at 50, dropping oldest", () => {
    let s = initialTuiState
    for (let i = 0; i < 60; i++) s = reduce(s, { type: "notice", message: `n${i}` })
    expect(s.notices).toHaveLength(50)
    expect(s.notices[0]).toBe("n10")
    expect(s.notices[49]).toBe("n59")
  })

  test("reduceAll folds a sequence", () => {
    const events: AgentEvent[] = [
      { type: "turn.start", turn: 1 },
      msgEvent(userMsg("u", "hi")),
      { type: "loop.end", reason: "end_turn" },
    ]
    const s = reduceAll(initialTuiState, events)
    expect(s.messages).toHaveLength(1)
    expect(s.status).toBe("ended")
    expect(s.turn).toBe(1)
  })

  test("fromMessages seeds state without aliasing", () => {
    const msgs = [userMsg("u1", "hi")]
    const s = fromMessages(msgs)
    expect(s.messages).toHaveLength(1)
    expect(s.notices).toEqual([])
    // Mutate input; state must be unaffected.
    msgs[0]!.parts.push({ id: "x", type: "text", text: "extra" })
    expect(s.messages[0]?.parts).toHaveLength(1)
  })
})
