import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { SessionInfo } from "../src/types/session.ts"
import { HaxfordApp, HELP_TEXT, isExactCommandMatch, parseSlashCommand, type SlashAction } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { Composer, type ComposerHandle } from "../src/tui/components/Composer.tsx"
import { SlashAutocomplete } from "../src/tui/components/SlashAutocomplete.tsx"
import { COMMANDS } from "../src/tui/components/HelpPanel.tsx"
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
  mode?: "build" | "auto" | "plan"
  onAbort?: () => void
  onModelChange?: (s: string) => void
  onModeChange?: (m: "build" | "auto" | "plan") => void
  onCompact?: () => void
  listSessions?: () => Promise<SessionInfo[]>
} = {}) {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const calls: { abort: number; model: string[]; mode: ("build" | "auto" | "plan")[]; compact: number } = {
    abort: 0, model: [], mode: [], compact: 0,
  }
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: overrides.mode ?? "build",
      models: overrides.models ?? ["mock/demo", "anthropic/claude", "openai/gpt-4o"],
      onPrompt: () => {},
      onAbort: () => { calls.abort++; overrides.onAbort?.() },
      onModelChange: (s) => { calls.model.push(s); overrides.onModelChange?.(s) },
      onModeChange: (m) => { calls.mode.push(m); overrides.onModeChange?.(m) },
      onCompact: () => { calls.compact++; overrides.onCompact?.() },
      onExit: () => {},
      onNewSession: () => {},
      listSessions: overrides.listSessions ?? (async () => []),
      onResumeSession: () => {},
    }),
  )
  return { store, bridge, inst, calls }
}

describe("HaxfordApp rendering + app-level input", () => {
  test("initial render shows the banner, its affordance grid, and the footer", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("mock/demo")
    expect(frame).toContain("build") // mode word, no brackets
    expect(frame).toContain("haxford") // banner wordmark
    // The empty state teaches: the hint grid names the keys it accepts.
    expect(frame).toContain("/help")
    expect(frame).toContain("commands")
    expect(frame).toContain("cycle mode")
    expect(frame).toContain("interrupt")
    // No ASCII art: the wordmark line is plain text.
    expect(frame).not.toContain("█")
    expect(frame).not.toContain("▀")
  })

  test("status bar renders below the composer", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    const composer = lines.findIndex((l) => l.includes("ask anything"))
    const status = lines.findIndex((l) => l.includes("mock/demo") && l.includes("build"))
    expect(composer).toBeGreaterThanOrEqual(0)
    expect(status).toBeGreaterThan(composer)
  })

  test("no rounded box borders anywhere in the default frame", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    for (const glyph of ["╭", "╮", "╰", "╯", "─"]) {
      expect(frame).not.toContain(glyph)
    }
    // The left rail is the one grouping device that remains.
    expect(frame).toContain("┃")
  })

  test("Composer is disabled while running (placeholder hint)", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("running")
    expect(frame).toContain("agent running")
  })

  test("running shows an activity line with a verb, clock, and the way out", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 7 })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("thinking")
    expect(frame).toContain("esc to interrupt")
    // The turn counter is gone: no reference harness surfaces it.
    expect(frame).not.toContain("turn 7")
  })

  test("activity line names the running tool once one starts", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    store.dispatch({
      type: "message.updated",
      message: {
        id: "a1", sessionID: "s", role: "assistant", time: { created: 0 },
        parts: [{
          id: "t1", type: "tool", tool: "bash", callID: "c1",
          state: { status: "running", input: {}, time: { start: 0 } },
        }],
      },
    })
    await flush()
    expect(inst.lastFrame() ?? "").toContain("bash")
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
    expect(frame).toContain("run command") // action kind for bash
    expect(frame).toContain("bash")
    expect(frame).toContain("rm -rf /") // subject + title
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
    expect(frame).toContain("run command")
    expect(frame).toContain("awaiting approval")
  })

  test("notices render as dimmed lines below the transcript", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "notice", message: "context compacted" })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("context compacted")
  })
})

describe("parseSlashCommand", () => {
  // /compact delegates to the host; the parse just reports the action.
  test("/compact decodes to a compact action", () => {
    expect(parseSlashCommand("/compact", "build")).toEqual({ kind: "compact" })
  })

  test("/init decodes to a prompt carrying the canned instruction", () => {
    const action = parseSlashCommand("/init", "build")
    expect(action.kind).toBe("prompt")
    const a = action as Extract<SlashAction, { kind: "prompt" }>
    expect(a.text).toContain("AGENTS.md")
    expect(a.text.toLowerCase()).toContain("build")
    expect(a.text.toLowerCase()).toContain("code style")
    expect(a.text.toLowerCase()).toContain("architecture")
    // Keep the canned prompt under a reasonable size so it does not dominate.
    expect(a.text.length).toBeLessThan(4000)
  })

  test("/mode with no arg cycles build -> auto -> plan -> build", () => {
    expect(parseSlashCommand("/mode", "build")).toEqual({ kind: "mode", mode: "auto" })
    expect(parseSlashCommand("/mode", "auto")).toEqual({ kind: "mode", mode: "plan" })
    expect(parseSlashCommand("/mode", "plan")).toEqual({ kind: "mode", mode: "build" })
  })

  test("/mode with a valid arg sets the mode directly", () => {
    expect(parseSlashCommand("/mode build", "auto")).toEqual({ kind: "mode", mode: "build" })
    expect(parseSlashCommand("/mode auto", "build")).toEqual({ kind: "mode", mode: "auto" })
    expect(parseSlashCommand("/mode plan", "build")).toEqual({ kind: "mode", mode: "plan" })
  })

  test("/mode with an invalid arg decodes to a notice with valid options", () => {
    const action = parseSlashCommand("/mode fast", "build")
    expect(action.kind).toBe("notice")
    const a = action as Extract<SlashAction, { kind: "notice" }>
    expect(a.message).toContain('"fast"')
    expect(a.message).toContain("build | auto | plan")
  })

  test("/mode is case-insensitive on the arg", () => {
    expect(parseSlashCommand("/mode BUILD", "auto")).toEqual({ kind: "mode", mode: "build" })
    expect(parseSlashCommand("/mode Auto", "build")).toEqual({ kind: "mode", mode: "auto" })
  })

  test("plain prompt decodes to a prompt action", () => {
    expect(parseSlashCommand("hello world", "build")).toEqual({ kind: "prompt", text: "hello world" })
  })

  test("empty/whitespace input decodes to an empty prompt", () => {
    expect(parseSlashCommand("   ", "build")).toEqual({ kind: "prompt", text: "" })
  })

  test("existing commands still decode", () => {
    expect(parseSlashCommand("/exit", "build")).toEqual({ kind: "exit" })
    expect(parseSlashCommand("/clear", "build")).toEqual({ kind: "newSession" })
    expect(parseSlashCommand("/help", "build")).toEqual({ kind: "toggleHelp" })
    expect(parseSlashCommand("/sessions", "build")).toEqual({ kind: "sessions" })
    expect(parseSlashCommand("/model", "build")).toEqual({ kind: "model" })
  })

  test("unknown command decodes to unknown with the original command", () => {
    const action = parseSlashCommand("/frobnicate", "build")
    expect(action.kind).toBe("unknown")
    const a = action as Extract<SlashAction, { kind: "unknown" }>
    expect(a.command).toBe("/frobnicate")
  })
})

describe("HaxfordApp /help listing", () => {
  test("HELP_TEXT lists all eight commands", () => {
    for (const cmd of ["/help", "/model", "/sessions", "/compact", "/init", "/mode", "/clear", "/exit"]) {
      expect(HELP_TEXT).toContain(cmd)
    }
  })

  test("initial frame mentions /help", () => {
    const { inst } = mount()
    expect(inst.lastFrame() ?? "").toContain("/help")
  })
})

describe("SlashAutocomplete popup", () => {
  test("renders nothing when there are no matches", () => {
    const inst = render(React.createElement(SlashAutocomplete, { matches: [], cursor: 0 }))
    // Null element -> Ink emits an empty/undefined frame (no popup content).
    const frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("/model")
    expect(frame).not.toContain("▸")
  })

  test("lists matching commands with descriptions, marks the selected row", () => {
    const matches = COMMANDS.filter((c) => c.command.startsWith("/m")) // /model, /mode
    const inst = render(React.createElement(SlashAutocomplete, { matches, cursor: 0 }))
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("/model")
    expect(frame).toContain("switch the active model")
    expect(frame).toContain("/mode")
    expect(frame).toContain("switch permission mode")
    // First row selected -> cyan ▸
    expect(frame).toContain("▸")
  })

  test("selected cursor moves to the second row", () => {
    const matches = COMMANDS.filter((c) => c.command.startsWith("/m"))
    const inst = render(React.createElement(SlashAutocomplete, { matches, cursor: 1 }))
    const lines = (inst.lastFrame() ?? "").split("\n").filter((l) => l.includes("▸"))
    // Exactly one selected row, and it is the /mode row.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("/mode")
  })
})

describe("autocomplete submission safety", () => {
  test("exact single match deactivates the popup so Enter submits", () => {
    expect(isExactCommandMatch([COMMANDS[0]!], "/help")).toBe(true)
    expect(isExactCommandMatch([COMMANDS[0]!], "  /HELP  ")).toBe(true)
    // Partial prefix ("/e" -> /exit) must NOT count as exact.
    expect(isExactCommandMatch(COMMANDS.filter((c) => c.command.startsWith("/e")), "/e")).toBe(false)
    // Multiple matches are never an exact match.
    expect(isExactCommandMatch(COMMANDS.filter((c) => c.command.startsWith("/m")), "/m")).toBe(false)
    expect(isExactCommandMatch([], "")).toBe(false)
  })

  test("composer handle writes completions into the real input", () => {
    const onChange: string[] = []
    const handleRef: React.MutableRefObject<ComposerHandle | undefined> = {
      current: undefined,
    }
    const inst = render(
      React.createElement(Composer, {
        disabled: false,
        onSubmit: () => {},
        onValueChange: (v: string) => onChange.push(v),
        handleRef,
      }),
    )
    expect(handleRef.current).toBeDefined()
    handleRef.current?.set("/mode ")
    // The imperative set() reseeds the uncontrolled TextInput and reports the
    // new value through onValueChange - this is what makes completion work.
    expect(onChange.at(-1)).toBe("/mode ")
    inst.unmount()
  })
})
