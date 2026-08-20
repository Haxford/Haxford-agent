import { Box, Text } from "ink"
import type React from "react"

import type { TotalUsage } from "../state.ts"

export interface StatusBarProps {
  model: string
  status: "idle" | "running" | "ended" | "error"
  turn: number
  usage: TotalUsage
  error?: string
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

export function StatusBar({ model, status, turn, usage, error }: StatusBarProps): React.ReactElement {
  const s = statusLabel(status)
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color="magenta">{model}</Text>
        <Text color={s.color}>● {s.text}</Text>
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
