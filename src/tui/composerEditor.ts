/**
 * Pure buffer/cursor logic for the multiline composer.
 *
 * Kept separate from Composer.tsx (the Ink wiring) so the actual editing
 * rules — insert, delete, line navigation, submit-trimming, and the
 * wrap-aware layout math — are testable without rendering anything. Every
 * cursor position here is a CODE-POINT index (via `[...value]`, not raw
 * UTF-16 units), so an emoji or other astral character is never split by an
 * insert or a delete.
 */

/** A buffer and where the cursor sits in it, in code points. */
export interface EditorState {
  value: string
  cursor: number
}

/** Code-point array of a string — the unit every index in this module counts in. */
function toChars(value: string): string[] {
  return Array.from(value)
}

/** Insert `text` at the cursor, moving the cursor past what was inserted. */
export function insertText(state: EditorState, text: string): EditorState {
  if (text.length === 0) return state
  const chars = toChars(state.value)
  const before = chars.slice(0, state.cursor).join("")
  const after = chars.slice(state.cursor).join("")
  return {
    value: before + text + after,
    cursor: state.cursor + toChars(text).length,
  }
}

/** Remove the code point before the cursor (Backspace). No-op at position 0. */
export function deleteBackward(state: EditorState): EditorState {
  if (state.cursor <= 0) return state
  const chars = toChars(state.value)
  const next = [...chars.slice(0, state.cursor - 1), ...chars.slice(state.cursor)]
  return { value: next.join(""), cursor: state.cursor - 1 }
}

/** Remove the code point at the cursor (Delete/forward-delete). No-op at the end. */
export function deleteForward(state: EditorState): EditorState {
  const chars = toChars(state.value)
  if (state.cursor >= chars.length) return state
  const next = [...chars.slice(0, state.cursor), ...chars.slice(state.cursor + 1)]
  return { value: next.join(""), cursor: state.cursor }
}

/** Move the cursor one code point left. Crosses a line boundary naturally — the
 * character "before" the first column of a line is the newline that ends the
 * previous one, so decrementing the flat index already lands there. */
export function moveCursorLeft(state: EditorState): EditorState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) }
}

/** Move the cursor one code point right. Symmetric with `moveCursorLeft`. */
export function moveCursorRight(state: EditorState): EditorState {
  const len = toChars(state.value).length
  return { ...state, cursor: Math.min(len, state.cursor + 1) }
}

/** Which real (newline-delimited) line the cursor is on, and its column within it. */
export function lineAndColumn(value: string, cursor: number): { line: number; col: number } {
  const lines = value.split("\n")
  let remaining = cursor
  for (let i = 0; i < lines.length; i++) {
    const len = toChars(lines[i] ?? "").length
    if (remaining <= len) return { line: i, col: remaining }
    remaining -= len + 1 // the "\n" between this line and the next
  }
  const lastLine = lines.length - 1
  return { line: lastLine, col: toChars(lines[lastLine] ?? "").length }
}

/** The flat cursor index for a given real line + column, clamped to that line's length. */
function indexOfLineColumn(value: string, line: number, col: number): number {
  const lines = value.split("\n")
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
  let index = 0
  for (let i = 0; i < clampedLine; i++) index += toChars(lines[i] ?? "").length + 1
  const lineLen = toChars(lines[clampedLine] ?? "").length
  return index + Math.max(0, Math.min(col, lineLen))
}

/**
 * Move the cursor to the same column on the adjacent REAL line (clamped to
 * that line's length if it's shorter). Returns `null` when there is no
 * adjacent line to move to — up from the first line, or down from the last —
 * which is the caller's cue to fall through to history/queue navigation
 * instead.
 */
export function moveCursorVertical(
  value: string,
  cursor: number,
  direction: "up" | "down",
): number | null {
  const lines = value.split("\n")
  const { line, col } = lineAndColumn(value, cursor)
  if (direction === "up") {
    if (line === 0) return null
    return indexOfLineColumn(value, line - 1, col)
  }
  if (line >= lines.length - 1) return null
  return indexOfLineColumn(value, line + 1, col)
}

/**
 * Trim a buffer for submission: drop trailing blank lines (from a newline
 * inserted right before Enter was pressed to actually submit), then trim the
 * result the same way a single-line submit always has — leading/trailing
 * whitespace only, never anything inside the message.
 */
export function trimForSubmit(value: string): string {
  const lines = value.split("\n")
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) lines.pop()
  return lines.join("\n").trim()
}

/**
 * A trailing backslash right at the cursor means "continue on the next
 * line" — the universal fallback for terminals where neither Alt+Enter nor
 * the Kitty protocol gets through. Returns the buffer with the backslash
 * replaced by a newline, or `null` when the character before the cursor
 * isn't a backslash (the caller then treats Enter as a real submit).
 */
export function backslashContinuation(state: EditorState): EditorState | null {
  if (state.cursor <= 0) return null
  const chars = toChars(state.value)
  if (chars[state.cursor - 1] !== "\\") return null
  const withoutBackslash: EditorState = {
    value: [...chars.slice(0, state.cursor - 1), ...chars.slice(state.cursor)].join(""),
    cursor: state.cursor - 1,
  }
  return insertText(withoutBackslash, "\n")
}

/** Soft-wrap one real line to `width` columns. Always at least one row, even for "". */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line]
  const chars = toChars(line)
  if (chars.length === 0) return [""]
  const rows: string[] = []
  for (let i = 0; i < chars.length; i += width) rows.push(chars.slice(i, i + width).join(""))
  return rows
}

/**
 * The buffer as visual rows: each real line split by `\n`, then each of
 * those soft-wrapped to `width` columns. This is what actually renders —
 * `cursorVisualPosition` below walks the identical segmentation so the two
 * never disagree about where a row boundary falls.
 */
export function wrapForDisplay(value: string, width: number): string[] {
  const rows: string[] = []
  for (const line of value.split("\n")) rows.push(...wrapLine(line, width))
  return rows.length > 0 ? rows : [""]
}

/**
 * Where the cursor renders: the visual row (post real-line-split AND
 * soft-wrap) and the column within that row's text, for `width` columns of
 * available space.
 *
 * This is the "explicit column math against the real terminal width" the
 * wrapped-line backspace bug needed: `deleteBackward` above only ever edits
 * the flat string, so it is correct regardless of wrapping on its own — but
 * placing the cursor mark correctly after a delete near a wrap boundary
 * needs to know exactly which row/column that new cursor index now falls on,
 * which is what this computes.
 */
export function cursorVisualPosition(
  value: string,
  cursor: number,
  width: number,
): { row: number; col: number } {
  const lines = value.split("\n")
  let consumed = 0
  let row = 0
  for (const line of lines) {
    const lineLen = toChars(line).length
    const rows = wrapLine(line, width)
    let offsetInLine = 0
    for (let ri = 0; ri < rows.length; ri++) {
      const rowText = rows[ri] ?? ""
      const rowLen = toChars(rowText).length
      const rowStart = consumed + offsetInLine
      const rowEnd = rowStart + rowLen
      const isLastRowOfLine = ri === rows.length - 1
      // A cursor exactly at a row's end belongs to THIS row (one column past
      // its last character) unless there is a next row to hand it to instead
      // — otherwise the very end of the buffer would never match anything.
      if (cursor >= rowStart && (cursor < rowEnd || (isLastRowOfLine && cursor === rowEnd))) {
        return { row, col: cursor - rowStart }
      }
      offsetInLine += rowLen
      row++
    }
    consumed += lineLen + 1
  }
  // Past the end of every line (shouldn't happen if the caller clamps the
  // cursor correctly) — park it at the end of the last visual row.
  const lastLine = lines[lines.length - 1] ?? ""
  const lastRows = wrapLine(lastLine, width)
  const lastRowText = lastRows[lastRows.length - 1] ?? ""
  return { row: row - 1, col: toChars(lastRowText).length }
}
