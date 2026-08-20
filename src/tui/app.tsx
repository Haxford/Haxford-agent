import { Box, Text, useInput } from "ink"
import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import type { SessionInfo } from "../types/session.ts"
import type { PermissionRequest } from "../types/tool.ts"
import type { ApprovalBridge } from "./approval.ts"
import { Composer } from "./components/Composer.tsx"
import { ModelPicker } from "./components/ModelPicker.tsx"
import { PermissionDialog } from "./components/PermissionDialog.tsx"
import { SessionPicker } from "./components/SessionPicker.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { Transcript } from "./components/Transcript.tsx"
import type { TuiStore } from "./store.ts"

const HELP_TEXT = [
  "/exit       quit haxford",
  "/clear      start a fresh session",
  "/sessions   resume a previous session",
  "/model      switch the active model",
  "/help       show this help",
  "",
  "type a prompt and press Enter to send to the model.",
  "press Esc while running to abort the current turn.",
].join("\n")

/** A pending async load: either loading, ready, or errored. */
type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; sessions: SessionInfo[] }
  | { kind: "error"; message: string }

export interface HaxfordAppProps {
  store: TuiStore
  bridge: ApprovalBridge
  model: string
  mode: "build" | "auto" | "plan"
  /** Known provider/model specs for the /model picker. */
  models: string[]
  /** User submitted a prompt. The HOST creates+persists+emits the user Message and runs the loop. */
  onPrompt(text: string): void
  /** Esc pressed while running. Host owns the AbortController; app just signals. */
  onAbort(): void
  /** Host selected a new model spec via /model picker. */
  onModelChange(spec: string): void
  /** /exit or ctrl+c on empty composer */
  onExit(): void
  /** /clear — host starts a fresh session and calls store.reset([]) */
  onNewSession(): void
  /** For /sessions: host lists sessions; on resume host loads history and calls store.reset(history) */
  listSessions(): Promise<SessionInfo[]>
  /** Called when the user picks a session to resume. */
  onResumeSession(id: string): void
}

/** Subscribe to the store for useSyncExternalStore. */
function useTuiState(store: TuiStore) {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
}

/** Subscribe to a bridge's pending-request changes. */
function usePendingRequest(bridge: ApprovalBridge): PermissionRequest | undefined {
  return useSyncExternalStore(
    (listener) => bridge.subscribe(listener),
    () => bridge.pending(),
    () => undefined,
  )
}

/** Local UI state not owned by the agent reducer (slash help, pickers). */
interface UiFlags {
  showHelp: boolean
  showSessions: LoadState
  showModelPicker: boolean
}

export function HaxfordApp(props: HaxfordAppProps): React.ReactElement {
  const {
    store,
    bridge,
    model,
    mode,
    models,
    onPrompt,
    onAbort,
    onModelChange,
    onExit,
    onNewSession,
    listSessions,
    onResumeSession,
  } = props
  const state = useTuiState(store)
  const pending = usePendingRequest(bridge)

  const [ui, setUi] = useState<UiFlags>({
    showHelp: false,
    showSessions: { kind: "idle" },
    showModelPicker: false,
  })

  // While the sessions picker is open, load sessions lazily once.
  useEffect(() => {
    if (ui.showSessions.kind !== "loading") return
    let cancelled = false
    void listSessions()
      .then((sessions) => {
        if (cancelled) return
        setUi((u) => ({ ...u, showSessions: { kind: "ready", sessions } }))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setUi((u) => ({ ...u, showSessions: { kind: "error", message } }))
      })
    return () => { cancelled = true }
  }, [ui.showSessions.kind, listSessions])

  // App-level keyboard. Order of precedence: permission dialog (modal) >
  // abort (Esc while running) > overlays > rest.
  useInput((input, key) => {
    // While a permission request is pending, the dialog is modal.
    if (pending !== undefined) {
      if (key.escape) {
        bridge.resolve("deny")
        return
      }
      const c = input.toLowerCase()
      if (c === "a") bridge.resolve("allow")
      else if (c === "l") bridge.resolve("always")
      else if (c === "d") bridge.resolve("deny")
      return
    }
    // Esc while the loop is running signals abort (host owns AbortController).
    // Read live status from the store to avoid any closure staleness.
    if (key.escape && store.getState().status === "running") {
      onAbort()
      return
    }
    // Escape closes any open overlay (help / sessions picker / model picker).
    if (key.escape && (ui.showHelp || ui.showSessions.kind !== "idle" || ui.showModelPicker)) {
      setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false }))
    }
  })

  const submit = useCallback(
    (value: string) => {
      // Ignore submissions while a permission dialog is modal.
      if (pending !== undefined) return
      const trimmed = value.trim()
      if (trimmed.length === 0) return

      if (trimmed.startsWith("/")) {
        const cmd = trimmed.toLowerCase()
        if (cmd === "/exit") {
          onExit()
          return
        }
        if (cmd === "/clear") {
          onNewSession()
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false }))
          return
        }
        if (cmd === "/help") {
          setUi((u) => ({ ...u, showHelp: !u.showHelp, showSessions: { kind: "idle" }, showModelPicker: false }))
          return
        }
        if (cmd === "/sessions") {
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "loading" }, showModelPicker: false }))
          return
        }
        if (cmd === "/model") {
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: true }))
          return
        }
        // Unknown command -> show help with a hint about the unknown command.
        setUi((u) => ({ ...u, showHelp: true, showSessions: { kind: "idle" }, showModelPicker: false }))
        store.dispatch({ type: "notice", message: `unknown command: ${trimmed}` })
        return
      }

      // Non-slash prompt: the HOST owns creating/persisting the user message.
      onPrompt(trimmed)
      setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false }))
    },
    [onAbort, onExit, onNewSession, onPrompt, pending, state.status, store],
  )

  const running = state.status === "running"
  const composerDisabled =
    running ||
    pending !== undefined ||
    ui.showSessions.kind !== "idle" ||
    ui.showModelPicker

  const closeSessions = useCallback(() => {
    setUi((u) => ({ ...u, showSessions: { kind: "idle" } }))
  }, [])

  const selectSession = useCallback(
    (id: string) => {
      setUi((u) => ({ ...u, showSessions: { kind: "idle" } }))
      onResumeSession(id)
    },
    [onResumeSession],
  )

  const closeModelPicker = useCallback(() => {
    setUi((u) => ({ ...u, showModelPicker: false }))
  }, [])

  const selectModel = useCallback(
    (spec: string) => {
      setUi((u) => ({ ...u, showModelPicker: false }))
      onModelChange(spec)
    },
    [onModelChange],
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Transcript messages={state.messages} notices={state.notices} />

      {pending !== undefined ? <PermissionDialog request={pending} /> : null}

      {ui.showHelp ? (
        <Box flexDirection="column">
          <Text dimColor>{"─"}</Text>
          <Text>{HELP_TEXT}</Text>
        </Box>
      ) : null}

      {ui.showSessions.kind === "loading" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text color="cyan">{"loading sessions…"}</Text>
        </Box>
      ) : null}

      {ui.showSessions.kind === "ready" ? (
        <SessionPicker
          sessions={ui.showSessions.sessions}
          onSelect={selectSession}
          onCancel={closeSessions}
        />
      ) : null}

      {ui.showSessions.kind === "error" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={2} paddingY={1}>
          <Text color="red">{"failed to list sessions"}</Text>
          <Text dimColor>{ui.showSessions.message}</Text>
          <Text dimColor>{"press Esc to close"}</Text>
        </Box>
      ) : null}

      {ui.showModelPicker ? (
        <ModelPicker
          models={models}
          current={model}
          onSelect={selectModel}
          onCancel={closeModelPicker}
        />
      ) : null}

      <StatusBar
        model={`${model} [${mode}]`}
        status={state.status}
        turn={state.turn}
        usage={state.usage}
        error={state.error}
        endReason={state.endReason}
      />
      <Composer disabled={composerDisabled} onSubmit={submit} />
    </Box>
  )
}

// Re-export shared types so hosts can import everything from app.tsx if desired.
export type { ApprovalBridge, TuiStore }
