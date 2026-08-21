import { Box, Text } from "ink"
import React from "react"

import type { PermissionRequest } from "../../types/tool.ts"

export interface PermissionDialogProps {
  request: PermissionRequest
}

/** Glyph + color summarizing the action kind (write/edit = mutate, bash = shell, etc.). */
function actionKind(tool: string): { glyph: string; color: string; word: string } {
  switch (tool) {
    case "bash":
      return { glyph: "$", color: "yellow", word: "run command" }
    case "write":
    case "edit":
      return { glyph: "✎", color: "blue", word: "edit file" }
    case "task":
      return { glyph: "▹", color: "magenta", word: "spawn subagent" }
    default:
      return { glyph: "?", color: "yellow", word: tool }
  }
}

/** Format args as indented JSON, truncated to ~8 lines. */
function formatArgs(args: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(args, null, 2)
  } catch {
    json = String(args)
  }
  const lines = json.split("\n")
  if (lines.length <= 8) return json
  return lines.slice(0, 8).join("\n") + `\n… (+${lines.length - 8} more lines)`
}

/** The primary subject (path or command) for dim code-style display. */
function subjectOf(request: PermissionRequest): string | undefined {
  const { args } = request
  const v = args["command"] ?? args["filePath"] ?? args["path"]
  return typeof v === "string" ? v : undefined
}

export function PermissionDialog({ request }: PermissionDialogProps): React.ReactElement {
  const kind = actionKind(request.tool)
  const subject = subjectOf(request)
  const args = formatArgs(request.args)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={kind.color}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <Box gap={1}>
        <Text color={kind.color} bold>{kind.glyph}</Text>
        <Text bold color={kind.color}>{kind.word}</Text>
        <Text dimColor>·</Text>
        <Text bold>{request.tool}</Text>
      </Box>
      <Text bold>{request.title}</Text>
      {subject !== undefined ? (
        <Text dimColor>{subject}</Text>
      ) : null}
      <Box flexDirection="column">
        <Text dimColor>{"args:"}</Text>
        <Text color="gray">{args}</Text>
      </Box>
      <Box gap={3}>
        <Text>
          <Text color="green" bold>{"[a]"}</Text>
          {" allow once"}
        </Text>
        <Text>
          <Text color="cyan" bold>{"[l]"}</Text>
          {" always (this session)"}
        </Text>
        <Text>
          <Text color="red" bold>{"[d]"}</Text>
          {" deny"}
        </Text>
      </Box>
      <Text dimColor>{"esc = deny"}</Text>
    </Box>
  )
}
