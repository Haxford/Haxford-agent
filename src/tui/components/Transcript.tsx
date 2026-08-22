import { Box, Text } from "ink"
import React from "react"

import type { ImagePart, Message, Part, ReasoningPart, TextPart, ToolPart } from "../../types/message.ts"
import { railProps, theme } from "../theme.ts"
import { Spinner } from "./Spinner.tsx"

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

/** How many output lines a collapsed tool block shows before summarising. */
export const MAX_PREVIEW_LINES = 10

/**
 * First `max` non-empty lines of a block of text, with an overflow footer.
 *
 * Matches the collapse budget every reference harness converged on (~10 lines
 * plus an explicit "there is more" hint). Truncating to three lines with no
 * affordance — the previous behaviour — was the worst of both: too little to
 * be useful, no way to see the rest.
 */
export function previewLines(text: string, max = MAX_PREVIEW_LINES): string[] {
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
  return previewLines(toolOutput(part)).length > 0
}

/** The text a tool part previews, if any. */
function toolOutput(part: ToolPart): string {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return ""
}

/**
 * Blank lines to insert before an item, given whether it and its predecessor
 * are multi-line.
 *
 * opencode's rule, and the single biggest source of visual rhythm: a run of
 * one-line tool calls packs into a tight scannable stack, while anything with
 * a body gets air around it. A uniform `gap={1}` spaces everything equally,
 * which is the same as spacing nothing — that flatness is what read as
 * "minimal and plain".
 */
export function separatorBefore(
  prevMultiline: boolean | undefined,
  curMultiline: boolean,
): 0 | 1 {
  if (prevMultiline === undefined) return 0
  return prevMultiline || curMultiline ? 1 : 0
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
function ToolBlock({ part, lines }: { part: ToolPart; lines: string[] }): React.ReactElement {
  const failed = part.state.status === "error"
  return (
    <Box flexDirection="column" {...railProps(failed ? theme.error : theme.rail, !failed)} paddingLeft={1}>
      <ToolRow part={part} />
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          <Text key={i} color={failed ? theme.error : undefined} dimColor={!failed} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

/** Dispatch a tool part to its one-line or rail-block form. */
function ToolView({ part }: { part: ToolPart }): React.ReactElement {
  const lines = previewLines(toolOutput(part))
  if (lines.length === 0) return <ToolRow part={part} />
  return <ToolBlock part={part} lines={lines} />
}

function TextBlock({ part, role }: { part: TextPart; role: Message["role"] }): React.ReactElement {
  if (role === "user") {
    // The user's own words, marked by a single coloured chevron.
    return (
      <Box flexDirection="column">
        {part.text.split("\n").map((line, i) => (
          <Text key={i}>
            <Text color={theme.user}>{"› "}</Text>
            {line}
          </Text>
        ))}
      </Box>
    )
  }
  return <Text wrap="wrap">{part.text}</Text>
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
function PartView({ part, role }: { part: Part; role: Message["role"] }): React.ReactElement {
  if (part.type === "text") return <TextBlock part={part} role={role} />
  if (part.type === "reasoning") return <ReasoningBlock part={part} />
  if (part.type === "image") return <ImageChip part={part} />
  return <ToolView part={part} />
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

export function MessageView({ message }: { message: Message }): React.ReactElement {
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
            <PartView part={part} role={message.role} />
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
}

/**
 * The live transcript region.
 *
 * `app.tsx` hands settled messages to Ink's `<Static>` and only the tail here,
 * so this component re-renders at streaming rate over one message rather than
 * the whole history.
 */
export function Transcript({ messages, notices }: TranscriptProps): React.ReactElement {
  let prevMultiline: boolean | undefined
  return (
    <Box flexDirection="column">
      {messages.map((m) => {
        const multiline = messageIsMultiline(m)
        const marginTop = separatorBefore(prevMultiline, multiline)
        prevMultiline = multiline
        return (
          <Box key={m.id} flexDirection="column" marginTop={marginTop}>
            <MessageView message={m} />
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
