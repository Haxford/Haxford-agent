import { Box, Text } from "ink"
import React from "react"

import { formatCtx } from "../format.ts"
import { theme } from "../theme.ts"

/**
 * Startup header, shown while the transcript is empty (and after /clear).
 *
 * Modelled on pi: a plain text wordmark, two lines of session facts, and a
 * grid of affordances. No ASCII art — a wordmark at the same scale as the
 * text beside it, which is the only kind of terminal branding that reads as
 * professional rather than decorative.
 *
 * The grid is the point: an empty state should teach. Six key/verb pairs cost
 * two lines and answer "what can I do here?" without a trip to /help.
 */

/** The package version, shown in the header. */
export const VERSION = "0.1.0"

/** Affordances taught by the empty state, laid out three per row. */
export const HINTS: ReadonlyArray<readonly [key: string, verb: string]> = [
  ["/help", "commands"],
  ["tab", "cycle mode"],
  ["esc", "interrupt"],
  ["up/dn", "history"],
  ["enter", "send"],
  ["ctrl+c", "quit"],
]

/** Number of hint cells per row. */
const COLUMNS = 3

/** Chunk hints into rows of `COLUMNS`. Exported for unit testing. */
export function hintRows(
  hints: ReadonlyArray<readonly [string, string]> = HINTS,
  columns: number = COLUMNS,
): ReadonlyArray<readonly [string, string]>[] {
  if (columns <= 0) return [[...hints]]
  const rows: ReadonlyArray<readonly [string, string]>[] = []
  for (let i = 0; i < hints.length; i += columns) {
    rows.push(hints.slice(i, i + columns))
  }
  return rows
}

export interface BannerProps {
  model: string
  cwd: string
  /** Context window for the active model; the "· Nk ctx" suffix is skipped when absent. */
  contextLimit?: number
}

/** Render the wordmark, session facts, and the affordance grid. */
export function Banner({ model, cwd, contextLimit }: BannerProps): React.ReactElement {
  const ctx = contextLimit !== undefined && contextLimit > 0 ? ` · ${formatCtx(contextLimit)} ctx` : ""
  return (
    // No paddingBottom: the app supplies the gap below, so spacing lives in
    // one place instead of being summed from two.
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text bold color={theme.text || undefined}>haxford</Text>
        <Text dimColor>{"  v"}{VERSION}</Text>
      </Text>
      <Text dimColor>{model}{ctx}</Text>
      <Text dimColor>{cwd}</Text>
      <Box flexDirection="column" marginTop={1}>
        {hintRows().map((row, r) => (
          <Box key={r} flexDirection="row">
            {row.map(([key, verb]) => (
              // flexBasis 0 + flexGrow 1 shares the width evenly and shrinks
              // gracefully on narrow terminals; Yoga measures with string-width,
              // so this stays correct for wide characters.
              <Box key={key} flexGrow={1} flexBasis={0} gap={1}>
                <Text color={theme.accent}>{key}</Text>
                <Text dimColor>{verb}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** A short, basename-only cwd for the status bar / banner hint. */
export function shortCwd(cwd: string): string {
  // Tolerate trailing slashes and empty input.
  const clean = cwd.replace(/\/+$/, "")
  if (clean.length === 0) return "/"
  const slash = clean.lastIndexOf("/")
  return slash === -1 ? clean : clean.slice(slash + 1)
}
