import { Box, Text, useApp } from "ink"
import type React from "react"
import { useCallback, useState } from "react"

import type { AgentEvent } from "../types/events.ts"
import type { Message } from "../types/message.ts"
import { type TuiState, initialTuiState, reduce } from "./state.ts"
import { Composer } from "./components/Composer.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { Transcript } from "./components/Transcript.tsx"

/** Result of handling a slash command. */
interface SlashResult {
  notice?: string
  exit?: boolean
  clear?: boolean
}

const HELP_TEXT = [
  "/exit   quit haxford",
  "/clear  clear the transcript",
  "/help   show this help",
  "",
  "type a prompt and press Enter to send to the model.",
].join("\n")

function handleSlash(command: string): SlashResult {
  const trimmed = command.trim()
  if (trimmed === "/exit") return { exit: true }
  if (trimmed === "/clear") return { clear: true }
  if (trimmed === "/help") return { notice: HELP_TEXT }
  return { notice: `unknown command: ${trimmed}\n${HELP_TEXT}` }
}

/**
 * Mutable handle a host uses to push AgentEvents into the running App without
 * prop-drilling through React renders. The App assigns `dispatch` on mount.
 */
export interface DispatchHandle {
  dispatch: (event: AgentEvent) => void
}

export interface AppProps {
  model: string
  initial?: TuiState
  /** Host callback when the user submits a non-slash prompt. */
  onPrompt?: (value: string) => void
  /** Optional inline notice shown above the status bar on startup. */
  notice?: string
  /** Host-provided handle; receives the dispatch function on mount. */
  handle?: DispatchHandle
}

export function App({ model, initial, onPrompt, notice, handle }: AppProps): React.ReactElement {
  const { exit } = useApp()
  const [state, setState] = useState<TuiState>(initial ?? initialTuiState)
  const [flash, setFlash] = useState<string | undefined>(notice)

  const dispatch = useCallback((event: AgentEvent) => {
    setState((prev) => reduce(prev, event))
  }, [])

  // Hand the dispatch to the host once it is available.
  if (handle !== undefined) handle.dispatch = dispatch

  const submit = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        const result = handleSlash(value)
        if (result.exit) {
          exit()
          return
        }
        if (result.clear) {
          setState((prev) => ({ ...prev, messages: [], error: undefined, endReason: undefined }))
          setFlash(undefined)
          return
        }
        if (result.notice !== undefined) setFlash(result.notice)
        return
      }
      const id = crypto.randomUUID()
      const now = Date.now()
      const message: Message = {
        id,
        sessionID: "tui",
        role: "user",
        parts: [{ id: `${id}-p`, type: "text", text: value }],
        time: { created: now },
      }
      dispatch({ type: "message.updated", message })
      setFlash(undefined)
      onPrompt?.(value)
    },
    [dispatch, exit, onPrompt],
  )

  const running = state.status === "running"

  return (
    <Box flexDirection="column" gap={1}>
      <Transcript messages={state.messages} />
      {flash !== undefined ? (
        <Box flexDirection="column">
          <Text dimColor>─</Text>
          <Text>{flash}</Text>
        </Box>
      ) : null}
      <StatusBar
        model={model}
        status={state.status}
        turn={state.turn}
        usage={state.usage}
        error={state.error}
      />
      <Composer disabled={running} onSubmit={submit} />
    </Box>
  )
}
