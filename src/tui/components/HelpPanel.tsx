import { Box, Text } from "ink"
import React from "react"

import { theme } from "../theme.ts"

/** A command row for the help table. */
export interface CommandRow {
  command: string
  description: string
}

/** The canonical command table (exported so app.tsx and tests share it). */
export const COMMANDS: CommandRow[] = [
  { command: "/help", description: "show this help" },
  { command: "/model", description: "switch the active model" },
  { command: "/connect", description: "connect or re-key a provider" },
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

/** Two-column table with an accent section label and a set of rows. */
function Table({ title, rows }: { title: string; rows: CommandRow[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>{title}</Text>
      {rows.map((r) => (
        <Box key={r.command} gap={1}>
          {/* Fixed-width cell rather than padEnd: Yoga measures with
              string-width, so the column stays aligned for wide glyphs. */}
          <Box width={10} flexShrink={0}>
            <Text color={theme.accent} dimColor>{r.command}</Text>
          </Box>
          <Text dimColor>{r.description}</Text>
        </Box>
      ))}
    </Box>
  )
}

/**
 * Transient help listing. Rendered as plain indented content, not a modal
 * card — it is information in the flow, and a box around it made the TUI read
 * as a form.
 */
export function HelpPanel(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Table title="commands" rows={COMMANDS} />
      <Box marginTop={1}>
        <Table title="keys" rows={KEYBINDINGS} />
      </Box>
    </Box>
  )
}
