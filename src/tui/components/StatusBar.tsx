import { Box, Text } from "ink"
import React from "react"

import type { TotalUsage } from "../state.ts"
import { formatElapsed, formatTokens } from "../format.ts"
import { useInterval } from "../hooks.ts"
import { modeColor, theme } from "../theme.ts"
import { Spinner } from "./Spinner.tsx"

export type Mode = "build" | "auto" | "plan"

export interface StatusBarProps {
  model: string
  mode: Mode
  status: "idle" | "running" | "ended" | "error"
  usage: TotalUsage
  /** Context window limit; percent is skipped silently when undefined. */
  contextLimit?: number
  /** Working directory, shown short-form on the right. */
  cwd?: string
  error?: string
  /** Reason from the last loop.end; shown in a warning color when not end_turn. */
  endReason?: string
  /** USD per million prompt tokens for the active model. Omitted => no cost shown. */
  promptPricePerMtok?: number
  /** USD per million completion tokens for the active model. */
  completionPricePerMtok?: number
}

/**
 * Label + color for the mode word.
 *
 * The composer's left rail is the primary mode indicator; this is the echo.
 * Brackets are gone — they were noise around a word that already reads as a
 * label because of its color.
 */
export function modeBadge(mode: Mode): { text: string; color: string } {
  return { text: mode, color: modeColor(mode) }
}

/** Color for a run status glyph. */
export function statusLabel(status: StatusBarProps["status"]): { text: string; color: string } {
  switch (status) {
    case "running":
      return { text: "running", color: theme.accent }
    case "ended":
      return { text: "ended", color: theme.success }
    case "error":
      return { text: "error", color: theme.error }
    case "idle":
      return { text: "idle", color: theme.muted }
  }
}

/** Map a non-end_turn reason to a short label + warning color. */
export function reasonLabel(
  reason: string,
): { text: string; color: string } | undefined {
  switch (reason) {
    case "end_turn":
      return undefined
    case "aborted":
      return { text: "aborted", color: theme.warning }
    case "max_turns":
      return { text: "max turns", color: theme.warning }
    case "permission_denied":
      return { text: "permission denied", color: theme.warning }
    case "error":
      return { text: "error", color: theme.error }
    default:
      return { text: reason, color: theme.warning }
  }
}

/** Context usage as a 0-100 percent, or undefined if unmeasurable. */
export function contextPercent(
  usage: TotalUsage,
  limit?: number,
): number | undefined {
  if (limit === undefined || limit <= 0) return undefined
  const used = usage.input + usage.reasoning
  if (used <= 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

/**
 * Session spend in USD from the accumulated token totals.
 *
 * Returns undefined when there is nothing honest to show: no pricing at all
 * for this model (the catalog does not carry it, or the model is local), or a
 * session that has not spent anything yet. A "$0.0000" that only means "we do
 * not know" is worse than no number, so a missing price is not treated as
 * free — a model priced on one side only still bills the other, and that half
 * is reported rather than dropped.
 *
 * Reasoning tokens are deliberately excluded: providers bill them inside the
 * completion count already, so adding them would double-charge.
 */
export function sessionCost(
  usage: TotalUsage,
  promptPricePerMtok?: number,
  completionPricePerMtok?: number,
): number | undefined {
  if (promptPricePerMtok === undefined && completionPricePerMtok === undefined) return undefined
  const cost =
    (usage.input * (promptPricePerMtok ?? 0) + usage.output * (completionPricePerMtok ?? 0)) / 1e6
  if (!Number.isFinite(cost) || cost <= 0) return undefined
  return cost
}

/** Render a cost as a fixed 4-decimal dollar figure: 0.01234 -> "$0.0123". */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`
}

/**
 * The persistent footer: one line, below the input's lower rule.
 *
 * One line is the entire design. Everything that was competing for space here
 * has a better home — the model and mode are named in the breadcrumb directly
 * above, the cwd is in the banner, errors and interruptions are inline in the
 * transcript where the thing that failed is, and the keybinding reference is
 * behind /help. What is left is the state that changes while you work: whether
 * the agent is busy, and how much of the window is gone.
 *
 * The right-hand side is a pointer, not a status: `/help` and nothing else. A
 * footer that lists every key teaches nothing after the first minute and costs
 * a row forever.
 */
export function StatusBar({
  mode,
  status,
  usage,
  contextLimit,
  promptPricePerMtok,
  completionPricePerMtok,
}: StatusBarProps): React.ReactElement {
  const badge = modeBadge(mode)
  const pct = contextPercent(usage, contextLimit)
  const cost = sessionCost(usage, promptPricePerMtok, completionPricePerMtok)
  const running = status === "running"

  return (
    <Box paddingLeft={2} gap={1}>
      {/* The busy mark leads the line, so "is it doing something" is answered
          at the far left where scanning starts — and it occupies a cell that
          is empty when idle, so the rest of the line never shifts. */}
      {running ? <Spinner /> : null}
      <Text color={badge.color}>{badge.text}</Text>
      <Text dimColor>{"mode (tab to cycle)"}</Text>
      {pct !== undefined ? (
        <>
          <Text dimColor>·</Text>
          <Text dimColor>{"ctx "}{pct}{"%"}</Text>
        </>
      ) : null}
      {cost !== undefined ? (
        <>
          <Text dimColor>·</Text>
          <Text dimColor>{formatCost(cost)}</Text>
        </>
      ) : null}
      <Box flexGrow={1} justifyContent="flex-end">
        <Text dimColor>{"/help"}</Text>
      </Box>
    </Box>
  )
}

/**
 * The inline record of how a turn ended, rendered in the transcript rather
 * than in the chrome.
 *
 * An interrupt and an error are both things that happened *at a point in the
 * conversation*, and a footer cell cannot say that: it shows the same text
 * whether the failure was this turn or ten turns ago, and it vanishes the
 * instant the next turn starts, which is exactly when the user goes looking
 * for what went wrong. Inline, it stays where it happened.
 */
export function TurnOutcome({
  status,
  endReason,
  error,
}: {
  status: StatusBarProps["status"]
  endReason?: string
  error?: string
}): React.ReactElement | null {
  // An abort is a deliberate act, so it is confirmed rather than reported as
  // a fault: yellow, one word, no detail to read.
  if (endReason === "aborted") {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.warning}>{"interrupted"}</Text>
      </Box>
    )
  }
  if (error !== undefined) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.error} wrap="truncate-end">
          {error.length > 200 ? error.slice(0, 200) + "\u2026" : error}
        </Text>
      </Box>
    )
  }
  const reason = status === "ended" && endReason !== undefined ? reasonLabel(endReason) : undefined
  if (reason === undefined) return null
  return (
    <Box paddingLeft={2}>
      <Text color={reason.color}>{reason.text}</Text>
    </Box>
  )
}

export interface ActivityLineProps {
  /** What the agent is doing right now, e.g. a running tool name. */
  verb: string
  /** Epoch millis when the current run started. */
  startedAt: number
  /** Cumulative tokens consumed this session. */
  usage: TotalUsage
  /** Injectable clock, for deterministic tests. */
  now?: () => number
}

/**
 * The transient line above the composer while a run is in flight.
 *
 * Claude Code's contribution to the genre: verb, elapsed, token delta, and the
 * way out — all on one line, so waiting is legible instead of a bare spinner.
 *
 * Owns a 1Hz tick for the elapsed clock. It cannot piggyback on the shared
 * spinner tick: that tick re-renders only the `<Spinner>` context consumers,
 * not this component's body, so a render-time `Date.now()` here would freeze.
 */
export function ActivityLine({ verb, startedAt, usage, now }: ActivityLineProps): React.ReactElement {
  const clock = now ?? Date.now
  const [elapsedMs, setElapsedMs] = React.useState(() => clock() - startedAt)
  useInterval(() => setElapsedMs(clock() - startedAt), 1000)
  // Re-sync immediately when a new run starts, so the clock never shows the
  // previous run's tail while waiting for the first tick.
  React.useEffect(() => { setElapsedMs(clock() - startedAt) }, [startedAt, clock])

  const tokens = usage.input + usage.output + usage.reasoning
  return (
    <Box paddingLeft={2} gap={1}>
      <Spinner />
      <Text color={theme.accent}>{verb}</Text>
      <Text dimColor>·</Text>
      <Text dimColor>{formatElapsed(elapsedMs)}</Text>
      {tokens > 0 ? (
        <>
          <Text dimColor>·</Text>
          <Text dimColor>{`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`}</Text>
        </>
      ) : null}
      <Text dimColor>·</Text>
      <Text dimColor>esc to interrupt</Text>
    </Box>
  )
}
