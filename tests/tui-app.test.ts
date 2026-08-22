import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { SessionInfo } from "../src/types/session.ts"
import { HaxfordApp, HELP_TEXT, isExactCommandMatch, parseSlashCommand, type SlashAction } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { Composer, type ComposerHandle } from "../src/tui/components/Composer.tsx"
import { ConnectDialog } from "../src/tui/components/ConnectDialog.tsx"
import { ModelPicker, type ProviderCatalogEntry } from "../src/tui/components/ModelPicker.tsx"
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
  test("initial render shows the pi-style header and the footer", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    // Header line 1: bare name+version; lines 2-3: hints, self-description.
    expect(frame).toContain("haxford v")
    expect(frame).toContain("esc interrupt")
    expect(frame).toContain("~/.haxford/EXTENDING.md")
    // Footer: where you are and what is answering.
    expect(frame).toContain("(build)")
    expect(frame).toContain("/help")
    // No ASCII art: the wordmark line is plain text.
    expect(frame).not.toContain("\u2588")
    expect(frame).not.toContain("\u2580")
  })

  test("the footer is the last line, below the composer and its rules", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0)
    const composer = lines.findIndex((l) => l.includes("ask anything"))
    const footer = lines.findIndex((l) => l.includes("(build)"))
    expect(composer).toBeGreaterThanOrEqual(0)
    expect(footer).toBe(lines.length - 1)
    expect(footer).toBeGreaterThan(composer)
  })

  test("no box characters anywhere in the default frame", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    // The banner's box is gone; nothing in the chrome draws a border except
    // rails (verticals) and the permission dialog when it appears. Corners
    // are the regression signal: they only exist on boxes.
    for (const corner of ["\u256d", "\u256e", "\u2570", "\u256f", "\u250c", "\u2510", "\u2514", "\u2518"]) {
      expect(frame).not.toContain(corner)
    }
    // The input is bracketed by rules: full-width horizontals with no
    // corners of their own.
    const rules = frame
      .split("\n")
      .filter((l) => /^\u2500+$/.test(l.trim()) && l.trim().length > 20)
    expect(rules).toHaveLength(2)
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

describe("ModelPicker two-level render", () => {
  // Level 1: connected providers listed; the active model's provider
  // is connected; unconnected catalog providers are dimmed.
  const models = [
    { spec: "anthropic/claude-sonnet-5", available: true },
    { spec: "anthropic/claude-opus-5", available: true },
    { spec: "openai/gpt-5", available: false },
    { spec: "ollama/llama3.3", available: false },
  ]
  const catalog: ProviderCatalogEntry[] = [
    { name: "anthropic", connected: true },
    { name: "openai", connected: false },
    { name: "ollama", connected: false },
    { name: "moonshot", connected: false },
  ]

  test("level-1 lists connected providers first with a connect row at the bottom", () => {
    const onProviderConnect = () => {}
    const inst = render(
      React.createElement(ModelPicker, {
        models,
        current: "anthropic/claude-sonnet-5",
        onSelect: () => {},
        onCancel: () => {},
        providerCatalog: catalog,
        onProviderConnect,
      }),
    )
    const frame = inst.lastFrame() ?? ""
    // Title and a connected provider.
    expect(frame).toContain("switch model")
    expect(frame).toContain("anthropic")
    // A model count hint.
    expect(frame).toContain("2 models")
    // Unconnected catalog providers are present too.
    expect(frame).toContain("openai")
    expect(frame).toContain("unconnected")
    // The connect row at the bottom.
    expect(frame).toContain("+ connect a provider")
    // Two-level nav hint in the footer.
    expect(frame).toContain("esc back")
    inst.unmount()
  })

  test("level-1 hides the connect row when no host hook is wired", () => {
    const inst = render(
      React.createElement(ModelPicker, {
        models,
        current: "anthropic/claude-sonnet-5",
        onSelect: () => {},
        onCancel: () => {},
        providerCatalog: catalog,
        // onProviderConnect omitted -> row hidden
      }),
    )
    const frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("+ connect a provider")
    inst.unmount()
  })
})

describe("ConnectDialog masked input", () => {
  const catalog: ProviderCatalogEntry[] = [
    { name: "anthropic", connected: true },
    { name: "openai", connected: false },
    { name: "openrouter", connected: false },
  ]

  test("provider chooser lists unconnected providers first", () => {
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: catalog,
        onConnect: () => {},
        onCancel: () => {},
      }),
    )
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("connect a provider")
    // Unconnected first.
    const openaiIdx = frame.indexOf("openai")
    const anthropicIdx = frame.indexOf("anthropic")
    expect(openaiIdx).toBeGreaterThanOrEqual(0)
    expect(anthropicIdx).toBeGreaterThanOrEqual(0)
    expect(openaiIdx).toBeLessThan(anthropicIdx)
    // Connected provider shows its status.
    expect(frame).toContain("connected")
    inst.unmount()
  })

  test("mask: typed key never echoes; asterisks track length", async () => {
    const calls: { provider: string; key: string; url?: string }[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: catalog,
        onConnect: (provider, apiKey, baseURL?) => calls.push({ provider, key: apiKey, url: baseURL }),
        onCancel: () => {},
      }),
    )
    // Select the first unconnected provider (openai, index 0).
    inst.stdin.write("\r") // enter
    await new Promise((r) => setTimeout(r, 50))
    let frame = inst.lastFrame() ?? ""
    expect(frame).toContain("connect openai")
    expect(frame).toContain("paste your API key")
    // The real key must never appear in the frame; only asterisks.
    inst.stdin.write("sk-secret")
    await new Promise((r) => setTimeout(r, 50))
    frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("sk-secret")
    expect(frame).toContain("*********") // 9 asterisks for "sk-secret"
    // Tab to the base URL field. openai has no default, so the placeholder stays.
    inst.stdin.write("\t")
    await new Promise((r) => setTimeout(r, 50))
    frame = inst.lastFrame() ?? ""
    expect(frame).toContain("url")
    // Enter saves — the host sees the un-masked key.
    inst.stdin.write("\r")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe("openai")
    expect(calls[0]!.key).toBe("sk-secret")
    expect(calls[0]!.url).toBeUndefined()
    inst.unmount()
  })

  test("base URL pre-fills with the provider default", async () => {
    const calls: { provider: string; key: string; url?: string }[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: catalog,
        onConnect: (provider, apiKey, baseURL?) => calls.push({ provider, key: apiKey, url: baseURL }),
        onCancel: () => {},
      }),
    )
    // Sorted unconnected-first alphabetical: openai(0), openrouter(1), anthropic(2).
    // Press down once to land on openrouter, then enter.
    inst.stdin.write("\x1b[B") // down arrow
    await new Promise((r) => setTimeout(r, 50))
    inst.stdin.write("\r")
    await new Promise((r) => setTimeout(r, 50))
    let frame = inst.lastFrame() ?? ""
    expect(frame).toContain("connect openrouter")
    inst.stdin.write("or-key")
    await new Promise((r) => setTimeout(r, 50))
    inst.stdin.write("\t")
    await new Promise((r) => setTimeout(r, 50))
    frame = inst.lastFrame() ?? ""
    expect(frame).toContain("https://openrouter.ai/api/v1")
    inst.stdin.write("\r")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe("openrouter")
    expect(calls[0]!.key).toBe("or-key")
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1")
    inst.unmount()
  })

  test("Esc at the form returns to the provider chooser (not cancel)", async () => {
    const cancels: number[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: catalog,
        onConnect: () => {},
        onCancel: () => cancels.push(1),
      }),
    )
    inst.stdin.write("\r") // enter the form
    await new Promise((r) => setTimeout(r, 50))
    inst.stdin.write("\u001b") // esc -> back
    await new Promise((r) => setTimeout(r, 50))
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("connect a provider")
    expect(cancels).toHaveLength(0)
    inst.unmount()
  })
})
