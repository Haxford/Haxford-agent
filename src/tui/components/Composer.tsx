import { Box, Text, useInput, useStdout } from "ink"
import React, { useCallback, useRef, useState } from "react"

import {
  backslashContinuation,
  cursorVisualPosition,
  deleteBackward,
  insertText,
  moveCursorLeft,
  moveCursorRight,
  moveCursorVertical,
  trimForSubmit,
  wrapForDisplay,
  type EditorState,
} from "../composerEditor.ts"
import { useTerminalSize } from "../hooks.ts"
import { modeColor, theme, type ThemeMode } from "../theme.ts"
import { Rule } from "./Rule.tsx"

export interface ComposerHandle {
  /** Programmatically replace the input contents (completion, clear). Cursor lands at the end. */
  set(value: string): void
}

export interface ComposerProps {
  /** Disable input while the agent loop is running. */
  disabled: boolean
  /**
   * Permission mode. Rendered as the composer's rail colour — the primary
   * mode indicator, always visible and costing zero lines. Defaults to
   * "build" so standalone renders (unit tests) need not supply it.
   */
  mode?: ThemeMode
  /** Called when the user submits a non-empty line. */
  onSubmit: (value: string) => void
  /**
   * Ref receiving an imperative { set } handle. State here is fully
   * controlled by this component, so `set` just replaces it directly.
   */
  handleRef?: React.MutableRefObject<ComposerHandle | undefined>
  /** Called on every content change (not on a pure cursor move) with the current value. */
  onValueChange?: (value: string) => void
  /** Placeholder text shown when empty. */
  placeholder?: string
  /** Optional node rendered above the input (e.g. a slash autocomplete popup). */
  autocomplete?: React.ReactNode
  /** When true, up/down navigate the autocomplete popup instead of history. */
  popupActive?: boolean
  /** Called on up/down while popupActive (the app moves the popup cursor). */
  onPopupNavigate?: (direction: "up" | "down") => void
  /** Called when the user accepts the autocomplete suggestion (tab or enter on popup). */
  onPopupAccept?: () => void
  /** Called when the user dismisses the autocomplete popup (esc). */
  onPopupDismiss?: () => void
  /**
   * Up-arrow on an empty composer pops the most recently queued prompt (see
   * `TuiStore.popLastQueued`) back into the composer for editing, ahead of
   * local submit-history navigation. Returns the popped text, or undefined
   * when nothing is queued — in which case up-arrow falls through to normal
   * history navigation.
   */
  onPopQueued?: () => string | undefined
}

const EMPTY_EDITOR: EditorState = { value: "", cursor: 0 }

/** Columns reserved for the glyph and its trailing gap — not available to the text itself. */
const CHROME_COLUMNS = 2

/**
 * Multiline prompt composer.
 *
 * Plain Enter submits. Alt+Enter, a Kitty-protocol-disambiguated Shift+Enter
 * (see `INK_RENDER_OPTIONS.kittyKeyboard` in app.tsx — Ink negotiates the
 * protocol and decodes it into `key.shift` itself; nothing here parses raw
 * escape codes), or a trailing backslash all insert a literal newline
 * instead. Up/Down move the cursor between lines while there is more than
 * one; at the first/last line they fall through to prompt history (or, on an
 * empty composer, to popping the last queued prompt back for editing).
 *
 * Fully controlled — no more `@inkjs/ui` `TextInput` and no remount-to-reset
 * trick underneath it. `cursor` is a code-point index (see composerEditor.ts)
 * so astral characters are never split by an edit, and the visual row/column
 * math is wrap-width-aware, computed fresh on every render from the real
 * terminal width — the class of bug where backspace near a wrapped line
 * boundary corrupted a chunk of text can't occur here: deleting only ever
 * edits the flat string, never the wrapped display of it.
 */
export function Composer({
  disabled,
  mode = "build",
  onSubmit,
  onValueChange,
  placeholder,
  autocomplete,
  popupActive,
  onPopupNavigate,
  onPopupAccept,
  onPopupDismiss,
  onPopQueued,
  handleRef,
}: ComposerProps): React.ReactElement {
  // The input handler treats these refs as the source of truth for every
  // decision it makes, not React state: state updates are async (and can
  // batch), so a burst of keypresses arriving faster than a render — holding
  // an arrow key, a paste that fans out into several rapid events — would
  // otherwise have every handler invocation read the SAME stale snapshot
  // from closure and stomp on each other's result instead of compounding.
  // Mutating the ref is synchronous, so each keystroke always builds on the
  // true latest state regardless of render timing.
  //
  // `editor` is mirrored into real state too, because it drives what's on
  // screen. `history`/`historyIndex` never render anything themselves — every
  // path that changes them also calls `reseed`/`applyEdit`, which already
  // triggers the render — so they stay plain refs with no state mirror.
  const [editor, setEditorState] = useState<EditorState>(EMPTY_EDITOR)
  const editorRef = useRef<EditorState>(EMPTY_EDITOR)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1) // -1 = "not walking history"

  const setEditor = useCallback((next: EditorState) => {
    editorRef.current = next
    setEditorState(next)
  }, [])
  const setHistory = useCallback((next: string[]) => {
    historyRef.current = next
  }, [])
  const setHistoryIndex = useCallback((next: number) => {
    historyIndexRef.current = next
  }, [])

  const { stdout } = useStdout()
  const { columns } = useTerminalSize(stdout)
  const contentWidth = Math.max(1, columns - CHROME_COLUMNS)

  /** Replace the whole buffer, cursor at the end, and report the new value upward. */
  const reseed = useCallback(
    (next: string) => {
      setEditor({ value: next, cursor: Array.from(next).length })
      onValueChange?.(next)
    },
    [onValueChange, setEditor],
  )

  React.useImperativeHandle(handleRef, () => ({ set: reseed }), [reseed])

  /** Apply an edit that changes the buffer's content, reporting it upward. */
  const applyEdit = useCallback(
    (next: EditorState) => {
      setEditor(next)
      onValueChange?.(next.value)
    },
    [onValueChange, setEditor],
  )

  const commit = useCallback(() => {
    const trimmed = trimForSubmit(editorRef.current.value)
    if (trimmed.length === 0) return
    setHistory([...historyRef.current, trimmed])
    setHistoryIndex(-1)
    reseed("")
    onSubmit(trimmed)
  }, [onSubmit, reseed, setHistory, setHistoryIndex])

  useInput((input, key) => {
    if (disabled) return

    if (popupActive) {
      if (key.upArrow) { onPopupNavigate?.("up"); return }
      if (key.downArrow) { onPopupNavigate?.("down"); return }
      if (key.tab) { onPopupAccept?.(); return }
      if (key.escape) { onPopupDismiss?.(); return }
      // Enter while popup is active accepts the suggestion rather than submitting.
      if (key.return) { onPopupAccept?.(); return }
      return
    }

    const current = editorRef.current

    if (key.return) {
      // Alt+Enter (ESC-prefixed, the portable encoding most terminals send)
      // or a Kitty-disambiguated Shift+Enter (Ink decodes the CSI-u sequence
      // into key.shift itself — see the module doc) both insert a newline.
      if (key.meta || key.shift) {
        applyEdit(insertText(current, "\n"))
        return
      }
      // Universal fallback: a trailing backslash right at the cursor means
      // "continue on the next line" even where neither of the above arrives.
      const continued = backslashContinuation(current)
      if (continued) {
        applyEdit(continued)
        return
      }
      commit()
      return
    }

    if (key.upArrow) {
      // Cursor navigation within the buffer wins whenever there is another
      // real line above — moving through your own text has to work before
      // any history/queue fallback kicks in.
      const moved = moveCursorVertical(current.value, current.cursor, "up")
      if (moved !== null) {
        setEditor({ ...current, cursor: moved })
        return
      }
      // At the first line. An empty composer with something queued edits the
      // queue first — the whole point of pushing it back is to fix it before
      // it's ever sent, so this takes priority over cycling through history.
      if (current.value.length === 0 && historyIndexRef.current === -1) {
        const popped = onPopQueued?.()
        if (popped !== undefined) {
          reseed(popped)
          return
        }
      }
      const hist = historyRef.current
      if (hist.length === 0) return
      const next = historyIndexRef.current === -1 ? hist.length - 1 : Math.max(0, historyIndexRef.current - 1)
      setHistoryIndex(next)
      reseed(hist[next] ?? "")
      return
    }

    if (key.downArrow) {
      const moved = moveCursorVertical(current.value, current.cursor, "down")
      if (moved !== null) {
        setEditor({ ...current, cursor: moved })
        return
      }
      if (historyIndexRef.current === -1) return
      const hist = historyRef.current
      const next = historyIndexRef.current + 1
      if (next >= hist.length) {
        setHistoryIndex(-1)
        reseed("")
      } else {
        setHistoryIndex(next)
        reseed(hist[next] ?? "")
      }
      return
    }

    if (key.leftArrow) { setEditor(moveCursorLeft(current)); return }
    if (key.rightArrow) { setEditor(moveCursorRight(current)); return }

    if (key.backspace || key.delete) {
      // Terminals disagree on which of these a physical Backspace key sends
      // (many send DEL, 0x7F, which some parsers report as `delete`) — both
      // delete the character before the cursor, matching every other
      // terminal editor's convention for "Backspace".
      applyEdit(deleteBackward(current))
      return
    }

    // Never insert a raw control/meta byte as text — ctrl+o, ctrl+c, and any
    // other chord are handled elsewhere (or nowhere) and must not leak a
    // stray character into the buffer.
    if (key.tab || key.escape || key.ctrl || key.meta) return

    if (input.length > 0) applyEdit(insertText(current, input))
  })

  // The prompt glyph carries the mode. It is the single accented mark in the
  // chrome, and it sits where the eye already is when typing.
  const glyph = modeColor(mode)
  const isEmpty = editor.value.length === 0
  const rows = isEmpty ? [] : wrapForDisplay(editor.value, contentWidth)
  const { row: cursorRow, col: cursorCol } = isEmpty
    ? { row: 0, col: 0 }
    : cursorVisualPosition(editor.value, editor.cursor, contentWidth)
  const resolvedPlaceholder =
    placeholder ?? (disabled ? "agent running…" : "ask anything, or / for commands")

  return (
    <Box flexDirection="column">
      {autocomplete}
      {/*
        Rules above and below, not a box. A box around an input says "form
        field"; two rules say "this is where you type" with none of the
        weight, and they leave the region free to grow — each visual row is
        its own <Text>, so the area between the rules expands on its own as
        the buffer wraps or gains lines, with no height to keep in sync.
      */}
      <Rule />
      <Box paddingLeft={1} gap={1}>
        <Text color={disabled ? theme.muted : glyph}>{disabled ? "•" : "›"}</Text>
        <Box flexGrow={1} flexDirection="column">
          {isEmpty ? (
            <Text>
              {!disabled ? <Text inverse>{" "}</Text> : null}
              <Text dimColor>{resolvedPlaceholder}</Text>
            </Text>
          ) : (
            rows.map((rowText, i) => {
              const dim = disabled
              if (dim || i !== cursorRow) {
                return (
                  <Text key={i} dimColor={dim} wrap="truncate-end">
                    {rowText.length === 0 ? " " : rowText}
                  </Text>
                )
              }
              const chars = Array.from(rowText)
              if (cursorCol >= chars.length) {
                return (
                  <Text key={i} wrap="truncate-end">
                    {rowText}
                    <Text inverse>{" "}</Text>
                  </Text>
                )
              }
              return (
                <Text key={i} wrap="truncate-end">
                  {chars.slice(0, cursorCol).join("")}
                  <Text inverse>{chars[cursorCol]}</Text>
                  {chars.slice(cursorCol + 1).join("")}
                </Text>
              )
            })
          )}
        </Box>
      </Box>
      <Rule />
    </Box>
  )
}
