import { Box, Text } from "ink"
import React from "react"

/**
 * Startup banner: an original compact mascot + wordmark, shown when the
 * transcript is empty (and after /clear). Kept under ~14 lines total and
 * ASCII-only so borders never break in narrow terminals.
 */

/** The mascot + wordmark as plain lines (exported for tests). */
export const BANNER_LINES = [
  "    ╓╖",
  "   ╓╜ ╙╖    ╔╗",
  "  ╓╜   ╙╖  ╔╝╚╗",
  " ╓╜  ▒▒  ╙╖║  ║   __",
  " ║   ▒▒   ║║  ║  /  )___",
  " ║   ▒▒   ║╚╗╔╝  \\__|___)",
  " ╙╖      ╔╜ ╚╝   haxford",
  "  ╙╖════╔╝",
  "   ╚════╝",
]

/** Render the mascot + wordmark block. */
export function Mascot(): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {BANNER_LINES.map((line, i) => (
        <Text key={i} color="magenta" dimColor={i >= 4}>{line}</Text>
      ))}
    </Box>
  )
}

export interface BannerProps {
  model: string
  mode: "build" | "auto" | "plan"
  cwd: string
}

/** Hint line: model · mode · cwd · /help hint. Kept to one wrapped line. */
function hintLine(model: string, mode: string, cwd: string): string {
  return `${model} · ${mode} · ${cwd} · /help for commands`
}

export function Banner({ model, mode, cwd }: BannerProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1} paddingBottom={1}>
      <Mascot />
      <Text dimColor>{hintLine(model, mode, cwd)}</Text>
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
