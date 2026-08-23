/**
 * Render coalescing during streams.
 *
 * The transcript used to repaint once per token. That is not a cosmetic
 * problem: a repaint clears and rewrites Ink's managed region, so holding a
 * mouse selection over streaming text was impossible, the viewport jumped
 * under the cursor, and scrollback filled with near-identical frames.
 *
 * The fix throttles *notification*, never the reducer — every delta is applied
 * to state the moment it arrives, so `getState()` is always current and the
 * final content is byte-identical to the unthrottled path.
 */

import { describe, expect, test } from "bun:test"

import { createTuiStore, RENDER_THROTTLE_MS } from "../src/tui/store.ts"
import type { AgentEvent } from "../src/types/events.ts"
import type { Message } from "../src/types/message.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MESSAGE: Message = {
  id: "m1",
  sessionID: "s",
  role: "assistant",
  parts: [],
  time: { created: 1 },
}

/** A store mid-stream, with a counter on its notifications. */
function streaming(): { store: ReturnType<typeof createTuiStore>; renders: () => number } {
  const store = createTuiStore([])
  let n = 0
  store.dispatch({ type: "turn.start", turn: 1 })
  store.dispatch({ type: "message.updated", message: MESSAGE })
  store.subscribe(() => n++)
  return { store, renders: () => n }
}

function delta(text: string): AgentEvent {
  return { type: "part.delta", messageID: "m1", partID: "p1", delta: text }
}

function transcriptText(store: ReturnType<typeof createTuiStore>): string {
  const part = store.getState().messages[0]?.parts[0]
  return part !== undefined && part.type === "text" ? part.text : ""
}

describe("a burst of deltas coalesces into a handful of renders", () => {
  test("200 deltas produce at most 12 renders", async () => {
    const { store, renders } = streaming()
    for (let i = 0; i < 200; i++) store.dispatch(delta("tok "))
    await sleep(RENDER_THROTTLE_MS * 3)
    expect(renders()).toBeLessThanOrEqual(12)
    // Unthrottled this was one render per delta.
    expect(renders()).toBeLessThan(200)
  })

  test("the final transcript is identical to what every delta contained", async () => {
    const { store } = streaming()
    const expected = Array.from({ length: 200 }, (_, i) => `t${i} `).join("")
    for (let i = 0; i < 200; i++) store.dispatch(delta(`t${i} `))
    await sleep(RENDER_THROTTLE_MS * 3)
    expect(transcriptText(store)).toBe(expected)
  })

  test("state is current immediately — only the notification waits", () => {
    const { store, renders } = streaming()
    const seen = renders()
    store.dispatch(delta("abc"))
    // Nothing has repainted yet…
    expect(renders()).toBe(seen)
    // …but the content is already there for anyone who asks.
    expect(transcriptText(store)).toBe("abc")
  })

  test("the last delta of a stream still lands, with nothing after it", async () => {
    const { store, renders } = streaming()
    const before = renders()
    store.dispatch(delta("tail"))
    await sleep(RENDER_THROTTLE_MS * 3)
    expect(renders()).toBeGreaterThan(before)
    expect(transcriptText(store)).toBe("tail")
  })

  test("a long stream repaints at roughly the frame budget, not per token", async () => {
    const { store, renders } = streaming()
    const started = Date.now()
    for (let i = 0; i < 60; i++) {
      store.dispatch(delta("x"))
      await sleep(5)
    }
    await sleep(RENDER_THROTTLE_MS * 3)
    const elapsed = Date.now() - started
    // Generous ceiling: the budget is ~10fps, allow slack for timer jitter and
    // a slow CI box rather than asserting an exact cadence.
    const ceiling = Math.ceil(elapsed / RENDER_THROTTLE_MS) + 4
    expect(renders()).toBeLessThanOrEqual(ceiling)
    expect(transcriptText(store)).toBe("x".repeat(60))
  })
})

describe("structural events are never delayed", () => {
  test("turn boundaries, usage, errors and loop.end flush at once", () => {
    for (const event of [
      { type: "turn.start", turn: 2 },
      { type: "turn.end", turn: 2 },
      { type: "usage", messageID: "m1", usage: { input: 10, output: 2 } },
      { type: "error", message: "boom" },
      { type: "loop.end", reason: "end_turn" },
      { type: "notice", message: "hello" },
    ] as AgentEvent[]) {
      const { store, renders } = streaming()
      const before = renders()
      store.dispatch(event)
      expect(renders()).toBeGreaterThan(before)
    }
  })

  test("a structural event flushes whatever deltas were pending with it", () => {
    const { store, renders } = streaming()
    store.dispatch(delta("pending"))
    const beforeFlush = renders()
    store.dispatch({ type: "loop.end", reason: "end_turn" })
    expect(renders()).toBeGreaterThan(beforeFlush)
    expect(transcriptText(store)).toBe("pending")
  })
})
