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
 * The persistent footer, rendered *below* the composer — the position every
 * reference harness uses.
 *
 * Deliberately absent: the turn counter and the session id. Neither pi,
 * opencode, nor Claude Code surfaces either; both are implementation detail
 * competing with the numbers that matter.
 */
export function StatusBar({
  model,
  mode,
  status,
  usage,
  contextLimit,
  cwd,
  error,
  endReason,
  promptPricePerMtok,
  completionPricePerMtok,
}: StatusBarProps): React.ReactElement {
  const s = statusLabel(status)
  const badge = modeBadge(mode)
  const r = endReason !== undefined ? reasonLabel(endReason) : undefined
  const pct = contextPercent(usage, contextLimit)
  const cost = sessionCost(usage, promptPricePerMtok, completionPricePerMtok)

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} gap={1}>
        {status === "running" ? <Spinner /> : <Text color={s.color}>●</Text>}
        <Text color={badge.color}>{badge.text}</Text>
        <Text dimColor>{model}</Text>
        {/* Everything past here is right-aligned. */}
        <Box flexGrow={1} justifyContent="flex-end" gap={1}>
          {r !== undefined ? <Text color={r.color}>{r.text}</Text> : null}
          {cwd !== undefined ? <Text dimColor>{cwd}</Text> : null}
          {cost !== undefined ? <Text dimColor>{formatCost(cost)}</Text> : null}
          {pct !== undefined ? <Text dimColor>ctx {pct}%</Text> : null}
        </Box>
      </Box>
      {error !== undefined ? (
        <Box paddingLeft={2}>
          <Text color={theme.error} wrap="truncate-end">
            {error.length > 100 ? error.slice(0, 100) + "…" : error}
          </Text>
        </Box>
      ) : null}
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
