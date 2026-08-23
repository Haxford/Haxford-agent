import { describe, expect, test } from "bun:test"

import {
  backslashContinuation,
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  insertText,
  lineAndColumn,
  moveCursorLeft,
  moveCursorRight,
  moveCursorVertical,
  trimForSubmit,
  wrapForDisplay,
  type EditorState,
} from "../src/tui/composerEditor.ts"

function state(value: string, cursor: number): EditorState {
  return { value, cursor }
}

describe("insertText", () => {
  test("inserts at the cursor and advances past it", () => {
    expect(insertText(state("helo", 3), "l")).toEqual({ value: "hello", cursor: 4 })
  })

  test("inserting a newline mid-string splits it in place", () => {
    // The exact scenario item 1 asks for: Alt+Enter/Shift+Enter/backslash all
    // funnel into this one call with text: "\n".
    expect(insertText(state("hello world", 5), "\n")).toEqual({
      value: "hello\n world",
      cursor: 6,
    })
  })

  test("inserting multi-character text (a paste-shaped burst) advances by its full length", () => {
    expect(insertText(state("ac", 1), "b")).toEqual({ value: "abc", cursor: 2 })
    expect(insertText(state("", 0), "abc")).toEqual({ value: "abc", cursor: 3 })
  })

  test("empty insert is a no-op", () => {
    const s = state("abc", 1)
    expect(insertText(s, "")).toEqual(s)
  })

  test("is code-point safe: an astral character (emoji) is never split", () => {
    // "😀" is a surrogate pair — one code point, two UTF-16 units.
    const withEmoji = insertText(state("hi", 2), "😀")
    expect(withEmoji.value).toBe("hi😀")
    expect(withEmoji.cursor).toBe(3) // "h", "i", "😀" — three code points
    // A further insert at that cursor lands after the emoji, not inside it.
    expect(insertText(withEmoji, "!")).toEqual({ value: "hi😀!", cursor: 4 })
  })
})

describe("deleteBackward / deleteForward", () => {
  test("backspace removes the character before the cursor", () => {
    expect(deleteBackward(state("hello", 5))).toEqual({ value: "hell", cursor: 4 })
    expect(deleteBackward(state("hello", 1))).toEqual({ value: "ello", cursor: 0 })
  })

  test("backspace at position 0 is a no-op", () => {
    const s = state("hello", 0)
    expect(deleteBackward(s)).toEqual(s)
  })

  test("backspace does not split an astral character", () => {
    const s = state("hi😀!", 3) // code points: h, i, 😀, ! — cursor right after the emoji
    expect(deleteBackward(s)).toEqual({ value: "hi!", cursor: 2 })
  })

  test("delete-forward removes the character at the cursor", () => {
    expect(deleteForward(state("hello", 0))).toEqual({ value: "ello", cursor: 0 })
  })

  test("delete-forward at the end is a no-op", () => {
    const s = state("hello", 5)
    expect(deleteForward(s)).toEqual(s)
  })

  test("backspace across a real newline removes the newline, joining the lines", () => {
    expect(deleteBackward(state("hello\nworld", 6))).toEqual({
      value: "helloworld",
      cursor: 5,
    })
  })
})

describe("moveCursorLeft / moveCursorRight", () => {
  test("clamp at both ends", () => {
    expect(moveCursorLeft(state("ab", 0)).cursor).toBe(0)
    expect(moveCursorRight(state("ab", 2)).cursor).toBe(2)
  })

  test("left/right cross a newline boundary like any other character", () => {
    expect(moveCursorLeft(state("a\nb", 2)).cursor).toBe(1)
    expect(moveCursorRight(state("a\nb", 1)).cursor).toBe(2)
  })
})

describe("lineAndColumn / moveCursorVertical", () => {
  test("locates line and column for a flat cursor index", () => {
    const value = "one\ntwo\nthree"
    expect(lineAndColumn(value, 0)).toEqual({ line: 0, col: 0 })
    expect(lineAndColumn(value, 3)).toEqual({ line: 0, col: 3 }) // end of "one"
    expect(lineAndColumn(value, 4)).toEqual({ line: 1, col: 0 }) // start of "two"
    expect(lineAndColumn(value, 8)).toEqual({ line: 2, col: 0 }) // start of "three"
  })

  test("up from the first line returns null — the caller's cue to fall through", () => {
    expect(moveCursorVertical("one\ntwo", 1, "up")).toBeNull()
  })

  test("down from the last line returns null", () => {
    expect(moveCursorVertical("one\ntwo", 5, "down")).toBeNull()
  })

  test("a single-line buffer always returns null both ways", () => {
    expect(moveCursorVertical("just one line", 4, "up")).toBeNull()
    expect(moveCursorVertical("just one line", 4, "down")).toBeNull()
  })

  test("moves to the same column on the line above/below", () => {
    const value = "abcdef\nxy\nabcdef"
    // Cursor at column 4 of line 0 ("abcd|ef").
    expect(moveCursorVertical(value, 4, "down")).toBe(9) // line 1 ("xy") clamped to its length (2)
    // From line 2 col 4, up to line 1 clamps to "xy"'s length (2).
    expect(moveCursorVertical(value, 16, "up")).toBe(9)
  })

  test("moving down then back up returns to the original column when the line is long enough", () => {
    const value = "abcdef\nabcdef"
    const down = moveCursorVertical(value, 4, "down")
    expect(down).not.toBeNull()
    const backUp = moveCursorVertical(value, down!, "up")
    expect(backUp).toBe(4)
  })
})

describe("trimForSubmit", () => {
  test("plain single-line text is trimmed exactly as a single-line submit always was", () => {
    expect(trimForSubmit("  fix the bug  ")).toBe("fix the bug")
  })

  test("drops trailing blank lines left by a newline inserted right before Enter", () => {
    expect(trimForSubmit("line one\n\n")).toBe("line one")
    expect(trimForSubmit("line one\nline two\n")).toBe("line one\nline two")
  })

  test("internal blank lines and indentation are preserved — only the edges are trimmed", () => {
    expect(trimForSubmit("first\n\nthird\n")).toBe("first\n\nthird")
    expect(trimForSubmit("  code\n    indented\n")).toBe("code\n    indented")
  })

  test("an all-blank buffer submits as empty", () => {
    expect(trimForSubmit("\n\n   \n")).toBe("")
    expect(trimForSubmit("")).toBe("")
  })
})

describe("backslashContinuation", () => {
  test("a trailing backslash at the cursor becomes a newline, backslash swallowed", () => {
    const result = backslashContinuation(state("wip\\", 4))
    expect(result).toEqual({ value: "wip\n", cursor: 4 })
  })

  test("continuation works mid-buffer, not only at the very end", () => {
    // Cursor sits right after "one\" with "two" already typed ahead of it.
    const result = backslashContinuation(state("one\\two", 4))
    expect(result).toEqual({ value: "one\ntwo", cursor: 4 })
  })

  test("returns null when the character before the cursor isn't a backslash", () => {
    expect(backslashContinuation(state("hello", 5))).toBeNull()
  })

  test("returns null at the very start of the buffer", () => {
    expect(backslashContinuation(state("", 0))).toBeNull()
  })
})

describe("wrapForDisplay / cursorVisualPosition", () => {
  test("wraps a long single line to the given width", () => {
    expect(wrapForDisplay("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })

  test("real newlines always start a fresh visual row, independent of width", () => {
    expect(wrapForDisplay("ab\ncd", 10)).toEqual(["ab", "cd"])
  })

  test("an empty buffer is one empty row", () => {
    expect(wrapForDisplay("", 10)).toEqual([""])
  })

  test("cursor position tracks into the correct wrapped row and column", () => {
    // "abcdefghij" at width 4 -> rows "abcd" "efgh" "ij"
    expect(cursorVisualPosition("abcdefghij", 0, 4)).toEqual({ row: 0, col: 0 })
    expect(cursorVisualPosition("abcdefghij", 4, 4)).toEqual({ row: 1, col: 0 })
    expect(cursorVisualPosition("abcdefghij", 6, 4)).toEqual({ row: 1, col: 2 })
    expect(cursorVisualPosition("abcdefghij", 10, 4)).toEqual({ row: 2, col: 2 }) // end of buffer
  })

  test("cursor position accounts for real lines ahead of the wrapped one it's on", () => {
    const value = "abcdefgh\nxy" // line 0 wraps at width 4 into two rows, then line 1
    expect(cursorVisualPosition(value, 9, 4)).toEqual({ row: 2, col: 0 }) // start of "xy"
  })

  test("backspace right after a soft wrap boundary removes exactly one character and the cursor lands correctly", () => {
    // This is the concrete "backspace across wrap boundary" scenario: a long
    // single line, cursor sitting right at the start of the second wrapped
    // row (column 0 of the wrap, not a real newline).
    const width = 5
    const value = "abcdefghij" // wraps to ["abcde", "fghij"] at width 5
    const cursorAtWrapStart = 5 // right after "abcde", before "fghij"
    expect(cursorVisualPosition(value, cursorAtWrapStart, width)).toEqual({ row: 1, col: 0 })

    const afterBackspace = deleteBackward(state(value, cursorAtWrapStart))
    // Exactly one character gone — no chunk deletion.
    expect(afterBackspace.value).toBe("abcdfghij")
    expect(afterBackspace.cursor).toBe(4)
    // The cursor now renders at the END of the first (now shorter) wrapped
    // row, not stranded mid-row or jumped to the wrong line.
    expect(cursorVisualPosition(afterBackspace.value, afterBackspace.cursor, width)).toEqual({
      row: 0,
      col: 4,
    })
  })

  test("repeated backspacing across a wrap boundary never deletes more than requested", () => {
    const width = 4
    let s = state("abcdefgh", 8) // wraps to ["abcd", "efgh"]
    for (let i = 0; i < 3; i++) s = deleteBackward(s)
    expect(s).toEqual({ value: "abcde", cursor: 5 })
  })
})
