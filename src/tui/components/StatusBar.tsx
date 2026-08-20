import { Box, Text } from "ink"
import type React from "react"

import type { TotalUsage } from "../state.ts"

export interface StatusBarProps {
  model: string
  status: "idle" | "running" | "ended" | "error"
  turn: number
  usage: TotalUsage
  error?: string
  /** Reason from the last loop.end; shown in a warning color when not end_turn. */
  endReason?: string
}

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
function reasonLabel(
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

export function StatusBar({ model, status, turn, usage, error, endReason }: StatusBarProps): React.ReactElement {
  const s = statusLabel(status)
  const r = endReason !== undefined ? reasonLabel(endReason) : undefined
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color="magenta">{model}</Text>
        <Text color={s.color}>● {s.text}</Text>
        {r !== undefined ? <Text color={r.color}>{r.text}</Text> : null}
        <Text dimColor>turn {turn}</Text>
        <Text dimColor>
          tokens ↑{usage.input} ↓{usage.output}
          {usage.reasoning > 0 ? ` ◇${usage.reasoning}` : ""}
        </Text>
      </Box>
      {error !== undefined ? (
        <Text color="red" wrap="truncate">
          {error.length > 100 ? error.slice(0, 100) + "…" : error}
        </Text>
      ) : null}
    </Box>
  )
}
