import { Box, Text } from "ink"
import React from "react"

import { theme } from "../theme.ts"

/**
 * One row of a listing overlay: what it is called, what it does, and where it
 * came from.
 *
 * `source` is the discoverability half. A user who has both a global and a
 * project copy of something needs to know which one is loaded before they go
 * looking for the file to edit, and "it is in one of two directories" is not
 * an answer.
 */
export interface ListingRow {
  name: string
  description: string
  /** Where it was loaded from — a directory, shown dimmed after the name. */
  source?: string
}

/** Width of the name column, matching HelpPanel's command column. */
const NAME_WIDTH = 14

/**
 * A read-only listing overlay: skills, agents, anything else that is "here is
 * what is loaded".
 *
 * Every row is one line, clipped rather than wrapped. The pin math above the
 * composer stands padding down while an overlay is open precisely because it
 * cannot measure one, so a row that silently became two would push the
 * composer off the bottom of an 80-column terminal — the banner-wrap lesson,
 * one layer up.
 */
export function ListingPanel({
  title,
  rows,
  empty,
}: {
  title: string
  rows: ListingRow[]
  /** Shown instead of the table when nothing is loaded. */
  empty: string
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold color={theme.accent}>{title}</Text>
      {rows.length === 0 ? (
        <Text dimColor wrap="truncate-end">{empty}</Text>
      ) : (
        rows.map((row) => (
          <Box key={`${row.name}:${row.source ?? ""}`} flexDirection="column">
            <Box gap={1}>
              <Box width={NAME_WIDTH} flexShrink={0}>
                <Text color={theme.accent} dimColor wrap="truncate-end">
                  {row.name}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {row.description || "(no description)"}
              </Text>
            </Box>
            {row.source !== undefined && row.source.length > 0 ? (
              <Box gap={1}>
                <Box width={NAME_WIDTH} flexShrink={0} />
                <Text dimColor wrap="truncate-end">{row.source}</Text>
              </Box>
            ) : null}
          </Box>
        ))
      )}
    </Box>
  )
}
