import { Box, Text } from "ink"
import React from "react"

/**
 * Startup banner, shown when the transcript is empty (and after /clear).
 *
 * Deliberately minimal — a single header line (glyph + wordmark + version)
 * and one dim hint line. No large ASCII art. Matches the pi/opencode school
 * of restraint: a calm, professional empty state, not a decorative one.
 */

/** The package version, shown in the header. */
export const VERSION = "0.1.0"

/** Header glyph — a small, wide-char-safe mark (no box-drawing that can break). */
const GLYPH = "◆"

export interface BannerProps {
  model: string
  mode: "build" | "auto" | "plan"
  cwd: string
}

/** Render the minimal header + hint. */
export function Banner({ model, mode, cwd }: BannerProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0} paddingBottom={1}>
      <Box gap={1}>
        <Text color="magenta">{GLYPH}</Text>
        <Text bold color="magenta">haxford</Text>
        <Text dimColor>v{VERSION}</Text>
      </Box>
      <Text dimColor>{model} · {mode} · {cwd} · /help for commands</Text>
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
