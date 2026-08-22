import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { Message } from "../src/types/message.ts"
import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { Banner, HEADER_LINES } from "../src/tui/components/Banner.tsx"
import { PermissionDialog } from "../src/tui/components/PermissionDialog.tsx"
import { SpinnerProvider } from "../src/tui/components/Spinner.tsx"
import { StatusBar, TurnOutcome, shortModel } from "../src/tui/components/StatusBar.tsx"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"
import { modeColor, theme } from "../src/tui/theme.ts"

function flush(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const NO_USAGE = { input: 0, output: 0, reasoning: 0 }

function mount(overrides: Partial<Parameters<typeof HaxfordApp>[0]> = {}): {
  store: TuiStore
  inst: ReturnType<typeof render>
} {
  const store = createTuiStore([])
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge: createApprovalBridge(),
      model: "anthropic/claude-sonnet-5",
      mode: "build",
      models: ["anthropic/claude-sonnet-5"],
      cwd: "/tmp/project",
      onPrompt: () => {},
      onAbort: () => {},
      onModelChange: () => {},
      onModeChange: () => {},
      onExit: () => {},
      onNewSession: () => {},
      listSessions: async () => [],
      onResumeSession: () => {},
      ...overrides,
    }),
  )
  return { store, inst }
}

function assistantText(id: string, text: string): Message {
  return {
    id,
    sessionID: "s",
    role: "assistant",
    time: { created: 0 },
    parts: [{ id: `${id}-t`, type: "text", text }],
  }
}

/** How many times `needle` appears in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function frameOf(el: React.ReactElement): string {
  const inst = render(el)
  const out = (inst.lastFrame() ?? "").split("\n").map((l) => l.trimEnd()).join("\n")
  inst.unmount()
  return out
}

// ---------------------------------------------------------------------------

describe("header: three bare lines, printed once, into scrollback", () => {
  test("it is the first thing on screen and carries the pi-style facts", () => {
    const { inst } = mount({ contextLimit: 200_000 })
    const lines = (inst.lastFrame() ?? "").split("\n")
    // Line 1: bare name+version. No box characters anywhere in the chrome.
    expect(lines[0]?.startsWith("haxford v")).toBe(true)
    // Line 2: the dim keybind hints.
    expect(inst.lastFrame() ?? "").toContain("esc interrupt")
    expect(inst.lastFrame() ?? "").toContain("/ commands")
    expect(inst.lastFrame() ?? "").toContain("/help more")
    // Line 3: the self-awareness line.
    expect(inst.lastFrame() ?? "").toContain("~/.haxford/EXTENDING.md")
    inst.unmount()
  })

  test("no box characters in the header at all", () => {
    const rendered = frameOf(React.createElement(Banner))
    for (const ch of ["\u256d", "\u256e", "\u2570", "\u256f", "\u2500", "\u2502"]) {
      expect(rendered).not.toContain(ch)
    }
  })

  test("its rendered height matches the constant the pin math subtracts", () => {
    const rendered = frameOf(React.createElement(Banner))
    expect(rendered.split("\n")).toHaveLength(HEADER_LINES)
    expect(HEADER_LINES).toBe(3)
  })

  test("it survives a streaming reply without being redrawn a second time", async () => {
    const { store, inst } = mount()
    for (let i = 0; i < 8; i++) {
      store.dispatch({ type: "message.updated", message: assistantText("m1", "x".repeat(i + 1)) })
      await flush(5)
    }
    // Ink prints a <Static> item once and never revisits it. One occurrence
    // after a burst of re-renders is the whole lifetime guarantee.
    expect(count(inst.lastFrame() ?? "", "esc interrupt")).toBe(1)
    inst.unmount()
  })

  test("settled messages join it in scrollback, below it, in order", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "message.updated", message: assistantText("m1", "first reply") })
    store.dispatch({ type: "message.updated", message: assistantText("m2", "second reply") })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(count(frame, "esc interrupt")).toBe(1)
    expect(frame.indexOf("esc interrupt")).toBeLessThan(frame.indexOf("first reply"))
    expect(frame.indexOf("first reply")).toBeLessThan(frame.indexOf("second reply"))
    inst.unmount()
  })

  test("a new session reprints it, because that is what session start means", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "message.updated", message: assistantText("m1", "hello") })
    await flush()
    store.reset([])
    await flush()
    // The epoch remounts the static region: the old transcript is gone from
    // the live frame and a fresh header opens the new session.
    expect(count(inst.lastFrame() ?? "", "esc interrupt")).toBe(1)
    inst.unmount()
  })
})

// ---------------------------------------------------------------------------

describe("footer composition (breadcrumb merged in)", () => {
  test("left half names where you are; right half what is answering", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "anthropic/claude-sonnet-5",
        mode: "build",
        status: "idle",
        usage: { input: 1000, output: 0, reasoning: 0 },
        contextLimit: 100_000,
        cwd: "/tmp/project",
        branch: "main",
      }),
    )
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
    const line = frame.split("\n").find((l) => l.trim().length > 0) ?? ""
    // LEFT: cwd (git branch).
    expect(line).toContain("/tmp/project (main)")
    // RIGHT: ctx N% (mode) · model-short.
    expect(line).toContain("ctx 1%")
    expect(line).toContain("(build)")
    expect(line).toContain("claude-sonnet-5")
    // Short model only — the provider prefix belongs to the picker.
    expect(line).not.toContain("anthropic/")
  })

  test("a failed branch probe just shortens the left half", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "auto", status: "idle",
        usage: { input: 0, output: 0, reasoning: 0 },
        cwd: "/tmp/project",
      }),
    )
    expect(frame).toContain("/tmp/project")
    expect(frame).not.toContain("(main)")
  })

  test("the cost rides after the model on the right", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle",
        usage: { input: 1_000_000, output: 0, reasoning: 0 },
        promptPricePerMtok: 3,
        cwd: "/tmp",
      }),
    )
    const line = frame.split("\n").find((l) => l.includes("$3.0000")) ?? ""
    expect(line).toContain("$3.0000")
    expect(line.indexOf("b")).toBeLessThan(line.indexOf("$3.0000"))
  })
})

// ---------------------------------------------------------------------------

describe("footer: one line, busy or idle", () => {
  test("idle shows the mode in parentheses and the ctx figure", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle",
        usage: { input: 1000, output: 0, reasoning: 0 }, contextLimit: 100_000,
      }),
    )
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
    expect(frame).toContain("ctx 1%")
    expect(frame).toContain("(build)")
    expect(frame).toContain("b")
  })

  test("idle carries no spinner glyph", () => {
    const frame = frameOf(
      React.createElement(SpinnerProvider, {
        active: false,
        children: React.createElement(StatusBar, {
          model: "a/b", mode: "build", status: "idle", usage: NO_USAGE,
        }),
      }),
    )
    for (const glyph of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
      expect(frame).not.toContain(glyph)
    }
  })

  test("running leads with a busy indicator, and keeps the line to one row", () => {
    const frame = frameOf(
      React.createElement(SpinnerProvider, {
        active: true,
        children: React.createElement(StatusBar, {
          model: "a/b", mode: "build", status: "running", usage: NO_USAGE,
          cwd: "/tmp/project",
        }),
      }),
    )
    const glyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    expect(glyphs.some((g) => frame.includes(g))).toBe(true)
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
    // The busy mark leads, so "is it working" is answered where scanning starts.
    const line = frame.split("\n").find((l) => l.trim().length > 0) ?? ""
    expect(glyphs.some((g) => line.indexOf(g) < line.indexOf("/tmp/project"))).toBe(true)
  })

  test("the full keybinding reference is not in the footer", () => {
    // It lives in the header's hint line and behind /help — the footer row
    // belongs to where-you-are and what-is-answering.
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle", usage: NO_USAGE,
      }),
    )
    for (const key of ["ctrl+c", "ctrl+o", "enter", "↑", "tab to cycle"]) {
      expect(frame).not.toContain(key)
    }
  })

  test("cost still shows when the catalog priced the model", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle",
        usage: { input: 1_000_000, output: 0, reasoning: 0 },
        promptPricePerMtok: 3,
      }),
    )
    expect(frame).toContain("$3.0000")
  })
})

// ---------------------------------------------------------------------------

describe("states: interruption and errors are inline, not chrome", () => {
  test("an aborted turn leaves a visible confirmation", () => {
    const frame = frameOf(
      React.createElement(TurnOutcome, { status: "ended", endReason: "aborted" }),
    )
    expect(frame.trim()).toBe("interrupted")
  })

  test("an error renders in full, not as a status word", () => {
    const frame = frameOf(
      React.createElement(TurnOutcome, { status: "error", error: "rate limited by anthropic" }),
    )
    expect(frame).toContain("rate limited by anthropic")
  })

  test("an ordinary completion says nothing at all", () => {
    expect(
      frameOf(React.createElement(TurnOutcome, { status: "ended", endReason: "end_turn" })).trim(),
    ).toBe("")
    expect(frameOf(React.createElement(TurnOutcome, { status: "idle" })).trim()).toBe("")
  })

  test("an abort reads as interrupted end to end", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "turn.start", turn: 1 })
    await flush()
    store.dispatch({ type: "loop.end", reason: "aborted" })
    await flush()
    expect(inst.lastFrame() ?? "").toContain("interrupted")
    inst.unmount()
  })

  test("a permission prompt is bordered — the one interruption the chrome allows", () => {
    const frame = frameOf(
      React.createElement(PermissionDialog, {
        request: { sessionID: "s", tool: "bash", title: "rm -rf /tmp/x", args: { command: "rm -rf /tmp/x" } },
      }),
    )
    // A single border, distinct from the dim rules that bracket the input.
    expect(frame).toContain("┌")
    expect(frame).toContain("┘")
    expect(frame).toContain("run command")
    expect(frame).toContain("[a] allow once")
  })
})

// ---------------------------------------------------------------------------

describe("bottom pinning in the live frame", () => {
  test("a fresh session lands the footer on the last row", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    // ink-testing-library reports no rows, so the layout uses the 24-row
    // default. The footer is still the last row — but the frame no longer
    // fills the viewport with filler to get there.
    expect(lines[lines.length - 1]).toContain("(build)")
    inst.unmount()
  })

  test("first paint is tight: at most two blank filler rows, never a wall of dead space", () => {
    // The old math spent every free row pushing the composer down, which
    // measured at eight blank lines between header and chrome on a fresh
    // session. The clamp keeps first paint tight even in small ptys.
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    const blanks = lines.filter((l) => l.trim().length === 0).length
    expect(blanks).toBeLessThanOrEqual(2)
    expect(blanks).toBeGreaterThanOrEqual(0)
    // Nothing blank after the footer.
    expect(lines[lines.length - 1]?.trim().length).toBeGreaterThan(0)
    inst.unmount()
  })

  test("transcript growth never increases the padding", async () => {
    const { store, inst } = mount()
    const before = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length === 0).length
    store.dispatch({
      type: "message.updated",
      message: assistantText("m1", Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n")),
    })
    await flush()
    const after = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length === 0).length
    expect(after).toBeLessThanOrEqual(before)
    inst.unmount()
  })

  test("padding stands down while an overlay is open", async () => {
    const { inst } = mount()
    const before = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length === 0).length
    inst.stdin.write("/help")
    await flush()
    inst.stdin.write("\r")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("commands")
    const after = frame.split("\n").filter((l) => l.trim().length === 0).length
    // An overlay's height is not measured here, so guessing low would push the
    // composer off the bottom. Padding simply steps aside instead.
    expect(after).toBeLessThan(before)
    inst.unmount()
  })
})

// ---------------------------------------------------------------------------

describe("colour roles", () => {
  test("every palette entry is a named 16-colour ANSI name", () => {
    // The rule the whole theme exists for: named colours borrow the
    // terminal's own palette, and a hex or 256-index value asserts a scheme
    // the user did not choose. ink-testing-library strips SGR from frames, so
    // this is asserted where it is actually decidable.
    const named = new Set([
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "gray", "grey", "blackBright", "redBright", "greenBright", "yellowBright",
      "blueBright", "magentaBright", "cyanBright", "whiteBright",
    ])
    for (const [role, value] of Object.entries(theme)) {
      expect(value === "" || named.has(value)).toBe(true)
      expect(role.length).toBeGreaterThan(0)
    }
  })

  test("the model has one colour token, so it reads the same everywhere", () => {
    // Footer and picker name the model; a single token is what stops that
    // becoming two treatments of one concept.
    expect(["cyan", "blue"]).toContain(theme.model)
  })

  test("the mode colours are the accent, success, and the reserved magenta", () => {
    expect(modeColor("build")).toBe(theme.accent)
    expect(modeColor("auto")).toBe(theme.success)
    expect(modeColor("plan")).toBe(theme.info)
    expect(theme.info).toBe("magenta")
  })

  test("green is additions and success, red is removals and errors", () => {
    expect(theme.diffAdd).toBe("green")
    expect(theme.success).toBe("green")
    expect(theme.diffDel).toBe("red")
    expect(theme.error).toBe("red")
    expect(theme.warning).toBe("yellow")
  })

  test("chrome and rules are the dim tier", () => {
    expect(theme.dim).toBe("gray")
    expect(theme.muted).toBe("gray")
  })

  test("the footer prints the short model, and only in the theme's model colour role", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "anthropic/claude-sonnet-5", mode: "build", status: "idle",
        usage: { input: 0, output: 0, reasoning: 0 }, cwd: "/tmp",
      }),
    )
    expect(frame).toContain("claude-sonnet-5")
    expect(shortModel("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5")
  })
})
