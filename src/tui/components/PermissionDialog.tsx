import { Box, Text } from "ink"
import React from "react"

import type { PermissionRequest } from "../../types/tool.ts"

export interface PermissionDialogProps {
  request: PermissionRequest
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

export function PermissionDialog({ request }: PermissionDialogProps): React.ReactElement {
  const args = formatArgs(request.args)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <Box gap={1}>
        <Text color="yellow" bold>{"⚠ permission required"}</Text>
        <Text dimColor>{"  "}</Text>
        <Text color="yellow">{request.tool}</Text>
      </Box>
      <Text bold>{request.title}</Text>
      <Box flexDirection="column">
        <Text dimColor>{"args:"}</Text>
        <Text>{args}</Text>
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
    </Box>
  )
}
