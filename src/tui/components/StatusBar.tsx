import { Box, Text } from "ink"
import React from "react"

import type { TotalUsage } from "../state.ts"
import { useInterval } from "../hooks.ts"

export type Mode = "build" | "auto" | "plan"

export interface StatusBarProps {
  model: string
  mode: Mode
  status: "idle" | "running" | "ended" | "error"
  turn: number
  usage: TotalUsage
  /** Context window limit; percent is skipped silently when undefined. */
  contextLimit?: number
  /** Current session id (short-form shown as the 8-char prefix). */
  sessionID?: string
  error?: string
  /** Reason from the last loop.end; shown in a warning color when not end_turn. */
  endReason?: string
}

/** Color + label for each mode badge. */
export function modeBadge(mode: Mode): { text: string; color: string } {
  switch (mode) {
    case "build":
      return { text: "[build]", color: "cyan" }
    case "auto":
      return { text: "[auto]", color: "green" }
    case "plan":
      return { text: "[plan]", color: "magenta" }
  }
}

/** Color for a run status glyph + word. */
function statusLabel(status: StatusBarProps["status"]): { text: string; color: string } {
  switch (status) {
    case "running":
      return { text: "running", color: "cyan" }
    case "ended":
      return { text: "ended", color: "green" }
    case "error":
      return { text: "error", color: "red" }
    case "idle":
      return { text: "idle", color: "gray" }
  }
}

/** Map a non-end_turn reason to a short label + warning color. */
export function reasonLabel(
  reason: string,
): { text: string; color: string } | undefined {
  switch (reason) {
    case "end_turn":
      return undefined
    case "aborted":
      return { text: "aborted", color: "yellow" }
    case "max_turns":
      return { text: "max turns", color: "yellow" }
    case "permission_denied":
      return { text: "permission denied", color: "yellow" }
    case "error":
      return { text: "error", color: "red" }
    default:
      return { text: reason, color: "yellow" }
  }
}

/** Context usage as a 0-100 percent, or undefined if unmeasurable. */
export function contextPercent(
  usage: TotalUsage,
  limit?: number,
): number | undefined {
  if (limit === undefined || limit <= 0) return undefined
  const used = usage.input + usage.reasoning
  if (used <= 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

/** 8-char short-form of a session id. */
export function shortSession(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  return id.length <= 8 ? id : id.slice(0, 8)
}

/** A compact braille spinner frame. */
function useSpinner(active: boolean): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [i, setI] = React.useState(0)
  useInterval(() => setI((n) => (n + 1) % frames.length), active ? 90 : null)
  return frames[i] ?? frames[0]!
}

export function StatusBar({
  model,
  mode,
  status,
  turn,
  usage,
  contextLimit,
  sessionID,
  error,
  endReason,
}: StatusBarProps): React.ReactElement {
  const s = statusLabel(status)
  const badge = modeBadge(mode)
  const r = endReason !== undefined ? reasonLabel(endReason) : undefined
  const pct = contextPercent(usage, contextLimit)
  const sid = shortSession(sessionID)
  const spinner = useSpinner(status === "running")

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {status === "running" ? (
          <Text color="cyan">{spinner}</Text>
        ) : (
          <Text color={s.color}>●</Text>
        )}
        <Text color={badge.color}>{badge.text}</Text>
        <Text color="blueBright">{model}</Text>
        {r !== undefined ? <Text color={r.color}>{r.text}</Text> : null}
        <Text dimColor>turn {turn}</Text>
        {pct !== undefined ? (
          <Text dimColor>ctx {pct}%</Text>
        ) : null}
        {sid !== undefined ? <Text dimColor>· {sid}</Text> : null}
      </Box>
      {error !== undefined ? (
        <Text color="red" wrap="truncate">
          {error.length > 100 ? error.slice(0, 100) + "…" : error}
        </Text>
      ) : null}
    </Box>
  )
}
