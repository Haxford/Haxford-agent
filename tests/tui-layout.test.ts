import { describe, expect, test } from "bun:test"

import type { Message } from "../src/types/message.ts"
import { HEADER_LINES, tildeCwd } from "../src/tui/components/Banner.tsx"
import { DEFAULT_SIZE, readSize } from "../src/tui/hooks.ts"
import {
  FOOTER_LINES,
  INPUT_RULE_LINES,
  MAX_FILLER_LINES,
  bottomPadding,
  composerHeight,
  estimateMessageLines,
  estimateTranscriptLines,
  separatorBefore,
  wrappedLines,
} from "../src/tui/layout.ts"
import {
  BEGIN_SYNC,
  END_SYNC,
  synchronizedOutputEnabled,
  synchronizedStdout,
  wrapFrame,
} from "../src/tui/raw.ts"

/** The fixed chrome the pin math always subtracts. */
const CHROME = {
  banner: HEADER_LINES,
  input: INPUT_RULE_LINES + 1,
  footer: FOOTER_LINES,
} as const

/** Rows the chrome always occupies, whatever the transcript does. */
const USED = CHROME.banner + CHROME.input + CHROME.footer

function pad(height: number, transcript: number): number {
  return bottomPadding({ ...CHROME, height, transcript })
}

describe("bottomPadding", () => {
  test("filler is capped at MAX_FILLER_LINES however tall the terminal", () => {
    // The old math spent every free row pushing the composer to the bottom,
    // which read as a screenful of dead space between header and chrome.
    for (const height of [40, 80, 200]) {
      expect(pad(height, 0)).toBe(MAX_FILLER_LINES)
    }
  })

  test("small ptys stay tight on first paint (heights 10 / 20 / 40)", () => {
    for (const height of [10, 20, 40]) {
      const p = pad(height, 0)
      expect(p).toBeLessThanOrEqual(MAX_FILLER_LINES)
      expect(p).toBeGreaterThanOrEqual(0)
    }
    expect(pad(10, 0)).toBe(2)
    expect(pad(20, 0)).toBe(2)
    expect(pad(40, 0)).toBe(2)
  })

  test("transcript growth takes the filler back once past the cap", () => {
    // height 10: free = 10 - USED - transcript, uncapped below 2.
    expect(pad(10, 1)).toBe(2)
    expect(pad(10, 2)).toBe(1)
    expect(pad(10, 3)).toBe(0)
    expect(pad(10, 500)).toBe(0)
  })

  test("never negative, however small the terminal", () => {
    // A 5-row terminal cannot fit the chrome at all; the answer is "no
    // padding", not a negative offset that would push content off the top.
    for (const height of [0, 1, 5, USED - 1]) {
      expect(pad(height, 0)).toBe(0)
    }
    expect(pad(USED, 0)).toBe(0)
  })

  test("holds across a range of terminal heights", () => {
    for (const height of [10, 24, 30, 40, 50, 60, 80, 120]) {
      const p = pad(height, 3)
      expect(p).toBe(Math.max(0, Math.min(height - USED - 3, MAX_FILLER_LINES)))
      // The invariant that matters: what is drawn plus what is padded never
      // overflows the viewport.
      expect(p + USED + 3).toBeLessThanOrEqual(Math.max(height, USED + 3))
    }
  })

  test("a taller input eats padding one line at a time", () => {
    const one = bottomPadding({ ...CHROME, height: 9, transcript: 0 })
    const three = bottomPadding({ ...CHROME, input: INPUT_RULE_LINES + 3, height: 9, transcript: 0 })
    // USED+2 rows tall: the one-line input leaves exactly two free rows, and
    // each extra input line takes one of them back before the clamp bites.
    expect(one).toBe(2)
    expect(three).toBe(0)
  })
})

describe("wrappedLines", () => {
  test("a short line is one line", () => {
    expect(wrappedLines("hello", 80)).toBe(1)
  })

  test("wrapping rounds up", () => {
    expect(wrappedLines("x".repeat(81), 80)).toBe(2)
    expect(wrappedLines("x".repeat(160), 80)).toBe(2)
    expect(wrappedLines("x".repeat(161), 80)).toBe(3)
  })

  test("explicit newlines each start a line", () => {
    expect(wrappedLines("a\nb\nc", 80)).toBe(3)
  })

  test("empty text still occupies a line", () => {
    expect(wrappedLines("", 80)).toBe(1)
  })

  test("a zero or negative width does not divide by zero", () => {
    expect(wrappedLines("a\nb", 0)).toBe(2)
    expect(wrappedLines("abc", -5)).toBe(1)
  })

  test("counts code points, so a wide or astral glyph is one cell of text", () => {
    // Not exact terminal width — this feeds a clamp, and over-counting only
    // gives a padding line back early.
    expect(wrappedLines("😀".repeat(10), 80)).toBe(1)
  })
})

describe("composerHeight", () => {
  test("an empty composer is its two rules plus one line", () => {
    expect(composerHeight("", 80)).toBe(3)
  })

  test("grows as the value wraps past the width", () => {
    expect(composerHeight("x".repeat(78), 80)).toBe(3)
    expect(composerHeight("x".repeat(79), 80)).toBe(4)
  })
})

describe("estimateTranscriptLines", () => {
  function msg(parts: Message["parts"]): Message {
    return { id: "m", sessionID: "s", role: "assistant", time: { created: 0 }, parts }
  }

  test("an empty transcript is zero lines", () => {
    expect(estimateTranscriptLines([], 80)).toBe(0)
  })

  test("text is counted at its wrapped height plus a separator", () => {
    expect(estimateMessageLines(msg([{ id: "t", type: "text", text: "a\nb" }]), 80)).toBe(3)
  })

  test("a tool call is a row plus a bounded preview, never its whole output", () => {
    const huge = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n")
    const lines = estimateMessageLines(
      msg([
        {
          id: "p", type: "tool", tool: "bash", callID: "c",
          state: { status: "completed", input: {}, output: huge, title: "ls", time: { start: 0, end: 1 } },
        },
      ]),
      80,
    )
    // The transcript collapses that to a summary and a short preview, so the
    // estimate must too — counting 900 would zero the padding forever.
    expect(lines).toBeLessThanOrEqual(6)
  })

  test("never undercounts a wrapped paragraph", () => {
    // Undercounting is the one direction that hurts: it pads too much and
    // pushes the composer off the bottom of the screen.
    const text = "x".repeat(500)
    expect(estimateMessageLines(msg([{ id: "t", type: "text", text }]), 80)).toBeGreaterThanOrEqual(7)
  })

  test("sums over messages", () => {
    const one = msg([{ id: "t", type: "text", text: "hi" }])
    expect(estimateTranscriptLines([one, { ...one, id: "m2" }], 80)).toBe(
      estimateMessageLines(one, 80) * 2,
    )
  })
})

describe("layout constants stay in step with what renders", () => {
  test("the header is three bare lines: title, hints, self-description", () => {
    expect(HEADER_LINES).toBe(3)
  })

  test("separatorBefore is still shared from here", () => {
    expect(separatorBefore(undefined, true)).toBe(0)
    expect(separatorBefore(true, false)).toBe(1)
  })
})

describe("readSize", () => {
  test("uses what the stream reports", () => {
    expect(readSize({ columns: 120, rows: 40 })).toEqual({ columns: 120, rows: 40 })
  })

  test("falls back for a stream that reports nothing", () => {
    // ink-testing-library's stub declares columns but no rows; a piped stdout
    // has neither.
    expect(readSize(undefined)).toEqual(DEFAULT_SIZE)
    expect(readSize({ columns: 100 })).toEqual({ columns: 100, rows: DEFAULT_SIZE.rows })
  })

  test("treats a zero dimension as missing", () => {
    expect(readSize({ columns: 0, rows: 0 })).toEqual(DEFAULT_SIZE)
  })
})

describe("synchronized output", () => {
  const tty = { isTTY: true }

  test("enabled on a TTY", () => {
    expect(synchronizedOutputEnabled({}, tty)).toBe(true)
  })

  test("never on a pipe — escapes there are corruption, not decoration", () => {
    expect(synchronizedOutputEnabled({}, { isTTY: false })).toBe(false)
    expect(synchronizedOutputEnabled({}, {})).toBe(false)
  })

  test("off for TERM=dumb and for the opt-out", () => {
    expect(synchronizedOutputEnabled({ TERM: "dumb" }, tty)).toBe(false)
    expect(synchronizedOutputEnabled({ HAXFORD_NO_SYNC: "1" }, tty)).toBe(false)
  })

  test("an empty or zero opt-out does not count as set", () => {
    expect(synchronizedOutputEnabled({ HAXFORD_NO_SYNC: "" }, tty)).toBe(true)
    expect(synchronizedOutputEnabled({ HAXFORD_NO_SYNC: "0" }, tty)).toBe(true)
  })

  test("a frame is bracketed by exactly one begin and one end", () => {
    const wrapped = wrapFrame("frame")
    expect(wrapped).toBe(`${BEGIN_SYNC}frame${END_SYNC}`)
    expect(wrapped.split(BEGIN_SYNC)).toHaveLength(2)
    expect(wrapped.split(END_SYNC)).toHaveLength(2)
  })

  test("an empty frame is left alone — there is nothing to tear", () => {
    expect(wrapFrame("")).toBe("")
  })

  test("the wrapped stream emits one write per frame, already bracketed", () => {
    // One write is the whole point: bracketing from a React effect would fence
    // off the wrong moment, because Ink throttles when it actually writes.
    const writes: string[] = []
    const stream = { isTTY: true, write: (c: string) => { writes.push(c); return true } }
    const sync = synchronizedStdout(stream, {})
    sync.write("a")
    sync.write("b")
    expect(writes).toEqual([`${BEGIN_SYNC}a${END_SYNC}`, `${BEGIN_SYNC}b${END_SYNC}`])
  })

  test("a disabled stream is returned untouched, not wrapped in a no-op", () => {
    const stream = { isTTY: false, write: () => true }
    expect(synchronizedStdout(stream, {})).toBe(stream)
  })

  test("the proxy still exposes the size and event API Ink needs", () => {
    const listeners: string[] = []
    const stream = {
      isTTY: true,
      columns: 120,
      rows: 40,
      write: () => true,
      on(event: string) { listeners.push(event); return this },
    }
    const sync = synchronizedStdout(stream, {}) as typeof stream
    expect(sync.columns).toBe(120)
    expect(sync.rows).toBe(40)
    sync.on("resize")
    expect(listeners).toEqual(["resize"])
  })
})

describe("banner text helpers", () => {
  test("cwd is shortened against home", () => {
    expect(tildeCwd("/home/harry/Projects/x", "/home/harry")).toBe("~/Projects/x")
    expect(tildeCwd("/home/harry", "/home/harry")).toBe("~")
    expect(tildeCwd("/etc/hosts", "/home/harry")).toBe("/etc/hosts")
  })

  test("a home prefix only matches on a path boundary", () => {
    expect(tildeCwd("/home/harrison/x", "/home/harry")).toBe("/home/harrison/x")
  })

  test("no home in the environment leaves the path alone", () => {
    // "" is how a caller says "there is no home", since an explicit undefined
    // takes the default parameter and reads the ambient HOME.
    expect(tildeCwd("/home/harry/x", "")).toBe("/home/harry/x")
  })
})
