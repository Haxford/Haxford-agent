import { Box, Text } from "ink"
import React, { useState } from "react"

import type { Message, ReasoningPart, TextPart, ToolPart } from "../../types/message.ts"
import { useInterval } from "../hooks.ts"

/** Visible status glyph + color for a tool part. */
function toolGlyph(state: ToolPart["state"]): { glyph: string; color: string } {
  switch (state.status) {
    case "pending":
      return { glyph: "○", color: "yellow" }
    case "running":
      return { glyph: "●", color: "cyan" }
    case "completed":
      return { glyph: "✓", color: "green" }
    case "error":
      return { glyph: "✗", color: "red" }
  }
}

/** First up-to-3 non-empty lines of a block of text, truncated. */
function previewLines(text: string, max = 3): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const shown = lines.slice(0, max)
  if (lines.length > max) shown.push(`… (+${lines.length - max} more lines)`)
  return shown
}

/** Animated dot for a running tool: cycles a spinner-ish glyph. */
function RunningDot(): React.ReactElement {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [i, setI] = React.useState(0)
  useInterval(() => setI((n) => (n + 1) % frames.length), 90)
  return <Text color="cyan">{frames[i]}</Text>
}

function ToolRow({ part }: { part: ToolPart }): React.ReactElement {
  const { glyph, color } = toolGlyph(part.state)
  const title =
    part.state.status === "completed" ? part.state.title
    : part.state.status === "error" ? part.state.error
    : part.state.status === "running" ? `${part.tool}…`
    : part.tool

  const preview =
    part.state.status === "completed" ? previewLines(part.state.output)
    : part.state.status === "error" ? previewLines(part.state.error)
    : []

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {part.state.status === "running" ? <RunningDot /> : <Text color={color}>{glyph}</Text>}
        <Text dimColor>
          <Text color={color}>{part.tool}</Text>
          {" "}
          {title}
        </Text>
      </Box>
      {preview.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">
          {"  "}
          {line.length > 120 ? line.slice(0, 120) + "…" : line}
        </Text>
      ))}
    </Box>
  )
}

function TextBlock({ part, role }: { part: TextPart; role: Message["role"] }): React.ReactElement {
  if (role === "user") {
    // User messages render with a > prefix per line.
    return (
      <Box flexDirection="column">
        {part.text.split("\n").map((line, i) => (
          <Text key={i}>
            <Text color="cyan">{">"}</Text>
            {" "}
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

export function MessageView({ message }: { message: Message }): React.ReactElement {
  const label = message.role === "user" ? "you" : (message.agent ?? message.model ?? "assistant")
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text dimColor>{label}</Text>
      <Box flexDirection="column">
        {message.parts.map((part) => {
          if (part.type === "text") return <TextBlock key={part.id} part={part} role={message.role} />
          if (part.type === "reasoning") return <ReasoningBlock key={part.id} part={part} />
          return <ToolRow key={part.id} part={part} />
        })}
      </Box>
      {message.error !== undefined ? (
        <Text color="red">error: {message.error}</Text>
      ) : null}
    </Box>
  )
}

export interface TranscriptProps {
  messages: Message[]
  /** Optional dimmed system notices (newest last); rendered above the composer. */
  notices?: string[]
}

export function Transcript({ messages, notices }: TranscriptProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
      {notices !== undefined && notices.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
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
