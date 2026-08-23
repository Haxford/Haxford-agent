import { Box, Text } from "ink"
import React from "react"

import type { ImagePart, Message, Part, ReasoningPart, TextPart, ToolPart } from "../../types/message.ts"
import { separatorBefore } from "../layout.ts"
import { railProps, theme } from "../theme.ts"
import { COLLAPSED_DIFF_LINES, DiffView, isDiffLike, MAX_DIFF_LINES } from "./Diff.tsx"
import { Markdown } from "./Markdown.tsx"
import { Spinner } from "./Spinner.tsx"

/** Re-exported so existing importers keep one place to reach for the rule. */
export { separatorBefore }

/** Visible status glyph + color for a tool part. */
function toolGlyph(state: ToolPart["state"]): { glyph: string; color: string } {
  switch (state.status) {
    case "pending":
      return { glyph: "○", color: theme.warning }
    case "running":
      return { glyph: "●", color: theme.accent }
    case "completed":
      return { glyph: "✓", color: theme.success }
    case "error":
      return { glyph: "✗", color: theme.error }
  }
}

/**
 * Output lines a collapsed tool call shows.
 *
 * Three, not ten: collapsed is meant to answer "what happened" in a row you
 * scan past, and anything longer stops being a summary and starts being a
 * short version of the thing you collapsed. The full text is one ctrl+o away.
 */
export const COLLAPSED_PREVIEW_LINES = 3

/**
 * Output lines an expanded tool call shows.
 *
 * A cap, not a budget — expanded means "show me everything", but a 40k-line
 * file read would take the terminal with it, so there is still a ceiling and
 * it still says when it truncates.
 */
export const EXPANDED_PREVIEW_LINES = 200

/**
 * First `max` non-empty lines of a block of text, with an overflow footer.
 *
 * Blank lines are dropped before counting: tool output is padded with them
 * far more often than it is meaningfully spaced by them, and spending a
 * three-line budget on whitespace is how a preview ends up saying nothing.
 */
export function previewLines(text: string, max = COLLAPSED_PREVIEW_LINES): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const shown = lines.slice(0, max)
  if (lines.length > max) shown.push(`… ${lines.length - max} more lines`)
  return shown
}

/**
 * Does this part occupy more than one rendered line?
 *
 * Drives the adaptive spacing rule below, so it must agree with what the
 * renderers actually emit.
 */
export function partIsMultiline(part: Part): boolean {
  if (part.type === "text") return part.text.includes("\n")
  if (part.type === "reasoning") return part.text.includes("\n")
  if (part.type === "image") return false
  return toolOutput(part).trim().length > 0
}

/** The text a tool part previews, if any. */
function toolOutput(part: ToolPart): string {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return ""
}

/** A collapsed, one-line tool call. */
function ToolRow({ part }: { part: ToolPart }): React.ReactElement {
  const { glyph, color } = toolGlyph(part.state)
  const title =
    part.state.status === "completed" ? part.state.title
    : part.state.status === "error" ? part.state.error
    : part.state.status === "running" ? `${part.tool}…`
    : part.tool

  return (
    <Box gap={1}>
      {part.state.status === "running" ? <Spinner /> : <Text color={color}>{glyph}</Text>}
      <Text color={color}>{part.tool}</Text>
      <Text dimColor wrap="truncate-end">{title}</Text>
    </Box>
  )
}

/**
 * A tool call with output, grouped by a left rail.
 *
 * The rail is deliberately near-invisible (`theme.rail` + `borderDimColor`):
 * it groups, it does not announce. A bright rail on every tool call is exactly
 * the loud-but-plain trap. Errors are the one case that earns a coloured rail.
 */
function ToolBlock({
  part,
  children,
}: {
  part: ToolPart
  children: React.ReactNode
}): React.ReactElement {
  const failed = part.state.status === "error"
  return (
    <Box flexDirection="column" {...railProps(failed ? theme.error : theme.rail, !failed)} paddingLeft={1}>
      <ToolRow part={part} />
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * Whether a tool part shows its full detail right now.
 *
 * A running call is always expanded regardless of the global toggle: it is the
 * one thing on screen you are actively waiting on, and collapsing live
 * progress to a summary line hides the only information that is changing.
 */
export function toolIsExpanded(part: ToolPart, toolsExpanded: boolean): boolean {
  return toolsExpanded || part.state.status === "running"
}

/** Dispatch a tool part to its one-line or rail-block form. */
function ToolView({
  part,
  toolsExpanded,
}: {
  part: ToolPart
  toolsExpanded: boolean
}): React.ReactElement {
  const output = toolOutput(part)
  if (output.trim().length === 0) return <ToolRow part={part} />

  const expanded = toolIsExpanded(part, toolsExpanded)
  const failed = part.state.status === "error"

  // A diff is rendered as a diff whether collapsed or not — it is the shape
  // that carries the meaning, so degrading it to grey text would lose more
  // than the lines saved.
  if (isDiffLike(output)) {
    return (
      <ToolBlock part={part}>
        <DiffView
          text={output}
          max={expanded ? MAX_DIFF_LINES : COLLAPSED_DIFF_LINES}
          compact={!expanded}
        />
      </ToolBlock>
    )
  }

  const lines = previewLines(output, expanded ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES)
  return (
    <ToolBlock part={part}>
      {lines.map((line, i) => (
        <Text key={i} color={failed ? theme.error : undefined} dimColor={!failed} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </ToolBlock>
  )
}

/**
 * Exported (alongside the other pure pieces in this file) so tests can walk
 * its returned element tree directly: `ink-testing-library`'s captured frame
 * carries no ANSI styling at all unless the process was started with
 * `FORCE_COLOR` set (chalk's colour-support detection is cached at import
 * time, so setting it from inside a running test has no effect) — so `bold`
 * cannot be asserted from `lastFrame()` output in this suite. Calling this
 * directly is a plain function call (no hooks), safe outside of Ink's own
 * render.
 */
export function TextBlock({ part, role }: { part: TextPart; role: Message["role"] }): React.ReactElement {
  if (role === "user") {
    // The user's own words, marked by a single coloured chevron — and left
    // exactly as typed. Rendering the user's markdown would mean showing them
    // something other than what they wrote, which is the one place a prettier
    // transcript is the wrong trade.
    return (
      <Box flexDirection="column">
        {part.text.split("\n").map((line, i) => (
          // Bold on the whole line, not just the chevron: a same-weight dim
          // line next to dim tool output is easy to lose. The chevron carries
          // its own colour on top so it still reads as the marker at a glance.
          <Text key={i} bold>
            <Text color={theme.user}>{"› "}</Text>
            {line}
          </Text>
        ))}
      </Box>
    )
  }
  return <Markdown text={part.text} />
}

function ReasoningBlock({ part }: { part: ReasoningPart }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {part.text.split("\n").map((line, i) => (
        <Text key={i} italic dimColor>
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** Render one part in its appropriate form. */
function PartView({
  part,
  role,
  toolsExpanded,
}: {
  part: Part
  role: Message["role"]
  toolsExpanded: boolean
}): React.ReactElement {
  if (part.type === "text") return <TextBlock part={part} role={role} />
  if (part.type === "reasoning") return <ReasoningBlock part={part} />
  if (part.type === "image") return <ImageChip part={part} />
  return <ToolView part={part} toolsExpanded={toolsExpanded} />
}

/** Inline placeholder for an attached image (terminals can't render pixels). */
function ImageChip({ part }: { part: ImagePart }): React.ReactElement {
  const name = part.source?.split("/").pop() ?? "pasted image"
  const bytes = Math.floor((part.data.length * 3) / 4)
  const kb = bytes >= 1024 ? `${Math.round(bytes / 1024)} kB` : `${bytes} B`
  return (
    <Box>
      <Text color={theme.accent}>▣ {name}</Text>
      <Text dimColor>
        {" "}
        {part.mime.replace("image/", "")} · {kb}
      </Text>
    </Box>
  )
}

export function MessageView({
  message,
  toolsExpanded = false,
}: {
  message: Message
  /** Global tool-output expansion (ctrl+o). */
  toolsExpanded?: boolean
}): React.ReactElement {
  // Adaptive spacing between parts: `gap` is gone in favour of a per-item
  // margin derived from whether the neighbours have bodies.
  let prevMultiline: boolean | undefined
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {message.parts.map((part) => {
        const multiline = partIsMultiline(part)
        const marginTop = separatorBefore(prevMultiline, multiline)
        prevMultiline = multiline
        return (
          <Box key={part.id} flexDirection="column" marginTop={marginTop}>
            <PartView part={part} role={message.role} toolsExpanded={toolsExpanded} />
          </Box>
        )
      })}
      {message.error !== undefined ? (
        <Box {...railProps(theme.error, false)} paddingLeft={1} marginTop={1}>
          <Text color={theme.error} wrap="truncate-end">{message.error}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** Is a whole message multi-line, for spacing between messages? */
export function messageIsMultiline(message: Message): boolean {
  if (message.error !== undefined) return true
  if (message.parts.length > 1) return true
  const first = message.parts[0]
  return first === undefined ? false : partIsMultiline(first)
}

export interface TranscriptProps {
  messages: Message[]
  /** Optional dimmed system notices (newest last); rendered above the composer. */
  notices?: string[]
  /** Global tool-output expansion (ctrl+o). */
  toolsExpanded?: boolean
}

/**
 * The live transcript region.
 *
 * `app.tsx` hands settled messages to Ink's `<Static>` and only the tail here,
 * so this component re-renders at streaming rate over one message rather than
 * the whole history.
 */
export function Transcript({ messages, notices, toolsExpanded = false }: TranscriptProps): React.ReactElement {
  let prevMultiline: boolean | undefined
  return (
    <Box flexDirection="column">
      {messages.map((m) => {
        const multiline = messageIsMultiline(m)
        // A user turn always gets a blank line above it, whatever its
        // neighbour's shape — it has to be unmistakable where your own turn
        // starts, not just "sometimes there's a gap." Every other pairing
        // still follows the adaptive multiline rule.
        const marginTop = m.role === "user" ? 1 : separatorBefore(prevMultiline, multiline)
        prevMultiline = multiline
        return (
          <Box key={m.id} flexDirection="column" marginTop={marginTop}>
            <MessageView message={m} toolsExpanded={toolsExpanded} />
          </Box>
        )
      })}
      {notices !== undefined && notices.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {notices.slice(-5).map((n, i) => (
            <Text key={i} dimColor wrap="wrap">
              {"» "}
              {n}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
