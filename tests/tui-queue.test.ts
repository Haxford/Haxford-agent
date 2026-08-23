import { describe, expect, test } from "bun:test"
import React from "react"

import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { Composer, type ComposerHandle } from "../src/tui/components/Composer.tsx"
import { queueDisplayLines, MAX_QUEUE_LINES_SHOWN } from "../src/tui/layout.ts"
import { createTuiStore } from "../src/tui/store.ts"
import { renderFixed } from "./helpers/ink.ts"

/** Flush pending microtasks so useSyncExternalStore + input re-renders settle. */
function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function mount(overrides: { onPrompt?: (text: string) => void } = {}) {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const inst = renderFixed(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: "build" as const,
      models: ["mock/demo"],
      onPrompt: overrides.onPrompt ?? (() => {}),
      onAbort: () => {},
      onModelChange: () => {},
      onModeChange: () => {},
      onExit: () => {},
      onNewSession: () => {},
      listSessions: async () => [],
      onResumeSession: () => {},
    }),
  )
  return { store, bridge, inst }
}

/* -------------------------------------------------------------------------- */
/* store: FIFO ordering                                                       */
/* -------------------------------------------------------------------------- */

describe("TuiStore queue", () => {
  test("enqueue/dequeue is FIFO, oldest first", () => {
    const store = createTuiStore([])
    store.enqueue("first")
    store.enqueue("second")
    store.enqueue("third")
    expect(store.getState().queue).toEqual(["first", "second", "third"])
    expect(store.dequeue()).toBe("first")
    expect(store.dequeue()).toBe("second")
    expect(store.getState().queue).toEqual(["third"])
    expect(store.dequeue()).toBe("third")
    expect(store.dequeue()).toBeUndefined()
  })

  test("popLastQueued removes the most recently queued item (the back)", () => {
    const store = createTuiStore([])
    store.enqueue("a")
    store.enqueue("b")
    store.enqueue("c")
    expect(store.popLastQueued()).toBe("c")
    expect(store.getState().queue).toEqual(["a", "b"])
    expect(store.popLastQueued()).toBe("b")
    expect(store.popLastQueued()).toBe("a")
    expect(store.popLastQueued()).toBeUndefined()
  })

  test("enqueue/dequeue/popLastQueued notify subscribers", () => {
    const store = createTuiStore([])
    let calls = 0
    store.subscribe(() => calls++)
    store.enqueue("x")
    expect(calls).toBe(1)
    store.dequeue()
    expect(calls).toBe(2)
    store.enqueue("y")
    store.popLastQueued()
    expect(calls).toBe(4)
  })

  test("dequeue/popLastQueued on an empty queue are no-ops that do not notify", () => {
    const store = createTuiStore([])
    let calls = 0
    store.subscribe(() => calls++)
    expect(store.dequeue()).toBeUndefined()
    expect(store.popLastQueued()).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("reset clears the queue (a new/resumed session starts with none pending)", () => {
    const store = createTuiStore([])
    store.enqueue("stale")
    store.reset([])
    expect(store.getState().queue).toEqual([])
  })

  test("the queue is untouched by unrelated state changes (mode-switch survival)", () => {
    // Mode lives on the host, not TuiState — this proves nothing else in the
    // reducer/store incidentally clears the queue when other state moves.
    const store = createTuiStore([])
    store.enqueue("keep me")
    store.dispatch({ type: "notice", message: "mode auto" })
    store.setHint("mode auto")
    store.setToolsExpanded(true)
    expect(store.getState().queue).toEqual(["keep me"])
  })
})

/* -------------------------------------------------------------------------- */
/* sequential flush, no re-entrancy (mirrors src/index.ts's onPrompt reroute) */
/* -------------------------------------------------------------------------- */

/**
 * src/index.ts's `onPrompt` closure is not exported (same as every other host
 * closure in `runTui`), so this reproduces its queue-reroute shape exactly —
 * `if (running) { store.enqueue(text); return }`, then a `finally` that
 * dequeues and re-enters the same function — against a fake bridge instead of
 * `runAgentLoop`. It proves the PATTERN src/index.ts implements: strictly
 * sequential, non-overlapping runs, queued submissions flushed in order, and
 * a flush that proceeds regardless of how the run ended.
 */
function fakeHost(run: (text: string) => Promise<void>) {
  const store = createTuiStore([])
  let running = false
  const started: string[] = []
  let concurrent = 0
  let maxConcurrent = 0

  const onPrompt = (text: string): void => {
    if (running) {
      store.enqueue(text)
      return
    }
    running = true
    void (async () => {
      started.push(text)
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        await run(text)
      } catch {
        // Mirrors src/index.ts's onPrompt: a failed/aborted run is reported,
        // never left to crash the host — the finally below still flushes.
      } finally {
        concurrent--
        running = false
        const next = store.dequeue()
        if (next !== undefined) onPrompt(next)
      }
    })()
  }

  return { store, onPrompt, started: () => started, maxConcurrent: () => maxConcurrent }
}

describe("sequential queue flush (fake bridge)", () => {
  test("submissions during a run queue, then flush in order once idle", async () => {
    const order: string[] = []
    const host = fakeHost(async (text) => {
      order.push(`start:${text}`)
      await flush(5)
      order.push(`end:${text}`)
    })

    host.onPrompt("one")
    // Both arrive while "one" is still running.
    host.onPrompt("two")
    host.onPrompt("three")
    expect(host.store.getState().queue).toEqual(["two", "three"])

    await flush(80)
    expect(order).toEqual([
      "start:one", "end:one",
      "start:two", "end:two",
      "start:three", "end:three",
    ])
    expect(host.started()).toEqual(["one", "two", "three"])
    expect(host.maxConcurrent()).toBe(1) // never re-entrant
    expect(host.store.getState().queue).toEqual([])
  })

  test("a run that aborts (rejects) still flushes what was queued behind it", async () => {
    const order: string[] = []
    const host = fakeHost(async (text) => {
      order.push(text)
      if (text === "one") throw new Error("aborted")
    })

    host.onPrompt("one")
    host.onPrompt("two")
    await flush(40)

    expect(order).toEqual(["one", "two"])
    expect(host.store.getState().queue).toEqual([])
  })

  test("a fresh onPrompt while idle runs immediately, not through the queue", async () => {
    const order: string[] = []
    const host = fakeHost(async (text) => {
      order.push(text)
    })
    host.onPrompt("solo")
    await flush(20)
    expect(order).toEqual(["solo"])
    expect(host.store.getState().queue).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Composer: up-arrow pop-back                                                */
/* -------------------------------------------------------------------------- */

describe("Composer up-arrow queue pop-back", () => {
  test("up-arrow on an empty composer pops the queue back for editing", () => {
    const onChange: string[] = []
    const popped: string[] = []
    let queue = ["queued one", "queued two"]
    const handleRef: React.MutableRefObject<ComposerHandle | undefined> = { current: undefined }
    const inst = renderFixed(
      React.createElement(Composer, {
        disabled: false,
        onSubmit: () => {},
        onValueChange: (v: string) => onChange.push(v),
        onPopQueued: () => {
          const last = queue[queue.length - 1]
          if (last === undefined) return undefined
          queue = queue.slice(0, -1)
          popped.push(last)
          return last
        },
        handleRef,
      }),
    )
    inst.stdin.write("\u001b[A") // up arrow
    expect(popped).toEqual(["queued two"])
    expect(onChange.at(-1)).toBe("queued two")
    inst.unmount()
  })

  test("up-arrow falls through to local submit history once the queue is empty", () => {
    const onChange: string[] = []
    const handleRef: React.MutableRefObject<ComposerHandle | undefined> = { current: undefined }
    const inst = renderFixed(
      React.createElement(Composer, {
        disabled: false,
        onSubmit: () => {},
        onValueChange: (v: string) => onChange.push(v),
        onPopQueued: () => undefined, // nothing queued
        handleRef,
      }),
    )
    // Seed local history the way a real submit would.
    handleRef.current?.set("previously sent")
    inst.stdin.write("\r") // submit -> enters composer's own history
    inst.stdin.write("\u001b[A") // up arrow: queue is empty, falls through
    expect(onChange.at(-1)).toBe("previously sent")
    inst.unmount()
  })

  test("up-arrow does not consult the queue when the composer already has text", async () => {
    let calls = 0
    const handleRef: React.MutableRefObject<ComposerHandle | undefined> = { current: undefined }
    const inst = renderFixed(
      React.createElement(Composer, {
        disabled: false,
        onSubmit: () => {},
        onPopQueued: () => {
          calls++
          return "should not be used"
        },
        handleRef,
      }),
    )
    handleRef.current?.set("typing something")
    await flush(10)
    inst.stdin.write("\u001b[A")
    expect(calls).toBe(0)
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* layout: queueDisplayLines                                                  */
/* -------------------------------------------------------------------------- */

describe("queueDisplayLines", () => {
  test("zero when nothing is queued", () => {
    expect(queueDisplayLines(0)).toBe(0)
  })
  test("one line per item up to the cap, no count hint", () => {
    expect(queueDisplayLines(1)).toBe(1)
    expect(queueDisplayLines(MAX_QUEUE_LINES_SHOWN)).toBe(MAX_QUEUE_LINES_SHOWN)
  })
  test("capped items plus one line for the count hint beyond the cap", () => {
    expect(queueDisplayLines(MAX_QUEUE_LINES_SHOWN + 1)).toBe(MAX_QUEUE_LINES_SHOWN + 1)
    expect(queueDisplayLines(50)).toBe(MAX_QUEUE_LINES_SHOWN + 1)
  })
})

/* -------------------------------------------------------------------------- */
/* render: queued prompts shown as dim stacked one-liners above the input     */
/* -------------------------------------------------------------------------- */

describe("queued prompts render above the composer", () => {
  test("shows each queued prompt as '⏎ text'", async () => {
    const { store, inst } = mount()
    store.enqueue("do the thing")
    store.enqueue("then the other thing")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("⏎ do the thing")
    expect(frame).toContain("⏎ then the other thing")
  })

  test("beyond the cap, shows a '+N more queued' count hint instead of every line", async () => {
    const { store, inst } = mount()
    for (let i = 0; i < 6; i++) store.enqueue(`prompt ${i}`)
    await flush()
    const frame = inst.lastFrame() ?? ""
    // First three shown verbatim…
    expect(frame).toContain("⏎ prompt 0")
    expect(frame).toContain("⏎ prompt 1")
    expect(frame).toContain("⏎ prompt 2")
    // …the rest collapse into the count hint.
    expect(frame).not.toContain("⏎ prompt 3")
    expect(frame).toContain("+3 more queued")
  })

  test("composer stays enabled (not the disabled glyph) while queue has items and the loop is idle", async () => {
    const { store, inst } = mount()
    store.enqueue("waiting")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("ask anything")
  })

  test("nothing renders when the queue is empty", async () => {
    const { inst } = mount()
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("more queued")
  })
})

/* -------------------------------------------------------------------------- */
/* End-to-end: typing while RUNNING queues, and the queue clears on idle       */
/* -------------------------------------------------------------------------- */

describe("queueing while the agent is running (whole cycle)", () => {
  /**
   * The composer must stay live during a run — that is the entire premise of
   * queueing. If it were disabled, enter would never reach the host and there
   * would be nothing to queue.
   */
  test("enter during a run reaches the host rather than being swallowed", async () => {
    const submitted: string[] = []
    const { store, inst } = mount({ onPrompt: (t) => submitted.push(t) })
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()

    inst.stdin.write("while running")
    await flush()
    inst.stdin.write("\r")
    await flush()

    expect(submitted).toEqual(["while running"])
  })

  test("a queued prompt is visible above the composer while the run continues", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    store.enqueue("second thing")
    await flush()

    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("second thing")
    // And the count rides the activity line, which only exists while running.
    expect(frame).toContain("1 queued")
  })

  test("the count tracks the queue and disappears when it drains", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    store.enqueue("a")
    store.enqueue("b")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("2 queued")

    store.dequeue()
    await flush()
    expect(inst.lastFrame() ?? "").toContain("1 queued")

    store.dequeue()
    await flush()
    // Match the count token specifically: the composer placeholder while
    // running also says "queued", and asserting on the bare word would pass
    // or fail for the wrong reason.
    expect(inst.lastFrame() ?? "").not.toMatch(/\d+ queued/)
  })

  test("no count is shown when nothing is queued, running or not", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()
    expect(inst.lastFrame() ?? "").not.toMatch(/\d+ queued/)
  })

  test("going idle with the queue drained leaves no queue chrome behind", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    store.enqueue("pending one")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("pending one")

    // The host flushes from the front as the loop goes idle.
    expect(store.dequeue()).toBe("pending one")
    store.dispatch({ type: "loop.end", reason: "end_turn" })
    await flush()

    const frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("pending one")
    expect(frame).not.toMatch(/\d+ queued/)
  })

  test("the activity line stays on one row at 80 columns with a queue", async () => {
    const store = createTuiStore([])
    const bridge = createApprovalBridge()
    const inst = renderFixed(
      React.createElement(HaxfordApp, {
        store,
        bridge,
        model: "openrouter/z-ai/glm-4.6",
        mode: "build" as const,
        models: ["openrouter/z-ai/glm-4.6"],
        onPrompt: () => {},
        onAbort: () => {},
        onModelChange: () => {},
        onModeChange: () => {},
        onExit: () => {},
        onNewSession: () => {},
        listSessions: async () => [],
        onResumeSession: () => {},
      }),
      { columns: 80 },
    )
    store.dispatch({ type: "turn.start", turn: 1 })
    store.dispatch({
      type: "usage",
      messageID: "m1",
      usage: { input: 123456, output: 45678, reasoning: 0 },
    })
    for (let i = 0; i < 12; i++) store.enqueue(`queued prompt number ${i}`)
    await flush()

    // The banner-wrap lesson: every row of chrome has to fit, or the pin math
    // that reserves exactly one line for this one is wrong.
    for (const line of (inst.lastFrame() ?? "").split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(80)
    }
    expect(inst.lastFrame() ?? "").toContain("12 queued")
  })
})
