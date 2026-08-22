import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"

/**
 * The confirmation a successful /connect leaves behind.
 *
 * The host has no React handle: it signals the app through `store.setHint`,
 * and the app renders `state.hint` alongside its own local hints. That seam is
 * what these tests pin — a chrome test that only exercises the app's internal
 * `showHint` would pass even if the store's hint were never rendered, and the
 * connect confirmation would silently never appear.
 *
 * The confirmation must also stay *out* of the transcript: a `notice` wedges
 * itself permanently above the next agent reply and reads as something the
 * agent said.
 */

function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function mount(): { store: TuiStore; inst: ReturnType<typeof render> } {
  const store = createTuiStore([])
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge: createApprovalBridge(),
      model: "mock/demo",
      mode: "build" as const,
      models: ["mock/demo"],
      onPrompt: () => {},
      onAbort: () => {},
      onModelChange: () => {},
      onModeChange: () => {},
      onExit: () => {},
      onNewSession: () => {},
      listSessions: async () => [],
      onResumeSession: () => {},
    }),
  )
  return { store, inst }
}

describe("'<provider> connected' confirmation", () => {
  test("a hint set by the host renders in the app", async () => {
    const { store, inst } = mount()

    store.setHint("openrouter connected", 5_000)
    await flush()

    expect(inst.lastFrame() ?? "").toContain("openrouter connected")
    inst.unmount()
  })

  test("it disappears on its own", async () => {
    const { store, inst } = mount()

    store.setHint("anthropic connected", 40)
    await flush()
    expect(inst.lastFrame() ?? "").toContain("anthropic connected")

    await flush(120)
    expect(inst.lastFrame() ?? "").not.toContain("anthropic connected")
    inst.unmount()
  })

  test("it never enters the transcript", async () => {
    const { store, inst } = mount()

    store.setHint("openai connected", 5_000)
    await flush()

    // No message was appended — the hint is chrome, not conversation.
    expect(store.getState().messages).toHaveLength(0)
    inst.unmount()
  })

  test("connecting a second provider supersedes the first hint", async () => {
    const { store, inst } = mount()

    store.setHint("openai connected", 5_000)
    await flush()
    store.setHint("anthropic connected", 5_000)
    await flush()

    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("anthropic connected")
    expect(frame).not.toContain("openai connected")
    inst.unmount()
  })
})
