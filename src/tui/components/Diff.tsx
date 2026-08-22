import { Box, Text } from "ink"
import React from "react"

import { theme } from "../theme.ts"

/**
 * Unified-diff rendering for tool output.
 *
 * Tool output arrives as one opaque string, so whether it is a diff has to be
 * inferred. The payoff is large: `bash` running `git diff` / `diff -u` is the
 * single most common way a wall of text lands in the transcript today, and an
 * uncoloured diff is close to unreadable. Detection is deliberately strict —
 * a false positive would recolour ordinary output, which is worse than
 * leaving a real diff plain.
 */

/** What a diff line is, which is exactly what decides how it is coloured. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Lines shown before a rendered diff is cut short. */
export const MAX_DIFF_LINES = 40

/**
 * Lines shown while tool output is collapsed.
 *
 * Larger than the 3-line budget a plain output preview gets: a diff needs a
 * marker line or two on each side of a change before it says anything, and
 * three lines of a hunk header is pure noise.
 */
export const COLLAPSED_DIFF_LINES = 8

/** `@@ -12,7 +12,9 @@ optional trailing context` */
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
/** `--- a/path`, `+++ b/path`, `diff --git …`, `index abc..def` */
const META = /^(?:diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (?:from|to) |Binary files )/

/**
 * Does this text look like a unified diff?
 *
 * Two independent signals, either of which is enough:
 *
 *  1. A real hunk header, or a `--- ` / `+++ ` file-header pair. These are
 *     unambiguous — nothing else in tool output produces them.
 *  2. A dense block of `+`/`-` lines with *both* signs present. This catches
 *     bare hunk bodies pasted without headers. Requiring both signs is what
 *     keeps a plain `ls` listing or a markdown-ish bullet dump out.
 *
 * Note the ordering trap this avoids: `---`/`+++` must be classified before
 * `-`/`+`, or a file header counts as a deletion and an addition and every
 * diff trivially passes signal 2.
 */
export function isDiffLike(text: string): boolean {
  const lines = text.split("\n")
  let hunks = 0
  let adds = 0
  let dels = 0
  let markers = 0
  let content = 0
  let sawOldHeader = false
  let sawNewHeader = false

  for (const line of lines) {
    if (line.length === 0) continue
    content++
    if (HUNK.test(line)) {
      hunks++
      continue
    }
    if (line.startsWith("--- ")) {
      sawOldHeader = true
      continue
    }
    if (line.startsWith("+++ ")) {
      sawNewHeader = true
      continue
    }
    if (META.test(line)) continue
    if (line.startsWith("+")) {
      adds++
      markers++
    } else if (line.startsWith("-")) {
      dels++
      markers++
    }
  }

  if (hunks > 0) return true
  if (sawOldHeader && sawNewHeader) return true
  if (content === 0) return false
  return adds > 0 && dels > 0 && markers >= 4 && markers / content >= 0.6
}

/** Classify every line of a diff. Pure, so the colouring is unit-testable. */
export function parseDiff(text: string): DiffLine[] {
  return text.split("\n").map((line) => {
    if (HUNK.test(line)) return { kind: "hunk" as const, text: line }
    // Before the +/- tests: a file header is not a one-character change.
    if (line.startsWith("--- ") || line.startsWith("+++ ") || META.test(line)) {
      return { kind: "meta" as const, text: line }
    }
    if (line.startsWith("+")) return { kind: "add" as const, text: line }
    if (line.startsWith("-")) return { kind: "del" as const, text: line }
    return { kind: "context" as const, text: line }
  })
}

/** A diff cut to a budget, plus how many lines that hid. */
export interface TruncatedDiff {
  lines: DiffLine[]
  hidden: number
}

/**
 * Cut a diff to `max` lines.
 *
 * Trailing blank lines are dropped first so a diff ending in a newline does
 * not spend part of its budget — and does not report "… 1 more lines" for a
 * line that holds nothing.
 */
export function truncateDiff(lines: DiffLine[], max = MAX_DIFF_LINES): TruncatedDiff {
  const trimmed = [...lines]
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1]?.text ?? "").trim().length === 0) {
    trimmed.pop()
  }
  if (trimmed.length <= max) return { lines: trimmed, hidden: 0 }
  return { lines: trimmed.slice(0, max), hidden: trimmed.length - max }
}

/** Colour + weight for a diff line kind. */
export function diffLineStyle(kind: DiffLineKind): {
  color?: string
  bold: boolean
  dim: boolean
} {
  switch (kind) {
    // green/red rather than the accent: theme.ts already reserves diffAdd and
    // diffDel for exactly this, and +/- as green/red is the one terminal
    // convention every user already knows.
    case "add":
      return { color: theme.diffAdd, bold: true, dim: false }
    case "del":
      return { color: theme.diffDel, bold: false, dim: false }
    case "hunk":
      return { bold: false, dim: true }
    case "meta":
      return { bold: false, dim: true }
    case "context":
      return { bold: false, dim: false }
  }
}

/**
 * Drop the file-header noise (`diff --git`, `index …`, `--- a/…`, `+++ b/…`).
 *
 * Hunk headers stay: they carry line numbers. This exists for the collapsed
 * view, where five header lines out of an eight-line budget means the preview
 * shows no changes at all — and the tool row already names the file, so the
 * headers were repeating what was on the line above them.
 */
export function stripDiffMeta(lines: DiffLine[]): DiffLine[] {
  return lines.filter((l) => l.kind !== "meta")
}

export interface DiffViewProps {
  /** Raw diff text, as it came out of the tool. */
  text: string
  /** Line budget; defaults to the full-size cap. */
  max?: number
  /** Drop file headers so a small budget goes to the changes themselves. */
  compact?: boolean
}

/**
 * Render diff text with per-line colour.
 *
 * The overflow footer matches `previewLines`' wording ("… N more lines")
 * because the two truncations sit side by side in the same transcript and
 * reading as one mechanism is the whole point.
 */
export function DiffView({ text, max = MAX_DIFF_LINES, compact = false }: DiffViewProps): React.ReactElement {
  const parsed = parseDiff(text)
  const { lines, hidden } = truncateDiff(compact ? stripDiffMeta(parsed) : parsed, max)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const s = diffLineStyle(line.kind)
        return (
          <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate-end">
            {line.text.length === 0 ? " " : line.text}
          </Text>
        )
      })}
      {hidden > 0 ? <Text dimColor>{`… ${hidden} more lines`}</Text> : null}
    </Box>
  )
}
