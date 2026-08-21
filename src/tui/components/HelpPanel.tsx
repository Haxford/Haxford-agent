import { Box, Text } from "ink"
import React from "react"

/** A command row for the help table. */
export interface CommandRow {
  command: string
  description: string
}

/** The canonical command table (exported so app.tsx and tests share it). */
export const COMMANDS: CommandRow[] = [
  { command: "/help", description: "show this help" },
  { command: "/model", description: "switch the active model" },
  { command: "/sessions", description: "resume a previous session" },
  { command: "/compact", description: "compact the conversation now" },
  { command: "/init", description: "analyze codebase and create/improve AGENTS.md" },
  { command: "/mode", description: "switch permission mode (build | auto | plan)" },
  { command: "/clear", description: "start a fresh session" },
  { command: "/exit", description: "quit haxford" },
]

/** Keybinding rows. */
export const KEYBINDINGS: CommandRow[] = [
  { command: "enter", description: "send the prompt or run a slash command" },
  { command: "esc", description: "abort the running turn; close a dialog or overlay" },
  { command: "tab", description: "cycle permission mode when the composer is empty" },
  { command: "↑ / ↓", description: "navigate prompt history or a picker list" },
  { command: "a / l / d", description: "allow once / always (session) / deny a permission request" },
  { command: "ctrl+c", description: "abort the run, then exit" },
]

/** Flatten rows into the legacy single-string HELP_TEXT for back-compat. */
export function rowsToText(commands: CommandRow[], keys: CommandRow[]): string {
  const cmdLines = commands.map((r) => `${r.command.padEnd(10)} ${r.description}`)
  const keyLines = keys.map((r) => `${r.command.padEnd(10)} ${r.description}`)
  return [...cmdLines, "", "keybindings:", ...keyLines].join("\n")
}

/** Backwards-compatible help text (tests assert against this). */
export const HELP_TEXT = rowsToText(COMMANDS, KEYBINDINGS)

/** Two-column table with a header and a set of rows. */
function Table({ title, rows }: { title: string; rows: CommandRow[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">{title}</Text>
      {rows.map((r) => (
        <Box key={r.command} gap={1}>
          <Text color="cyan">{r.command.padEnd(10)}</Text>
          <Text>{r.description}</Text>
        </Box>
      ))}
    </Box>
  )
}

export function HelpPanel(): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <Table title="commands" rows={COMMANDS} />
      <Table title="keys" rows={KEYBINDINGS} />
    </Box>
  )
}
