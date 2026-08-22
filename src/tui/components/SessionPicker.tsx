import { Box, Text, useInput } from "ink"
import React, { useState } from "react"

import type { SessionInfo } from "../../types/session.ts"
import { railProps, theme } from "../theme.ts"

export interface SessionPickerProps {
  sessions: SessionInfo[]
  /**
   * Project directory the list was taken from, named in the empty state.
   * Optional: hosts that have not wired it still get the generic explanation.
   */
  cwd?: string
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
  cwd,
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
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      <Box>
        <Text bold>{"resume session"}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{"esc"}</Text>
        </Box>
      </Box>
      {sessions.length === 0 ? (
        /*
          Sessions are stored per project directory (base64url of the resolved
          cwd), so a bare "no sessions found" is indistinguishable from "the
          feature is broken" when you have simply cd'd somewhere else. Naming
          the scope turns a dead end into an instruction.
        */
        <Box flexDirection="column">
          <Text dimColor>
            {cwd === undefined ? "no sessions found here" : `no sessions found in ${cwd}`}
          </Text>
          <Text dimColor>
            {"sessions are scoped to the project directory — run haxford from the directory you used before"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sessions.map((s, i) => {
            const selected = i === safeCursor
            return (
              <Box key={s.id} gap={1}>
                <Text color={selected ? theme.accent : theme.muted}>
                  {selected ? "▸" : " "}
                </Text>
                <Text bold={selected} color={selected ? theme.accent : undefined}>
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
