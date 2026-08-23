/**
 * Context percentage vs session cost: two different quantities.
 *
 * The bug these guard against: `case "usage"` accumulated input tokens across
 * turns and the footer divided that running total by the context limit, so the
 * ctx figure raced to 100% after a couple of turns while the window was barely
 * a fifth full. Cost is a running sum; context pressure is a level.
 */

import { describe, expect, test } from "bun:test"

import { fromMessages, initialTuiState, reduce, type TuiState } from "../src/tui/state.ts"
import {
  contextPercent,
  footerRight,
  sessionCost,
} from "../src/tui/components/StatusBar.tsx"
import type { Message } from "../src/types/message.ts"

const LIMIT = 200_000

/** One turn: an assistant message, then the usage event the loop emits for it. */
function turn(state: TuiState, id: string, input: number, output: number): TuiState {
  const message: Message = {
    id,
    sessionID: "s",
    role: "assistant",
    parts: [{ id: `${id}-p`, type: "text", text: "ok" }],
    time: { created: 1 },
  }
  let next = reduce(state, { type: "message.updated", message })
  next = reduce(next, { type: "usage", messageID: id, usage: { input, output } })
  return next
}

describe("ctx% tracks the window, not the session total", () => {
  test("three same-size turns hold the percentage flat instead of tripling", () => {
    // A ~40K prompt re-sent three times is still a 40K window each time.
    let s = initialTuiState
    const seen: (number | undefined)[] = []
    for (const id of ["m1", "m2", "m3"]) {
      s = turn(s, id, 40_000, 500)
      seen.push(contextPercent(s.ctxTokens, LIMIT))
    }
    expect(seen).toEqual([20, 20, 20])
    // The pre-fix behaviour, for contrast: the cumulative input would read 20,
    // 40, 60 — and on a longer session, 100.
    expect(contextPercent(s.usage.input, LIMIT)).toBe(60)
  })

  test("the figure follows the window up and back down after compaction", () => {
    let s = initialTuiState
    s = turn(s, "m1", 150_000, 400)
    expect(contextPercent(s.ctxTokens, LIMIT)).toBe(75)
    // Compaction replaces the history with a summary: the next turn's prompt
    // is small again, and the gauge must fall with it.
    s = turn(s, "m2", 12_000, 400)
    expect(contextPercent(s.ctxTokens, LIMIT)).toBe(6)
  })

  test("a turn reporting no input keeps the last known-good reading", () => {
    let s = initialTuiState
    s = turn(s, "m1", 40_000, 500)
    s = turn(s, "m2", 0, 500)
    expect(s.ctxTokens).toBe(40_000)
    expect(contextPercent(s.ctxTokens, LIMIT)).toBe(20)
  })

  test("ctxTokens starts at zero and shows no figure before any turn", () => {
    expect(initialTuiState.ctxTokens).toBe(0)
    expect(footerRight({ model: "a/b", ctxTokens: initialTuiState.ctxTokens })).toBe("b")
  })
})

describe("cost stays cumulative", () => {
  test("three turns sum into the session total while ctx stays flat", () => {
    let s = initialTuiState
    for (const id of ["m1", "m2", "m3"]) s = turn(s, id, 40_000, 1_000)

    expect(s.usage).toEqual({ input: 120_000, output: 3_000, reasoning: 0 })
    expect(s.ctxTokens).toBe(40_000)

    // $3/Mtok prompt, $15/Mtok completion.
    const cost = sessionCost(s.usage, 3, 15)
    expect(cost).toBeCloseTo(120_000 * 3e-6 + 3_000 * 15e-6, 10)
    // Billed on all three turns, not just the last one.
    expect(cost).toBeGreaterThan(sessionCost({ input: 40_000, output: 1_000, reasoning: 0 }, 3, 15)!)
  })

  test("reasoning tokens accumulate for cost but never inflate the window", () => {
    let s = initialTuiState
    s = reduce(s, { type: "usage", messageID: "x", usage: { input: 40_000, output: 100, reasoning: 9_000 } })
    expect(s.usage.reasoning).toBe(9_000)
    // Reasoning is output, and the loop drops reasoning parts when replaying,
    // so it never occupies the next request's window.
    expect(s.ctxTokens).toBe(40_000)
    expect(contextPercent(s.ctxTokens, LIMIT)).toBe(20)
  })
})

describe("footer formatting", () => {
  test("the exact shape: tokens (pct) · cost · model", () => {
    expect(
      footerRight({ model: "anthropic/claude-sonnet-5", ctxTokens: 76_200, pct: 38, cost: 0.0123 }),
    ).toBe("76.2K (38%) · $0.0123 · claude-sonnet-5")
  })

  test("K and M formatting, uppercase, one decimal", () => {
    expect(footerRight({ model: "a/b", ctxTokens: 76_200 })).toBe("76.2K · b")
    expect(footerRight({ model: "a/b", ctxTokens: 1_000 })).toBe("1.0K · b")
    expect(footerRight({ model: "a/b", ctxTokens: 999 })).toBe("999 · b")
    expect(footerRight({ model: "a/b", ctxTokens: 2_500_000 })).toBe("2.5M · b")
  })

  test("no limit hides the percent but keeps tokens, cost and model", () => {
    const right = footerRight({ model: "a/b", ctxTokens: 76_200, cost: 0.5 })
    expect(right).toBe("76.2K · $0.5000 · b")
    expect(right).not.toContain("%")
  })

  test("no pricing hides the cost segment only", () => {
    expect(footerRight({ model: "a/b", ctxTokens: 76_200, pct: 38 })).toBe("76.2K (38%) · b")
  })
})

describe("resume seeds the gauge from history", () => {
  test("a resumed session shows the window it left off at, not 0%", () => {
    const history: Message[] = [
      { id: "m1", sessionID: "s", role: "assistant", parts: [], time: { created: 1 }, usage: { input: 30_000, output: 100 } },
      { id: "m2", sessionID: "s", role: "assistant", parts: [], time: { created: 2 }, usage: { input: 88_000, output: 200 } },
    ]
    const s = fromMessages(history)
    expect(s.ctxTokens).toBe(88_000)
    expect(contextPercent(s.ctxTokens, LIMIT)).toBe(44)
    // Spend is for this sitting; it does not replay from the transcript.
    expect(s.usage).toEqual({ input: 0, output: 0, reasoning: 0 })
  })

  test("history with no usage recorded leaves the gauge at zero", () => {
    const s = fromMessages([
      { id: "m1", sessionID: "s", role: "user", parts: [], time: { created: 1 } },
    ])
    expect(s.ctxTokens).toBe(0)
  })
})
