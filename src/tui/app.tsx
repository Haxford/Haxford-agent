import { Box, Text, useApp, useInput } from "ink"
import React, { useCallback, useState, useSyncExternalStore } from "react"

import type { AgentEvent } from "../types/events.ts"
import type { PermissionRequest } from "../types/tool.ts"
import type { Message } from "../types/message.ts"
import { type ApprovalBridge, createApprovalBridge } from "./approval.ts"
import { Composer } from "./components/Composer.tsx"
import { PermissionDialog } from "./components/PermissionDialog.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { Transcript } from "./components/Transcript.tsx"
import { type TuiState, initialTuiState, reduce } from "./state.ts"

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
  /** Host-provided approval bridge; if omitted a fresh one is created. */
  bridge?: ApprovalBridge
}

/** Subscribe to a bridge's pending-request changes for useSyncExternalStore. */
function usePendingRequest(bridge: ApprovalBridge): PermissionRequest | undefined {
  return useSyncExternalStore(
    (listener) => bridge.subscribe(listener),
    () => bridge.pending(),
    () => undefined,
  )
}

export function App({ model, initial, onPrompt, notice, handle, bridge }: AppProps): React.ReactElement {
  const { exit } = useApp()
  const ownedBridge = useState(() => bridge ?? createApprovalBridge())[0]
  const [state, setState] = useState<TuiState>(initial ?? initialTuiState)
  const [flash, setFlash] = useState<string | undefined>(notice)

  const dispatch = useCallback((event: AgentEvent) => {
    setState((prev) => reduce(prev, event))
  }, [])

  // Hand the dispatch to the host once it is available.
  if (handle !== undefined) handle.dispatch = dispatch

  const pending = usePendingRequest(ownedBridge)

  // App-level keyboard: while a request is pending, a/l/d resolve the bridge
  // and the Composer is disabled. Other keys are ignored so the dialog is modal.
  useInput((_, key) => {
    if (pending === undefined) return
    if (key.escape) {
      ownedBridge.resolve("deny")
      return
    }
    const input = _.toLowerCase()
    if (input === "a") ownedBridge.resolve("allow")
    else if (input === "l") ownedBridge.resolve("always")
    else if (input === "d") ownedBridge.resolve("deny")
  })

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
  // Composer is disabled while the loop is running OR a permission dialog is modal.
  const composerDisabled = running || pending !== undefined

  return (
    <Box flexDirection="column" gap={1}>
      <Transcript messages={state.messages} />
      {pending !== undefined ? (
        <PermissionDialog request={pending} />
      ) : null}
      {flash !== undefined ? (
        <Box flexDirection="column">
          <Text dimColor>{"─"}</Text>
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
      <Composer disabled={composerDisabled} onSubmit={submit} />
    </Box>
  )
}

/** Re-export so hosts can construct their own bridge if they want to share it. */
export { createApprovalBridge }
export type { ApprovalBridge }
