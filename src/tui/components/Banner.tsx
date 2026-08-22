import { Box, Text } from "ink"
import React from "react"

import { APP_VERSION } from "../../providers/attribution.ts"
import { theme } from "../theme.ts"

/**
 * The session header: three plain lines, printed once at session start and
 * never touched again.
 *
 * No box, no border, no greeting. The border went away because a box reads as
 * "a distinct thing" and the header is not distinct from the transcript it
 * opens — it is the first thing said, in the same voice. The greeting went
 * away because pi's measured start screen spends its first lines on facts you
 * act on, not on pleasantries: what this is, what the keys are, and that the
 * agent can explain itself. The model and cwd live one line up from where you
 * type now (the footer), which is where they are useful.
 */

/**
 * The package version, shown in the header.
 *
 * Imported, not hardcoded: this drifted from package.json once already, so
 * attribution.ts — which is itself pinned to package.json by test — is the
 * single source and this re-export keeps the old import path alive.
 */
export const VERSION = APP_VERSION

/**
 * Rows the header occupies. Bottom-pinning subtracts this, so it has to match
 * what renders: title, hints, self-description — one row each, no padding,
 * no border.
 */
export const HEADER_LINES = 3

/** Line 2: the four keys worth knowing, middle-dot separated, dim. */
export const HEADER_HINTS =
  "esc interrupt · ctrl+c twice quit · / commands · /help more"

/** Line 3: the self-awareness line. Dim; it is context, not an action.
 * Kept under 78 chars so it never wraps at an 80-column terminal — the pin
 * math subtracts HEADER_LINES and wrapping would shift first paint. */
export const HEADER_ABOUT =
  "self-extensible: skills · extensions · themes · agents · ~/.haxford/EXTENDING.md"

/** Replace a leading home directory with `~`, so the footer cwd stays readable. */
export function tildeCwd(
  cwd: string,
  home: string | undefined = process.env["HOME"],
): string {
  if (home === undefined || home.length === 0) return cwd
  if (cwd === home) return "~"
  const prefix = home.endsWith("/") ? home : `${home}/`
  return cwd.startsWith(prefix) ? `~/${cwd.slice(prefix.length)}` : cwd
}

/** Render the session header: three bare lines. */
export function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={theme.accent}>{"haxford"}</Text>
        <Text dimColor>{" v"}{VERSION}</Text>
      </Text>
      <Text dimColor>{HEADER_HINTS}</Text>
      <Text dimColor>{HEADER_ABOUT}</Text>
    </Box>
  )
}
