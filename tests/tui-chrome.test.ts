import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { AgentEvent } from "../src/types/events.ts"
import { HaxfordApp, HINT_MS, pricingForSpec } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { formatCost, sessionCost } from "../src/tui/components/StatusBar.tsx"
import { type ModelOption } from "../src/tui/components/ModelPicker.tsx"
import { reduceAll } from "../src/tui/state.ts"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"

/**
 * Chrome-level behaviour: the transient status hint that carries mode switches
 * and the ctrl+c quit confirmation, and the session cost in the footer.
 */

function flush(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Harness {
  store: TuiStore
  inst: ReturnType<typeof render>
  calls: { exit: number; abort: number; mode: ("build" | "auto" | "plan")[] }
}

function mount(
  overrides: { mode?: "build" | "auto" | "plan"; models?: string[] | ModelOption[] } = {},
): Harness {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const calls = { exit: 0, abort: 0, mode: [] as ("build" | "auto" | "plan")[] }
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: overrides.mode ?? "build",
      models: overrides.models ?? ["mock/demo"],
      onPrompt: () => {},
      onAbort: () => { calls.abort++ },
      onModelChange: () => {},
      onModeChange: (m: "build" | "auto" | "plan") => { calls.mode.push(m) },
      onExit: () => { calls.exit++ },
      onNewSession: () => {},
      listSessions: async () => [],
      onResumeSession: () => {},
    }),
  )
  return { store, inst, calls }
}

const CTRL_C = ""

describe("ctrl+c: twice to quit while idle", () => {
  test("the first press does not exit; it asks", async () => {
    const { inst, calls } = mount()
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.exit).toBe(0)
    expect(inst.lastFrame() ?? "").toContain("press ctrl+c again to exit")
    inst.unmount()
  })

  test("a second press inside the window exits exactly once", async () => {
    const { inst, calls } = mount()
    inst.stdin.write(CTRL_C)
    await flush()
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.exit).toBe(1)
    inst.unmount()
  })

  test("the confirmation expires, and the hint goes with it", async () => {
    const { inst, calls } = mount()
    inst.stdin.write(CTRL_C)
    await flush()
    expect(inst.lastFrame() ?? "").toContain("press ctrl+c again")
    await flush(HINT_MS + 200)
    // Hint gone…
    expect(inst.lastFrame() ?? "").not.toContain("press ctrl+c again")
    // …and so is the armed quit: this press re-arms rather than exiting.
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.exit).toBe(0)
    expect(inst.lastFrame() ?? "").toContain("press ctrl+c again")
    inst.unmount()
  })

  test("any other key disarms, so a stale window cannot quit on you", async () => {
    const { inst, calls } = mount()
    inst.stdin.write(CTRL_C)
    await flush()
    inst.stdin.write("x")
    await flush()
    expect(inst.lastFrame() ?? "").not.toContain("press ctrl+c again")
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.exit).toBe(0)
    inst.unmount()
  })

  test("while running, one press still interrupts and never exits", async () => {
    const { store, inst, calls } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.abort).toBe(1)
    expect(calls.exit).toBe(0)
    expect(inst.lastFrame() ?? "").not.toContain("press ctrl+c again")
    // A second press keeps interrupting; it does not accumulate toward a quit.
    inst.stdin.write(CTRL_C)
    await flush()
    expect(calls.abort).toBe(2)
    expect(calls.exit).toBe(0)
    inst.unmount()
  })

  test("the confirmation never reaches the transcript", async () => {
    const { store, inst } = mount()
    inst.stdin.write(CTRL_C)
    await flush()
    expect(store.getState().notices).toEqual([])
    expect(store.getState().messages).toEqual([])
    inst.unmount()
  })
})

describe("mode switch is a transient hint, never a transcript notice", () => {
  test("Tab switches the mode and leaves messages and notices untouched", async () => {
    const { store, inst, calls } = mount({ mode: "build" })
    // Seed a settled turn so any appended notice would be visible above it.
    const seeded: AgentEvent[] = [
      {
        type: "message.updated",
        message: {
          id: "m1", sessionID: "s", role: "assistant", time: { created: 0 },
          parts: [{ id: "p1", type: "text", text: "prior reply" }],
        },
      },
    ]
    for (const e of seeded) store.dispatch(e)
    await flush()
    const before = store.getState()

    inst.stdin.write("\t")
    await flush()

    expect(calls.mode).toEqual(["auto"])
    const after = store.getState()
    // The whole point: the transcript is byte-for-byte what it was.
    expect(after.messages).toEqual(before.messages)
    expect(after.notices).toEqual([])
    expect(after.notices).toEqual(before.notices)
    // Feedback happened — it just happened on the chrome.
    expect(inst.lastFrame() ?? "").toContain("mode auto")
    inst.unmount()
  })

  test("/mode <arg> switches without appending a notice", async () => {
    const { store, inst, calls } = mount({ mode: "build" })
    inst.stdin.write("/mode plan")
    await flush()
    inst.stdin.write("\r")
    await flush(80)
    expect(calls.mode).toEqual(["plan"])
    expect(store.getState().notices).toEqual([])
    expect(store.getState().messages).toEqual([])
    expect(inst.lastFrame() ?? "").toContain("mode plan")
    inst.unmount()
  })

  test("the mode hint expires on its own", async () => {
    const { store, inst } = mount()
    inst.stdin.write("\t")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("mode auto")
    await flush(HINT_MS + 200)
    expect(inst.lastFrame() ?? "").not.toContain("mode auto")
    // Nothing was left behind anywhere.
    expect(store.getState().notices).toEqual([])
    inst.unmount()
  })

  test("an invalid /mode arg hints too, rather than parking in the transcript", async () => {
    const { store, inst, calls } = mount()
    inst.stdin.write("/mode fast")
    await flush()
    inst.stdin.write("\r")
    await flush(80)
    expect(calls.mode).toEqual([])
    expect(store.getState().notices).toEqual([])
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("build | auto | plan")
    inst.unmount()
  })

  test("repeated switches never accumulate anything", async () => {
    const { store, inst, calls } = mount()
    for (let i = 0; i < 5; i++) {
      inst.stdin.write("\t")
      await flush(20)
    }
    expect(calls.mode).toHaveLength(5)
    expect(store.getState().notices).toEqual([])
    expect(store.getState().messages).toEqual([])
    inst.unmount()
  })
})

describe("StatusBar.sessionCost", () => {
  const usage = { input: 12_000, output: 3_400, reasoning: 900 }

  test("prices input and output at their own per-Mtok rates", () => {
    // 12000*3/1e6 = 0.036, 3400*15/1e6 = 0.051
    expect(sessionCost(usage, 3, 15)).toBeCloseTo(0.087, 10)
  })

  test("reasoning tokens are not billed twice", () => {
    // Providers count reasoning inside `output`; adding it again would inflate.
    const withMoreReasoning = { ...usage, reasoning: 900_000 }
    expect(sessionCost(withMoreReasoning, 3, 15)).toBeCloseTo(sessionCost(usage, 3, 15)!, 10)
  })

  test("no pricing at all => no number", () => {
    expect(sessionCost(usage)).toBeUndefined()
    expect(sessionCost(usage, undefined, undefined)).toBeUndefined()
  })

  test("half-known pricing bills the half it knows", () => {
    expect(sessionCost(usage, 3)).toBeCloseTo(0.036, 10)
    expect(sessionCost(usage, undefined, 15)).toBeCloseTo(0.051, 10)
  })

  test("a session that has spent nothing shows nothing", () => {
    expect(sessionCost({ input: 0, output: 0, reasoning: 0 }, 3, 15)).toBeUndefined()
    // Free models (price 0) likewise have no number worth the space.
    expect(sessionCost(usage, 0, 0)).toBeUndefined()
  })

  test("formatCost is a fixed four-decimal dollar figure", () => {
    expect(formatCost(0.087)).toBe("$0.0870")
    expect(formatCost(0.00001)).toBe("$0.0000")
    expect(formatCost(12.3)).toBe("$12.3000")
  })
})

describe("pricingForSpec", () => {
  const models: ModelOption[] = [
    { spec: "anthropic/claude-opus-5", available: true, promptPricePerMtok: 5, completionPricePerMtok: 25 },
    { spec: "anthropic/claude-sonnet-5", available: true, promptPricePerMtok: 3, completionPricePerMtok: 15 },
    { spec: "ollama/llama3.3", available: true },
  ]

  test("finds the active model's rates by exact spec", () => {
    expect(pricingForSpec(models, "anthropic/claude-sonnet-5")).toEqual({
      promptPricePerMtok: 3,
      completionPricePerMtok: 15,
    })
  })

  test("an unpriced model yields no rates (so no cost is shown)", () => {
    expect(pricingForSpec(models, "ollama/llama3.3")).toEqual({})
  })

  test("an unknown spec never borrows a sibling's price", () => {
    // "anthropic/claude" is a prefix of two priced entries; a fuzzy match here
    // would bill the session at some other model's rate.
    expect(pricingForSpec(models, "anthropic/claude")).toEqual({})
    expect(pricingForSpec(["a/b"], "a/b")).toEqual({})
  })
})

describe("session cost in the footer", () => {
  const models: ModelOption[] = [
    { spec: "mock/demo", available: true, promptPricePerMtok: 3, completionPricePerMtok: 15 },
  ]

  test("token usage accumulates in the reducer and renders as a cost", async () => {
    const { store, inst } = mount({ models })
    // No spend yet => no number.
    expect(inst.lastFrame() ?? "").not.toContain("$")

    store.dispatch({ type: "usage", messageID: "m1", usage: { input: 8_000, output: 2_000 } })
    store.dispatch({ type: "usage", messageID: "m2", usage: { input: 4_000, output: 1_400 } })
    await flush()

    // Totals: 12000 in / 3400 out -> $0.0870
    expect(store.getState().usage).toEqual({ input: 12_000, output: 3_400, reasoning: 0 })
    expect(inst.lastFrame() ?? "").toContain("$0.0870")
    inst.unmount()
  })

  test("a model with no pricing shows no cost at all", async () => {
    const { store, inst } = mount({ models: ["mock/demo"] })
    store.dispatch({ type: "usage", messageID: "m1", usage: { input: 8_000, output: 2_000 } })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(store.getState().usage.input).toBe(8_000)
    expect(frame).not.toContain("$")
    inst.unmount()
  })

  test("the reducer sums usage events across a whole session", () => {
    const events: AgentEvent[] = [
      { type: "usage", messageID: "m1", usage: { input: 100, output: 10, reasoning: 5 } },
      { type: "usage", messageID: "m2", usage: { input: 250, output: 40 } },
      { type: "usage", messageID: "m3", usage: { input: 7, output: 3, reasoning: 1 } },
    ]
    const state = reduceAll(createTuiStore([]).getState(), events)
    expect(state.usage).toEqual({ input: 357, output: 53, reasoning: 6 })
    expect(sessionCost(state.usage, 3, 15)).toBeCloseTo((357 * 3 + 53 * 15) / 1e6, 12)
  })
})
