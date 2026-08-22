import { beforeEach, describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { Message } from "../src/types/message.ts"
import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { Banner, BANNER_HEIGHT } from "../src/tui/components/Banner.tsx"
import { Breadcrumb, breadcrumbRenders } from "../src/tui/components/Breadcrumb.tsx"
import { PermissionDialog } from "../src/tui/components/PermissionDialog.tsx"
import { SpinnerProvider } from "../src/tui/components/Spinner.tsx"
import { StatusBar, TurnOutcome } from "../src/tui/components/StatusBar.tsx"
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

describe("banner: printed once, into scrollback", () => {
  test("it is the first thing on screen and carries the four session facts", () => {
    const { inst } = mount({ contextLimit: 200_000 })
    const frame = inst.lastFrame() ?? ""
    const lines = frame.split("\n")
    expect(lines[0]?.startsWith("╭")).toBe(true)
    expect(frame).toContain("haxford v")
    expect(frame).toContain("Welcome back,")
    expect(frame).toContain("anthropic/claude-sonnet-5")
    expect(frame).toContain("200k ctx")
    expect(frame).toContain("/tmp/project")
    inst.unmount()
  })

  test("its rendered height matches the constant the pin math subtracts", () => {
    // If these drift the padding is wrong by exactly the drift, which is the
    // kind of bug that looks like "the layout is just a bit off".
    const rendered = frameOf(
      React.createElement(Banner, { model: "a/b", cwd: "/tmp", env: { USER: "harry" } }),
    )
    expect(rendered.split("\n")).toHaveLength(BANNER_HEIGHT)
  })

  test("it survives a streaming reply without being redrawn a second time", async () => {
    const { store, inst } = mount()
    for (let i = 0; i < 8; i++) {
      store.dispatch({ type: "message.updated", message: assistantText("m1", "x".repeat(i + 1)) })
      await flush(5)
    }
    // Ink prints a <Static> item once and never revisits it. One occurrence
    // after a burst of re-renders is the whole lifetime guarantee.
    expect(count(inst.lastFrame() ?? "", "Welcome back,")).toBe(1)
    inst.unmount()
  })

  test("settled messages join it in scrollback, below it, in order", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "message.updated", message: assistantText("m1", "first reply") })
    store.dispatch({ type: "message.updated", message: assistantText("m2", "second reply") })
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(count(frame, "Welcome back,")).toBe(1)
    expect(frame.indexOf("Welcome back,")).toBeLessThan(frame.indexOf("first reply"))
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
    expect(inst.lastFrame() ?? "").toContain("Welcome back,")
    inst.unmount()
  })
})

// ---------------------------------------------------------------------------

describe("breadcrumb: redraws only when what it says changes", () => {
  beforeEach(() => { breadcrumbRenders.count = 0 })

  test("shows mode, short model, and the way to change it", () => {
    const { inst } = mount()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("build")
    expect(frame).toContain("claude-sonnet-5")
    expect(frame).toContain("/model to change")
    // Short: the provider is in the banner and does not need repeating here.
    const line = frame.split("\n").find((l) => l.includes("/model to change")) ?? ""
    expect(line).not.toContain("anthropic/")
    inst.unmount()
  })

  test("a streaming reply does not redraw it", async () => {
    const { store, inst } = mount()
    await flush()
    const afterMount = breadcrumbRenders.count
    for (let i = 0; i < 10; i++) {
      store.dispatch({ type: "part.delta", messageID: "m1", partID: "p1", delta: "tok " })
      store.dispatch({ type: "message.updated", message: assistantText("m1", "x".repeat(i + 1)) })
      await flush(5)
    }
    // Ten re-renders of the tree, zero of this line.
    expect(breadcrumbRenders.count).toBe(afterMount)
    inst.unmount()
  })

  test("a mode change redraws it exactly once", () => {
    const before = breadcrumbRenders.count
    const inst = render(React.createElement(Breadcrumb, { mode: "build", model: "a/b" }))
    inst.rerender(React.createElement(Breadcrumb, { mode: "build", model: "a/b" }))
    inst.rerender(React.createElement(Breadcrumb, { mode: "build", model: "a/b" }))
    expect(breadcrumbRenders.count - before).toBe(1)
    inst.rerender(React.createElement(Breadcrumb, { mode: "plan", model: "a/b" }))
    expect(breadcrumbRenders.count - before).toBe(2)
    expect(inst.lastFrame() ?? "").toContain("plan")
    inst.unmount()
  })

  test("a model change redraws it exactly once", () => {
    const before = breadcrumbRenders.count
    const inst = render(React.createElement(Breadcrumb, { mode: "build", model: "a/one" }))
    inst.rerender(React.createElement(Breadcrumb, { mode: "build", model: "a/two" }))
    expect(breadcrumbRenders.count - before).toBe(2)
    expect(inst.lastFrame() ?? "").toContain("two")
    inst.unmount()
  })

  test("it sits directly above the input", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    const crumb = lines.findIndex((l) => l.includes("/model to change"))
    const rule = lines.findIndex((l, i) => i > crumb && /^─+$/.test(l.trim()))
    const input = lines.findIndex((l) => l.includes("ask anything"))
    expect(crumb).toBeGreaterThan(0)
    expect(rule).toBe(crumb + 1)
    expect(input).toBe(rule + 1)
    inst.unmount()
  })
})

// ---------------------------------------------------------------------------

describe("footer: one line, busy or idle", () => {
  test("idle shows the mode, the ctx figure, and the pointer", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle",
        usage: { input: 1000, output: 0, reasoning: 0 }, contextLimit: 100_000,
      }),
    )
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
    expect(frame).toContain("build")
    expect(frame).toContain("mode (tab to cycle)")
    expect(frame).toContain("ctx 1%")
    expect(frame).toContain("/help")
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
        }),
      }),
    )
    const glyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    expect(glyphs.some((g) => frame.includes(g))).toBe(true)
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
    // The busy mark leads, so "is it working" is answered where scanning starts.
    const line = frame.split("\n").find((l) => l.trim().length > 0) ?? ""
    expect(glyphs.some((g) => line.indexOf(g) < line.indexOf("build"))).toBe(true)
  })

  test("the full keybinding reference is not in the footer", () => {
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "a/b", mode: "build", status: "idle", usage: NO_USAGE,
      }),
    )
    for (const key of ["esc", "ctrl+c", "ctrl+o", "enter", "↑"]) {
      expect(frame).not.toContain(key)
    }
  })

  test("the model and cwd are not repeated here", () => {
    // Both are one line up, or in the banner. Repeating them costs the row
    // that everything else in this footer had to earn.
    const frame = frameOf(
      React.createElement(StatusBar, {
        model: "anthropic/claude-sonnet-5", mode: "build", status: "idle", usage: NO_USAGE,
      }),
    )
    expect(frame).not.toContain("claude-sonnet-5")
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
  test("a fresh session fills the viewport and lands the footer on the last row", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    // ink-testing-library reports no rows, so the layout uses the 24-row
    // default; the frame should fill it exactly rather than floating.
    expect(lines).toHaveLength(24)
    expect(lines[lines.length - 1]).toContain("mode (tab to cycle)")
    inst.unmount()
  })

  test("the padding is blank lines above the live region, not below it", () => {
    const { inst } = mount()
    const lines = (inst.lastFrame() ?? "").split("\n")
    const blanks = lines.filter((l) => l.trim().length === 0).length
    expect(blanks).toBeGreaterThan(5)
    // Nothing blank after the footer: the pin is achieved by pushing down.
    expect(lines[lines.length - 1]?.trim().length).toBeGreaterThan(0)
    inst.unmount()
  })

  test("transcript growth takes the padding back", async () => {
    const { store, inst } = mount()
    const before = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length === 0).length
    store.dispatch({
      type: "message.updated",
      message: assistantText("m1", Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n")),
    })
    await flush()
    const after = (inst.lastFrame() ?? "").split("\n").filter((l) => l.trim().length === 0).length
    expect(after).toBeLessThan(before)
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
    // Banner, breadcrumb, and picker all name the same thing; a single token
    // is what stops that becoming three treatments of one concept.
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

  test("both the banner and the breadcrumb print the model", () => {
    const banner = frameOf(
      React.createElement(Banner, { model: "anthropic/claude-sonnet-5", cwd: "/tmp" }),
    )
    const crumb = frameOf(
      React.createElement(Breadcrumb, { mode: "build", model: "anthropic/claude-sonnet-5" }),
    )
    expect(banner).toContain("anthropic/claude-sonnet-5")
    expect(crumb).toContain("claude-sonnet-5")
  })
})
