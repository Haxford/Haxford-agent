import { Box, Text, useInput } from "ink"
import { TextInput } from "@inkjs/ui"
import React, { useCallback, useState } from "react"

import { modeColor, theme, type ThemeMode } from "../theme.ts"
import { Rule } from "./Rule.tsx"

export interface ComposerHandle {
  /** Programmatically replace the input contents (completion, clear). */
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
   * Ref receiving an imperative { set } handle. The underlying TextInput is
   * uncontrolled, so programmatic changes must go through here to be visible.
   */
  handleRef?: React.MutableRefObject<ComposerHandle | undefined>
  /** Called on every keystroke with the current input value (for autocomplete). */
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
}

/**
 * Single-line prompt composer. Enter submits, Up/Down navigates a local
 * prompt history. Disabled while the agent is running.
 *
 * @inkjs/ui TextInput is uncontrolled, so a `resetKey` is bumped to force a
 * remount (with a fresh `defaultValue`) whenever we programmatically change
 * the input — i.e. after submit (clear) or history navigation (seed).
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
  handleRef,
}: ComposerProps): React.ReactElement {
  const [history, setHistory] = useState<string[]>([])
  const [cursor, setCursor] = useState<number>(-1) // -1 = "current typing"
  const [seed, setSeed] = useState("")
  const [resetKey, setResetKey] = useState(0)

  const reseed = useCallback((next: string) => {
    setSeed(next)
    setResetKey((k) => k + 1)
    onValueChange?.(next)
  }, [onValueChange])

  React.useImperativeHandle(
    handleRef,
    () => ({ set: reseed }),
    [reseed],
  )

  const commit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      if (trimmed.length === 0) return
      setHistory((h) => [...h, trimmed])
      setCursor(-1)
      reseed("")
      onSubmit(trimmed)
    },
    [onSubmit, reseed],
  )

  // Up/Down history navigation. useInput is complementary to TextInput's own
  // Return/backspace handling (we only intercept vertical arrows here).
  useInput((_, key) => {
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
    if (key.upArrow) {
      if (history.length === 0) return
      const next = cursor === -1 ? history.length - 1 : Math.max(0, cursor - 1)
      setCursor(next)
      reseed(history[next] ?? "")
    } else if (key.downArrow) {
      if (cursor === -1) return
      const next = cursor + 1
      if (next >= history.length) {
        setCursor(-1)
        reseed("")
      } else {
        setCursor(next)
        reseed(history[next] ?? "")
      }
    }
  })

  // The prompt glyph carries the mode. It is the single accented mark in the
  // chrome, and it sits where the eye already is when typing.
  const glyph = modeColor(mode)

  return (
    <Box flexDirection="column">
      {autocomplete}
      {/*
        Rules above and below, not a box. A box around an input says "form
        field"; two rules say "this is where you type" with none of the weight,
        and they leave the region free to grow — @inkjs/ui renders its value in
        a plain <Text>, so Ink soft-wraps long input and the area between the
        rules expands on its own, with no height to keep in sync.
      */}
      <Rule />
      <Box paddingLeft={1} gap={1}>
        <Text color={disabled ? theme.muted : glyph}>{disabled ? "\u2022" : "\u203a"}</Text>
        <Box flexGrow={1}>
          <TextInput
            key={resetKey}
            isDisabled={disabled}
            defaultValue={seed}
            placeholder={placeholder ?? (disabled ? "agent running\u2026" : "ask anything, or / for commands")}
            onSubmit={commit}
            onChange={onValueChange}
          />
        </Box>
      </Box>
      <Rule />
    </Box>
  )
}
