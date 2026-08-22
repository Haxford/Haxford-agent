import { Box, Text } from "ink"
import React from "react"

import type { TotalUsage } from "../state.ts"
import { tildeCwd } from "../components/Banner.tsx"
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
  /** Working directory, shown tilde-shortened on the left of the footer. */
  cwd?: string
  /** Git branch of `cwd`, probed once at startup; omitted when it cannot be resolved. */
  branch?: string
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
 * The mode lives in the footer's right cluster now, wrapped in parentheses
 * after the ctx figure — pi's arrangement. It was a standalone word before;
 * the parentheses make it read as metadata attached to the numbers beside it.
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

/**
 * The short form of a model spec: the model, without the provider that serves
 * it. The provider is named once by the picker and the banner's absence is
 * deliberate — a one-line footer cannot afford it, and specs that carry a
 * nested path (`openrouter/z-ai/glm-5.2`) keep only the final segment, which
 * is the part that names the model.
 *
 * Moved here when the breadcrumb merged into this footer: one line says the
 * model now, so the shortener lives next to the only thing that renders it.
 */
export function shortModel(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.length === 0) return trimmed
  const slash = trimmed.lastIndexOf("/")
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
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

// --- footer composition ----------------------------------------------------

/**
 * The footer's left half: where you are, and which branch.
 *
 * Pure and exported so composition is testable without rendering. An absent
 * cwd degrades to the bare branch; both absent degrade to an empty string and
 * the component skips the node entirely rather than printing an empty gap.
 */
export function footerLeft(cwd: string | undefined, branch?: string): string {
  if (cwd === undefined || cwd.length === 0) return branch ?? ""
  const base = tildeCwd(cwd)
  return branch === undefined || branch.length === 0 ? base : `${base} (${branch})`
}

/** What each piece of the footer's right cluster is, and how it is coloured. */
export type FooterRole = "dim" | "mode" | "model" | "cost"

export interface FooterSegment {
  text: string
  role: FooterRole
}

/**
 * The footer's right half, as ordered coloured runs:
 * `ctx N% (<mode>) · <model-short> • <$cost>`.
 *
 * The cost rides after the model, dot-separated like everything else on the
 * line; it simply does not appear when there is nothing honest to show.
 * Segments rather than one composed string because the mode word and the
 * model name are the two coloured tokens on this line — composing first and
 * re-parsing to colour would be the fragile version of the same feature.
 */
export function footerSegments(opts: {
  mode: Mode
  model: string
  pct?: number
  cost?: number
}): FooterSegment[] {
  const segs: FooterSegment[] = []
  // The ctx figure leads the cluster: it is the number that changes while you
  // work, and it anchors the parenthesised mode that follows it.
  segs.push({
    text: opts.pct !== undefined ? `ctx ${opts.pct}% (` : "(",
    role: "dim",
  })
  segs.push({ text: opts.mode, role: "mode" })
  segs.push({ text: ")", role: "dim" })
  const short = shortModel(opts.model)
  if (short.length > 0) {
    segs.push({ text: " · ", role: "dim" })
    segs.push({ text: short, role: "model" })
  }
  if (opts.cost !== undefined) {
    segs.push({ text: " • ", role: "dim" })
    segs.push({ text: formatCost(opts.cost), role: "cost" })
  }
  return segs
}

/** The right cluster as one plain string (tests, logging, width math). */
export function footerRight(opts: Parameters<typeof footerSegments>[0]): string {
  return footerSegments(opts)
    .map((s) => s.text)
    .join("")
}

/**
 * The persistent footer: one line, below the input's lower rule.
 *
 * Merged with what used to be the breadcrumb above the input — pi's measured
 * start screen spends exactly one row saying where you are and what is
 * answering, and that row belongs at the bottom edge, adjacent to the input
 * it describes. Left: cwd (git-branch), tilde-shortened. Right: the live
 * figures — ctx%, the permission mode in parentheses, the short model, and
 * the running cost when it is known. The busy mark leads the whole line when
 * a run is in flight, so "is it doing something" is answered at the far left
 * where scanning starts, in a cell that is empty when idle.
 *
 * Everything that was competing for space here has a better home: the
 * keybinding reference moved into the header's hint line and behind /help,
 * errors and interruptions are inline in the transcript where the thing that
 * failed is.
 */
export function StatusBar({
  cwd,
  branch,
  model,
  mode,
  status,
  usage,
  contextLimit,
  promptPricePerMtok,
  completionPricePerMtok,
}: StatusBarProps): React.ReactElement {
  const pct = contextPercent(usage, contextLimit)
  const cost = sessionCost(usage, promptPricePerMtok, completionPricePerMtok)
  const running = status === "running"
  const left = footerLeft(cwd, branch)
  const segments = footerSegments({ mode, model, pct, cost })

  return (
    <Box paddingLeft={2} gap={1}>
      {running ? <Spinner /> : null}
      {left.length > 0 ? (
        <Text dimColor wrap="truncate-middle">{left}</Text>
      ) : null}
      <Box flexGrow={1} justifyContent="flex-end">
        <Text>
          {segments.map((seg, i) => {
            if (seg.role === "mode") {
              return (
                <Text key={i} color={modeBadge(mode).color}>{seg.text}</Text>
              )
            }
            if (seg.role === "model") {
              return <Text key={i} color={theme.model}>{seg.text}</Text>
            }
            return <Text key={i} dimColor>{seg.text}</Text>
          })}
        </Text>
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
