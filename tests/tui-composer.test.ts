import { describe, expect, test } from "bun:test"
import React from "react"

import { Composer, type ComposerHandle } from "../src/tui/components/Composer.tsx"
import { renderFixed } from "./helpers/ink.ts"

function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Mounted {
  inst: ReturnType<typeof renderFixed>
  values: string[]
  submits: string[]
  handleRef: React.MutableRefObject<ComposerHandle | undefined>
}

function mount(overrides: { onPopQueued?: () => string | undefined } = {}): Mounted {
  const values: string[] = []
  const submits: string[] = []
  const handleRef: React.MutableRefObject<ComposerHandle | undefined> = { current: undefined }
  const inst = renderFixed(
    React.createElement(Composer, {
      disabled: false,
      onSubmit: (v: string) => submits.push(v),
      onValueChange: (v: string) => values.push(v),
      onPopQueued: overrides.onPopQueued,
      handleRef,
    }),
  )
  return { inst, values, submits, handleRef }
}

/* -------------------------------------------------------------------------- */
/* newline insertion, mid-string                                              */
/* -------------------------------------------------------------------------- */

describe("newline insertion", () => {
  test("Alt+Enter inserts a newline mid-string, not a submit", async () => {
    const { inst, values, submits } = mount()
    inst.stdin.write("helloworld")
    await flush()
    // Move left 5 to sit between "hello" and "world".
    for (let i = 0; i < 5; i++) inst.stdin.write("[D")
    await flush()
    inst.stdin.write("\r") // ESC + CR — the portable Alt+Enter encoding
    await flush()
    expect(submits).toEqual([])
    expect(values.at(-1)).toBe("hello\nworld")
    inst.unmount()
  })

  test("a Kitty-protocol Shift+Enter (CSI-u) also inserts a newline", async () => {
    const { inst, values, submits } = mount()
    inst.stdin.write("helloworld")
    await flush()
    for (let i = 0; i < 5; i++) inst.stdin.write("[D")
    await flush()
    // CSI 13 ; 2 u — Kitty's disambiguated encoding for Enter+Shift. Ink
    // decodes this into key.return + key.shift on its own; nothing in
    // Composer.tsx parses raw escape bytes.
    inst.stdin.write("[13;2u")
    await flush()
    expect(submits).toEqual([])
    expect(values.at(-1)).toBe("hello\nworld")
    inst.unmount()
  })

  test("the buffer keeps growing across multiple inserted lines", async () => {
    const { inst, values } = mount()
    inst.stdin.write("first")
    await flush()
    inst.stdin.write("\r")
    inst.stdin.write("second")
    await flush()
    inst.stdin.write("\r")
    inst.stdin.write("third")
    await flush()
    expect(values.at(-1)).toBe("first\nsecond\nthird")
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* plain Enter submits                                                        */
/* -------------------------------------------------------------------------- */

describe("plain Enter submits", () => {
  test("submits the typed text and clears the composer", async () => {
    const { inst, submits, values } = mount()
    inst.stdin.write("fix the bug in src/index.ts")
    await flush()
    inst.stdin.write("\r")
    await flush()
    expect(submits).toEqual(["fix the bug in src/index.ts"])
    // Cleared after submit.
    expect(values.at(-1)).toBe("")
    inst.unmount()
  })

  test("submitting a multiline message trims trailing empty lines", async () => {
    const { inst, submits } = mount()
    inst.stdin.write("line one")
    await flush()
    inst.stdin.write("\r") // newline
    inst.stdin.write("line two")
    await flush()
    inst.stdin.write("\r") // another newline, leaving a trailing blank line
    await flush()
    inst.stdin.write("\r") // plain Enter — submits, trimming the trailing blank line
    await flush()
    expect(submits).toEqual(["line one\nline two"])
    inst.unmount()
  })

  test("submitting empty or whitespace-only text is a no-op", async () => {
    const { inst, submits } = mount()
    inst.stdin.write("   ")
    await flush()
    inst.stdin.write("\r")
    await flush()
    expect(submits).toEqual([])
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* trailing-backslash continuation                                            */
/* -------------------------------------------------------------------------- */

describe("trailing-backslash continuation", () => {
  test("a trailing backslash + Enter inserts a newline, swallowing the backslash", async () => {
    const { inst, submits, values } = mount()
    inst.stdin.write("continue me\\")
    await flush()
    inst.stdin.write("\r") // plain Enter — but the buffer ends in a backslash
    await flush()
    expect(submits).toEqual([]) // did not submit
    expect(values.at(-1)).toBe("continue me\n") // backslash gone, newline in its place
    inst.stdin.write("next line")
    await flush()
    inst.stdin.write("\r") // now a real submit
    await flush()
    expect(submits).toEqual(["continue me\nnext line"])
    inst.unmount()
  })

  test("a backslash NOT at the cursor does not trigger continuation", async () => {
    const { inst, submits } = mount()
    inst.stdin.write("a\\b")
    await flush()
    inst.stdin.write("\r")
    await flush()
    expect(submits).toEqual(["a\\b"])
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* backspace across a wrap boundary                                          */
/* -------------------------------------------------------------------------- */

describe("backspace across a wrap boundary", () => {
  test("deletes exactly one character, never a chunk, on a long wrapped line", async () => {
    const { inst, values } = mount()
    // renderFixed defaults to 100 columns; comfortably over this pushes the
    // line past several wrap boundaries.
    const long = "x".repeat(220)
    inst.stdin.write(long)
    await flush()
    inst.stdin.write("") // backspace (DEL byte) — same convention as tests/connect-verify.test.ts
    await flush()
    expect(values.at(-1)).toBe("x".repeat(219))
    // A second backspace removes exactly one more.
    inst.stdin.write("")
    await flush()
    expect(values.at(-1)).toBe("x".repeat(218))
    inst.unmount()
  })

  test("backspacing back across many wrapped rows lands on the exact expected length", async () => {
    const { inst, values } = mount()
    const long = "y".repeat(150)
    inst.stdin.write(long)
    await flush()
    for (let i = 0; i < 30; i++) inst.stdin.write("")
    await flush()
    expect(values.at(-1)).toBe("y".repeat(120))
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* queue-pop still works                                                      */
/* -------------------------------------------------------------------------- */

describe("queue-pop still works", () => {
  test("up-arrow on an empty composer pops the most recently queued prompt", async () => {
    let queue = ["queued one", "queued two"]
    const popped: string[] = []
    const { inst, values } = mount({
      onPopQueued: () => {
        const last = queue[queue.length - 1]
        if (last === undefined) return undefined
        queue = queue.slice(0, -1)
        popped.push(last)
        return last
      },
    })
    inst.stdin.write("[A") // up arrow, composer is empty
    await flush()
    expect(popped).toEqual(["queued two"])
    expect(values.at(-1)).toBe("queued two")
    inst.unmount()
  })

  test("up-arrow does not consult the queue once the composer has text", async () => {
    let calls = 0
    const { inst } = mount({
      onPopQueued: () => {
        calls++
        return "should not be used"
      },
    })
    inst.stdin.write("typing something")
    await flush()
    inst.stdin.write("[A")
    await flush()
    expect(calls).toBe(0)
    inst.unmount()
  })

  test("multiline cursor navigation still wins over queue-pop when not on the first line", async () => {
    // Regression guard for the priority order item 2 asks for: line
    // navigation beats queue/history fallback whenever there IS another
    // line to move to, even with items sitting in the queue.
    let queueCalls = 0
    const { inst, values } = mount({ onPopQueued: () => { queueCalls++; return "nope" } })
    inst.stdin.write("first")
    await flush()
    inst.stdin.write("\r") // newline
    inst.stdin.write("second")
    await flush()
    // Cursor is at the end of "second" (line 1 of 2) — up-arrow must move
    // within the buffer, not consult the queue.
    inst.stdin.write("[A")
    await flush()
    expect(queueCalls).toBe(0)
    // Value is unchanged (a pure cursor move never fires onValueChange).
    expect(values.at(-1)).toBe("first\nsecond")
    inst.unmount()
  })
})

/* -------------------------------------------------------------------------- */
/* imperative handle + basic rendering (compatibility checks)                 */
/* -------------------------------------------------------------------------- */

describe("ComposerHandle.set", () => {
  test("replaces the buffer and reports the new value", () => {
    const { inst, values, handleRef } = mount()
    expect(handleRef.current).toBeDefined()
    handleRef.current?.set("/mode ")
    expect(values.at(-1)).toBe("/mode ")
    inst.unmount()
  })
})

describe("rendering", () => {
  test("shows the placeholder when empty and the typed text once there is some", async () => {
    const { inst } = mount()
    expect(inst.lastFrame() ?? "").toContain("ask anything, or / for commands")
    inst.stdin.write("hello")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("hello")
    expect(frame).not.toContain("ask anything")
    inst.unmount()
  })

  test("a multiline buffer renders every line", async () => {
    const { inst } = mount()
    inst.stdin.write("first")
    await flush()
    inst.stdin.write("\r")
    inst.stdin.write("second")
    await flush()
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("first")
    expect(frame).toContain("second")
    inst.unmount()
  })
})
