import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { Message, ToolPart } from "../src/types/message.ts"
import { HaxfordApp } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import {
  COLLAPSED_PREVIEW_LINES,
  EXPANDED_PREVIEW_LINES,
  MessageView,
  messageIsMultiline,
  partIsMultiline,
  previewLines,
  separatorBefore,
  toolIsExpanded,
  Transcript,
} from "../src/tui/components/Transcript.tsx"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"

function flush(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function frameOf(el: React.ReactElement): string {
  const inst = render(el)
  const out = (inst.lastFrame() ?? "").split("\n").map((l) => l.trimEnd()).join("\n")
  inst.unmount()
  return out
}

/** A completed tool part carrying `output`. */
function completed(tool: string, title: string, output: string): ToolPart {
  return {
    id: `p-${tool}-${title}`,
    type: "tool",
    tool,
    callID: `c-${tool}`,
    state: { status: "completed", input: {}, output, title, time: { start: 0, end: 1 } },
  }
}

function assistant(parts: Message["parts"]): Message {
  return { id: "m1", sessionID: "s", role: "assistant", time: { created: 0 }, parts }
}

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `out line ${i + 1}`).join("\n")

describe("previewLines", () => {
  test("collapses to the collapsed budget and says how much it hid", () => {
    expect(previewLines(TEN_LINES)).toEqual([
      "out line 1",
      "out line 2",
      "out line 3",
      "… 7 more lines",
    ])
  })

  test("blank lines never spend the budget", () => {
    // Tool output is padded with blank lines far more often than it is
    // meaningfully spaced by them.
    expect(previewLines("\n\na\n\nb\n\n", 5)).toEqual(["a", "b"])
  })

  test("output that fits gets no footer", () => {
    expect(previewLines("a\nb", 3)).toEqual(["a", "b"])
  })

  test("empty output yields nothing at all", () => {
    expect(previewLines("")).toEqual([])
    expect(previewLines("   \n  ")).toEqual([])
  })
})

describe("toolIsExpanded", () => {
  test("collapsed by default", () => {
    expect(toolIsExpanded(completed("bash", "ls", "x"), false)).toBe(false)
  })

  test("the global toggle expands a settled call", () => {
    expect(toolIsExpanded(completed("bash", "ls", "x"), true)).toBe(true)
  })

  test("a running call is always expanded, toggle or not", () => {
    // It is the one thing on screen you are actively waiting on; collapsing
    // live progress hides the only information that is changing.
    const running: ToolPart = {
      id: "p", type: "tool", tool: "bash", callID: "c",
      state: { status: "running", input: {}, time: { start: 0 } },
    }
    expect(toolIsExpanded(running, false)).toBe(true)
    expect(toolIsExpanded(running, true)).toBe(true)
  })
})

describe("collapsible tool rows", () => {
  const msg = assistant([completed("bash", "ls -la", TEN_LINES)])

  test("collapsed shows the summary plus a short preview", () => {
    const frame = frameOf(React.createElement(MessageView, { message: msg }))
    expect(frame).toContain("bash")
    expect(frame).toContain("ls -la")
    expect(frame).toContain("out line 1")
    expect(frame).toContain(`out line ${COLLAPSED_PREVIEW_LINES}`)
    expect(frame).not.toContain(`out line ${COLLAPSED_PREVIEW_LINES + 1}`)
    expect(frame).toContain("… 7 more lines")
  })

  test("expanded shows all of it and drops the footer", () => {
    const frame = frameOf(
      React.createElement(MessageView, { message: msg, toolsExpanded: true }),
    )
    expect(frame).toContain("out line 1")
    expect(frame).toContain("out line 10")
    expect(frame).not.toContain("more lines")
  })

  test("a tool call with no output stays a single row either way", () => {
    const bare = assistant([completed("todo", "3 items", "")])
    for (const toolsExpanded of [false, true]) {
      const frame = frameOf(React.createElement(MessageView, { message: bare, toolsExpanded }))
      expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1)
      expect(frame).toContain("todo")
    }
  })

  test("even expanded, output is capped so a huge read cannot run away", () => {
    const huge = Array.from({ length: EXPANDED_PREVIEW_LINES + 25 }, (_, i) => `l${i}`).join("\n")
    const frame = frameOf(
      React.createElement(MessageView, { message: assistant([completed("read", "big.txt", huge)]), toolsExpanded: true }),
    )
    expect(frame).toContain("… 25 more lines")
  })

  test("diff-shaped output renders as a diff at both sizes", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " context",
      "-removed",
      "+added",
      " tail",
      "@@ -9,2 +9,2 @@",
      "-second removal",
      "+second addition",
    ].join("\n")
    const message = assistant([completed("edit", "src/x.ts", diff)])

    const collapsed = frameOf(React.createElement(MessageView, { message }))
    expect(collapsed).toContain("-removed")
    expect(collapsed).toContain("+added")

    const expanded = frameOf(React.createElement(MessageView, { message, toolsExpanded: true }))
    expect(expanded).toContain("+second addition")
  })

  test("the flag reaches tool parts through Transcript too", () => {
    const collapsed = frameOf(React.createElement(Transcript, { messages: [msg] }))
    const expanded = frameOf(
      React.createElement(Transcript, { messages: [msg], toolsExpanded: true }),
    )
    expect(collapsed).not.toContain("out line 10")
    expect(expanded).toContain("out line 10")
  })
})

describe("store.setToolsExpanded", () => {
  test("starts collapsed", () => {
    expect(createTuiStore([]).getState().toolsExpanded).toBe(false)
  })

  test("sets the value and notifies", () => {
    const store = createTuiStore([])
    let notifications = 0
    store.subscribe(() => { notifications++ })
    expect(store.setToolsExpanded(true)).toBe(true)
    expect(store.getState().toolsExpanded).toBe(true)
    expect(notifications).toBe(1)
  })

  test("setting the value it already holds does not notify", () => {
    const store = createTuiStore([])
    let notifications = 0
    store.subscribe(() => { notifications++ })
    store.setToolsExpanded(false)
    expect(notifications).toBe(0)
  })

  test("the flag survives a reset, because it is a view preference", () => {
    // /clear and resume replace the transcript; they do not un-choose a
    // setting the user just made.
    const store = createTuiStore([])
    store.setToolsExpanded(true)
    store.reset([])
    expect(store.getState().toolsExpanded).toBe(true)
  })

  test("a reset still clears the transcript state it owns", () => {
    const store = createTuiStore([])
    store.dispatch({ type: "notice", message: "n" })
    store.setToolsExpanded(true)
    store.reset([])
    expect(store.getState().notices).toEqual([])
    expect(store.getState().epoch).toBe(1)
  })
})

describe("ctrl+o in the app", () => {
  function mount(): { store: TuiStore; inst: ReturnType<typeof render> } {
    const store = createTuiStore([])
    const inst = render(
      React.createElement(HaxfordApp, {
        store,
        bridge: createApprovalBridge(),
        model: "mock/demo",
        mode: "build",
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

  test("ctrl+o toggles the flag and hints what it did", async () => {
    const { store, inst } = mount()
    inst.stdin.write("\x0f") // ctrl+o
    await flush()
    expect(store.getState().toolsExpanded).toBe(true)
    expect(inst.lastFrame() ?? "").toContain("tool output expanded")

    inst.stdin.write("\x0f")
    await flush()
    expect(store.getState().toolsExpanded).toBe(false)
    expect(inst.lastFrame() ?? "").toContain("tool output collapsed")
    inst.unmount()
  })

  test("ctrl+o does not leak an 'o' into the composer", async () => {
    // @inkjs/ui's TextInput filters only ctrl+c out of its own handler and
    // inserts every other chord as a character.
    const { inst } = mount()
    inst.stdin.write("\x0f")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("ask anything")
    expect(frame).not.toMatch(/›\s+o\s*$/m)
    inst.unmount()
  })

  test("ctrl+o keeps text already typed into the composer", async () => {
    const { inst } = mount()
    inst.stdin.write("hello")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("hello")
    inst.stdin.write("\x0f")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("hello")
    expect(frame).not.toContain("helloo")
    inst.unmount()
  })

  test("toggling leaves the transcript itself untouched", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "message.updated", message: assistant([completed("bash", "ls", TEN_LINES)]) })
    await flush()
    const before = store.getState().messages
    inst.stdin.write("\x0f")
    await flush()
    expect(store.getState().messages).toEqual(before)
    expect(store.getState().notices).toEqual([])
    inst.unmount()
  })

  test("the live tail re-renders at the new size", async () => {
    const { store, inst } = mount()
    store.dispatch({ type: "message.updated", message: assistant([completed("bash", "ls", TEN_LINES)]) })
    await flush()
    expect(inst.lastFrame() ?? "").not.toContain("out line 10")
    inst.stdin.write("\x0f")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("out line 10")
    inst.unmount()
  })
})

describe("spacing rules stay shared", () => {
  test("separatorBefore is re-exported from Transcript", () => {
    expect(separatorBefore(undefined, true)).toBe(0)
    expect(separatorBefore(false, false)).toBe(0)
    expect(separatorBefore(true, false)).toBe(1)
    expect(separatorBefore(false, true)).toBe(1)
  })

  test("a tool part with output counts as multiline", () => {
    expect(partIsMultiline(completed("bash", "ls", "one line"))).toBe(true)
    expect(partIsMultiline(completed("todo", "done", ""))).toBe(false)
    expect(partIsMultiline(completed("todo", "done", "   \n "))).toBe(false)
  })

  test("a one-line text part does not force air around itself", () => {
    expect(partIsMultiline({ id: "t", type: "text", text: "hello" })).toBe(false)
    expect(partIsMultiline({ id: "t", type: "text", text: "a\nb" })).toBe(true)
  })

  test("messageIsMultiline follows its parts", () => {
    expect(messageIsMultiline(assistant([{ id: "t", type: "text", text: "hi" }]))).toBe(false)
    expect(messageIsMultiline(assistant([completed("bash", "ls", "x")]))).toBe(true)
    expect(messageIsMultiline({ ...assistant([]), error: "boom" })).toBe(true)
  })
})

describe("assistant prose is markdown; the user's is not", () => {
  test("an assistant text part is rendered as markdown", () => {
    const frame = frameOf(
      React.createElement(MessageView, {
        message: assistant([{ id: "t", type: "text", text: "# Title\n\nwith **bold**" }]),
      }),
    )
    expect(frame).toContain("Title")
    expect(frame).toContain("with bold")
    expect(frame).not.toContain("**")
    expect(frame).not.toContain("# Title")
  })

  test("a user text part is shown exactly as typed", () => {
    // Rendering the user's own markdown would mean showing them something
    // other than what they wrote.
    const frame = frameOf(
      React.createElement(MessageView, {
        message: {
          id: "u1", sessionID: "s", role: "user", time: { created: 0 },
          parts: [{ id: "t", type: "text", text: "run **this** and `that`" }],
        },
      }),
    )
    expect(frame).toContain("run **this** and `that`")
    expect(frame).toContain("›")
  })
})
