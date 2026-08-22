import { Box, Text } from "ink"
import React from "react"

import type { PermissionRequest } from "../../types/tool.ts"
import { theme } from "../theme.ts"

export interface PermissionDialogProps {
  request: PermissionRequest
}

/** Glyph + color summarizing the action kind (write/edit = mutate, bash = shell, etc.). */
function actionKind(tool: string): { glyph: string; color: string; word: string } {
  switch (tool) {
    case "bash":
      return { glyph: "$", color: theme.warning, word: "run command" }
    case "write":
    case "edit":
      return { glyph: "✎", color: theme.warning, word: "edit file" }
    case "task":
      return { glyph: "▹", color: theme.warning, word: "spawn subagent" }
    default:
      return { glyph: "?", color: theme.warning, word: tool }
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
  // A single coloured border — the one interruption the chrome is allowed.
  //
  // Everywhere else groups with rails and separates with dim rules, precisely
  // so that this can be different: a permission prompt is the only moment the
  // UI stops the user rather than informing them, and it has to be
  // unmistakable at a glance, not just one more block in the flow. The colour
  // is `warning`, not `accent`, because accent is already spent on the prompt
  // glyph and the active mode; yellow is what this file's palette reserves for
  // "something wants your attention", which is the entire content here.
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={kind.color}
      paddingX={1}
    >
      <Box gap={1}>
        <Text color={kind.color} bold>{"△"}</Text>
        <Text bold color={kind.color}>{kind.word}</Text>
        <Text dimColor>·</Text>
        <Text bold>{request.tool}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold wrap="truncate-end">{request.title}</Text>
      </Box>
      {subject !== undefined ? (
        <Text dimColor wrap="truncate-end">{subject}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"args:"}</Text>
        <Text color={theme.muted}>{args}</Text>
      </Box>
      <Box gap={3} marginTop={1}>
        <Text>
          <Text color={theme.success} bold>{"[a]"}</Text>
          {" allow once"}
        </Text>
        <Text>
          <Text color={theme.accent} bold>{"[l]"}</Text>
          {" always (this session)"}
        </Text>
        <Text>
          <Text color={theme.error} bold>{"[d]"}</Text>
          {" deny"}
        </Text>
      </Box>
      <Text dimColor>{"esc = deny"}</Text>
    </Box>
  )
}
