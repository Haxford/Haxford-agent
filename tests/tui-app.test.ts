import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { SessionInfo } from "../src/types/session.ts"
import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { createTuiStore } from "../src/tui/store.ts"

/**
 * NOTE: @inkjs/ui TextInput does not receive stdin in the ink-testing-library
 * harness (its onChange/onSubmit never fire because it requires a real raw-mode
 * TTY). Slash-command submission therefore cannot be driven through the
 * Composer here. The interactive /help, /model, /exit, /clear, /sessions flows
 * are instead verified by the live demo (`bun run src/tui/demo.tsx`) and by the
 * pure reducer/store tests. These tests cover the App's own useInput handler
 * (a/l/d, Esc-abort) and store/bridge-driven rendering.
 */

/** Flush pending microtasks so useSyncExternalStore + input re-renders settle. */
function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Minimal host wiring for render tests. */
function mount(overrides: {
  models?: string[]
  onAbort?: () => void
  onModelChange?: (s: string) => void
  listSessions?: () => Promise<SessionInfo[]>
} = {}) {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const calls: { abort: number; model: string[] } = { abort: 0, model: [] }
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: "build",
      models: overrides.models ?? ["mock/demo", "anthropic/claude", "openai/gpt-4o"],
      onPrompt: () => {},
      onAbort: () => { calls.abort++; overrides.onAbort?.() },
      onModelChange: (s) => { calls.model.push(s); overrides.onModelChange?.(s) },
      onExit: () => {},
      onNewSession: () => {},
      listSessions: overrides.listSessions ?? (async () => []),
      onResumeSession: () => {},
    }),
  )
  return { store, bridge, inst, calls }
}

describe("HaxfordApp rendering + app-level input", () => {
  test("initial render shows status bar with model + mode + idle", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("mock/demo")
    expect(frame).toContain("build")
    expect(frame).toContain("idle")
    // help hint mentions /model (one of the five commands).
    expect(frame).toContain("/help")
  })

  test("Composer is disabled while running (placeholder hint)", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("running")
    expect(frame).toContain("agent running")
  })

  test("StatusBar shows current turn number when running", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 7 })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("turn 7")
  })

  test("Esc while running calls onAbort (host owns AbortController)", async () => {
    const { store, inst, calls } = mount()
    store.dispatch({ type: "turn.start", turn: 2 })
    await flush()
    expect(inst.lastFrame() ?? "").toContain("running")
    inst.stdin.write("\u001b") // esc
    await flush(40)
    expect(calls.abort).toBe(1)
  })

  test("Esc while idle does NOT call onAbort", async () => {
    const { inst, calls } = mount()
    inst.stdin.write("\u001b") // esc, idle
    await flush()
    expect(calls.abort).toBe(0)
  })

  test("permission.request via bridge renders the modal dialog", async () => {
    const { bridge, inst } = mount()
    void bridge.askPermission({
      tool: "bash", title: "rm -rf /", args: { command: "rm -rf /" }, sessionID: "s",
    })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("permission required")
    expect(frame).toContain("bash")
    expect(frame).toContain("[a] allow once")
    expect(frame).toContain("[l] always (this session)")
    expect(frame).toContain("[d] deny")
  })

  test("a key resolves the bridge as allow while a request is pending", async () => {
    const { bridge, inst } = mount()
    const p = bridge.askPermission({
      tool: "bash", title: "ls", args: { command: "ls" }, sessionID: "s",
    })
    await flush()
    inst.stdin.write("a")
    const decision = await p
    expect(decision).toBe("allow")
    expect(bridge.pending()).toBeUndefined()
  })

  test("l key resolves the bridge as always", async () => {
    const { bridge, inst } = mount()
    const p = bridge.askPermission({
      tool: "bash", title: "ls", args: { command: "ls" }, sessionID: "s",
    })
    await flush()
    inst.stdin.write("l")
    expect(await p).toBe("always")
  })

  test("d key resolves the bridge as deny", async () => {
    const { bridge, inst } = mount()
    const p = bridge.askPermission({
      tool: "bash", title: "ls", args: { command: "ls" }, sessionID: "s",
    })
    await flush()
    inst.stdin.write("d")
    expect(await p).toBe("deny")
  })

  test("Esc resolves the bridge as deny while a request is pending", async () => {
    const { bridge, inst } = mount()
    const p = bridge.askPermission({
      tool: "bash", title: "ls", args: { command: "ls" }, sessionID: "s",
    })
    await flush()
    inst.stdin.write("\u001b")
    expect(await p).toBe("deny")
  })

  test("Composer is disabled while a permission request is pending", async () => {
    const { bridge, inst } = mount()
    void bridge.askPermission({
      tool: "bash", title: "ls", args: { command: "ls" }, sessionID: "s",
    })
    await flush()
    // The dialog is modal: composer shows the disabled placeholder.
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("permission required")
    expect(frame).toContain("agent running")
  })

  test("notices render as dimmed lines below the transcript", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "notice", message: "context compacted" })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("context compacted")
  })
})
