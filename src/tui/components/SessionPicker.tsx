import { Box, Text, useInput } from "ink"
import React, { useState } from "react"

import type { SessionInfo } from "../../types/session.ts"

export interface SessionPickerProps {
  sessions: SessionInfo[]
  onSelect: (id: string) => void
  onCancel: () => void
}

/** Coarse relative-time formatter ("just now", "5m ago", "3h ago", "2d ago"). */
function relativeTime(updated: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - updated) / 1000))
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export function SessionPicker({
  sessions,
  onSelect,
  onCancel,
}: SessionPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0)

  // Clamp cursor when the list changes.
  const safeCursor = sessions.length === 0 ? 0 : Math.min(cursor, sessions.length - 1)

  useInput((_, key) => {
    if (sessions.length === 0) {
      if (key.escape) onCancel()
      return
    }
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? sessions.length - 1 : c - 1))
    } else if (key.downArrow) {
      setCursor((c) => (c >= sessions.length - 1 ? 0 : c + 1))
    } else if (key.return) {
      const sel = sessions[safeCursor]
      if (sel !== undefined) onSelect(sel.id)
    } else if (key.escape) {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box gap={2}>
        <Text bold color="cyan">{"resume session"}</Text>
        <Text dimColor>{"↑/↓ navigate · enter select · esc cancel"}</Text>
      </Box>
      {sessions.length === 0 ? (
        <Text dimColor>{"no sessions found"}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sessions.map((s, i) => {
            const selected = i === safeCursor
            return (
              <Box key={s.id} gap={1}>
                <Text color={selected ? "cyan" : "gray"}>
                  {selected ? "▸" : " "}
                </Text>
                <Text bold={selected} color={selected ? "white" : undefined}>
                  {s.title}
                </Text>
                <Text dimColor>{relativeTime(s.time.updated)}</Text>
                <Text dimColor>{s.id.slice(0, 8)}</Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
