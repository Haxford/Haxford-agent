import { Box, Text } from "ink"
import React from "react"

import type { CommandRow } from "./HelpPanel.tsx"

export interface SlashAutocompleteProps {
  /** Matched commands (already filtered by prefix). */
  matches: CommandRow[]
  /** Selected index within `matches`. */
  cursor: number
}

/**
 * Compact popup listing slash commands matching the typed prefix, each with
 * its one-line description dimmed. Rendered above the composer while its text
 * starts with '/'. Empty matches -> render nothing.
 */
export function SlashAutocomplete({ matches, cursor }: SlashAutocompleteProps): React.ReactElement | null {
  if (matches.length === 0) return null
  const safeCursor = Math.min(cursor, matches.length - 1)
  // Show at most 6 rows to keep the popup compact.
  const max = 6
  const start = Math.max(0, safeCursor - Math.floor(max / 2))
  const end = Math.min(matches.length, start + max)
  const shown = matches.slice(start, end)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {shown.map((row, i) => {
        const idx = start + i
        const selected = idx === safeCursor
        return (
          <Box key={row.command} gap={1}>
            <Text color={selected ? "cyan" : "gray"}>{selected ? "▸" : " "}</Text>
            <Text bold={selected} color={selected ? "white" : "cyan"}>{row.command.padEnd(10)}</Text>
            <Text dimColor>{row.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
