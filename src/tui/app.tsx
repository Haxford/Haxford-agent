import { Box, Static, Text, useInput } from "ink"
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { Message } from "../types/message.ts"
import type { SessionInfo } from "../types/session.ts"
import type { PermissionRequest } from "../types/tool.ts"
import type { ApprovalBridge } from "./approval.ts"
import { Banner, shortCwd } from "./components/Banner.tsx"
import { Composer, type ComposerHandle } from "./components/Composer.tsx"
import { HelpPanel, HELP_TEXT, COMMANDS, type CommandRow } from "./components/HelpPanel.tsx"
import { ModelPicker } from "./components/ModelPicker.tsx"
import { PermissionDialog } from "./components/PermissionDialog.tsx"
import { SessionPicker } from "./components/SessionPicker.tsx"
import { SlashAutocomplete } from "./components/SlashAutocomplete.tsx"
import { SpinnerProvider } from "./components/Spinner.tsx"
import { ActivityLine, StatusBar } from "./components/StatusBar.tsx"
import { MessageView, Transcript } from "./components/Transcript.tsx"
import { splitTranscript } from "./state.ts"
import { railProps, theme } from "./theme.ts"
import type { TuiStore } from "./store.ts"

/** Re-export HELP_TEXT (now sourced from HelpPanel) so tests import from app.tsx unchanged. */
export { HELP_TEXT }

/**
 * Canned instruction sent to the model by /init. Model-visible, so written
 * for the model to act on: analyze the codebase and produce/improve an
 * AGENTS.md covering the conventions a contributor needs. Kept short so it
 * does not dominate the system prompt.
 */
const INIT_PROMPT = `Analyze this codebase and create or improve AGENTS.md at the repository root.

AGENTS.md is the shared convention contract for contributors. It must cover:
- Build, lint, and test commands (the exact invocations a contributor runs).
- Code style: import style (type-only imports, file extensions, module path
  conventions), formatting, typing strictness, naming.
- A short architecture map: the main directories, what each owns, and how the
  pieces fit together at runtime.

If an AGENTS.md already exists, read it first and edit it in place to fill gaps
or fix inaccuracies rather than rewriting it wholesale — match its existing
  tone, structure, and heading style. Keep the whole file under ~40 lines: dense
  and useful, not exhaustive. Do not invent commands or conventions you cannot
  verify from the code.`

/** Cycle build -> auto -> plan -> build (for /mode with no arg). */
export function nextMode(mode: "build" | "auto" | "plan"): "build" | "auto" | "plan" {
  if (mode === "build") return "auto"
  if (mode === "auto") return "plan"
  return "build"
}

/**
 * Pure parse of a submitted slash command. Returns the action the app should
 * take, or { kind: "unknown" } for anything unrecognized. Extracted so the
 * command table is unit-testable without driving TextInput through a TTY.
 */
export type SlashAction =
  | { kind: "prompt"; text: string }
  | { kind: "exit" }
  | { kind: "newSession" }
  | { kind: "toggleHelp" }
  | { kind: "sessions" }
  | { kind: "model" }
  | { kind: "compact" }
  | { kind: "mode"; mode: "build" | "auto" | "plan" }
  | { kind: "notice"; message: string }
  | { kind: "unknown"; command: string }

/** Decode a submitted line into the action it represents. */
export function parseSlashCommand(
  value: string,
  mode: "build" | "auto" | "plan",
): SlashAction {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: "prompt", text: trimmed }
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed }

  const cmd = trimmed.toLowerCase()
  if (cmd === "/exit") return { kind: "exit" }
  if (cmd === "/clear") return { kind: "newSession" }
  if (cmd === "/help") return { kind: "toggleHelp" }
  if (cmd === "/sessions") return { kind: "sessions" }
  if (cmd === "/model") return { kind: "model" }
  if (cmd === "/compact") return { kind: "compact" }
  if (cmd === "/init") return { kind: "prompt", text: INIT_PROMPT }
  if (cmd === "/mode") return { kind: "mode", mode: nextMode(mode) }
  if (cmd.startsWith("/mode ")) {
    const arg = cmd.slice("/mode ".length).trim()
    if (arg === "build" || arg === "auto" || arg === "plan") return { kind: "mode", mode: arg }
    return { kind: "notice", message: `unknown mode ${JSON.stringify(arg)}; valid: build | auto | plan` }
  }
  return { kind: "unknown", command: trimmed }
}

/** Commands that take no argument and can be submitted immediately on accept. */
export const NO_ARG_COMMANDS = new Set(["/help", "/sessions", "/compact", "/clear", "/exit"])

/** Whether a command token accepts an argument (so autocomplete only completes the token). */
export function takesArg(command: string): boolean {
  return !NO_ARG_COMMANDS.has(command)
}

/** True when the typed value exactly equals the single matched command. */
export function isExactCommandMatch(matches: CommandRow[], value: string): boolean {
  return matches.length === 1 && matches[0]!.command === value.trim().toLowerCase()
}

/** Match commands by case-insensitive prefix; returns the canonical rows. */
export function matchCommands(prefix: string): CommandRow[] {
  const p = prefix.trim().toLowerCase()
  if (p.length === 0 || !p.startsWith("/")) return []
  return COMMANDS.filter((c) => c.command.startsWith(p) || c.command.toLowerCase().startsWith(p))
}

/**
 * Label for the activity line while a run is in flight: the tool currently
 * executing, else a generic verb. Naming the tool is what turns a bare spinner
 * into something you can read at a glance.
 */
export function activityVerb(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type === "tool" && part.state.status === "running") return part.tool
    }
  }
  return "thinking"
}

/** The next command after moving the cursor with clamping (wraps within 0..n-1). */
export function clampCursor(cursor: number, n: number): number {
  if (n <= 0) return 0
  if (cursor < 0) return n - 1
  if (cursor >= n) return 0
  return cursor
}

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
  /** Known provider/model specs for the /model picker (string[] or rich entries). */
  models: string[] | import("./components/ModelPicker.tsx").ModelOption[]
  /** Working directory, shown in the banner and status bar. Optional so unwired hosts still typecheck. */
  cwd?: string
  /**
   * Current session id. Accepted for host compatibility but deliberately not
   * displayed: none of pi, opencode, or Claude Code surfaces a raw session id,
   * and it competed for space with the numbers that matter.
   */
  sessionID?: string
  /** Context window limit for the active model, for the ctx% indicator. Optional. */
  contextLimit?: number
  /** User submitted a prompt. The HOST creates+persists+emits the user Message and runs the loop. */
  onPrompt(text: string): void
  /** Esc pressed while running. Host owns the AbortController; app just signals. */
  onAbort(): void
  /** Host selected a new model spec via /model picker. */
  onModelChange(spec: string): void
  /** /compact — host runs manual compaction over session history. Optional so a host that has not wired it yet still typechecks; defaults to a no-op that dispatches a notice. */
  onCompact?(): void
  /** /mode — host switches the permission mode (host owns rerender). */
  onModeChange(mode: "build" | "auto" | "plan"): void
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
    cwd,
    contextLimit,
    onPrompt,
    onAbort,
    onModelChange,
    onCompact,
    onModeChange,
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

  // Slash autocomplete: tracks the live composer value, matching commands, and
  // the selected match index. Active only when the value starts with '/'.
  const [composerValue, setComposerValue] = useState("")
  const acMatches = useMemo(
    () => (composerValue.startsWith("/") ? matchCommands(composerValue) : []),
    [composerValue],
  )
  const [acCursor, setAcCursor] = useState(0)
  // Imperative handle into the composer so completions/clears reach the real
  // (uncontrolled) TextInput instead of only the matching state.
  const composerRef = useRef<ComposerHandle | undefined>(undefined)
  // Exact single match (user typed a full command) => popup yields Enter back
  // to normal submission; otherwise typing "/e" + enter would instantly exit.
  const acActive = acMatches.length > 0 && !isExactCommandMatch(acMatches, composerValue)

  // Reset the popup cursor when the typed value changes.
  useEffect(() => { setAcCursor(0) }, [composerValue])

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

  const running = state.status === "running"

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
      return
    }
    // Tab in the empty-ish, idle, overlay-free composer cycles the permission
    // mode build -> auto -> plan -> build (opencode-style). The host owns the
    // actual mode state and rerenders. Skip when the autocomplete popup is up
    // (the Composer routes tab to the popup instead).
    if (key.tab && !running && composerValue.trim().length === 0 && !acActive && ui.showSessions.kind === "idle" && !ui.showHelp && !ui.showModelPicker) {
      onModeChange(nextMode(mode))
    }
  })

  const resetOverlays = useCallback(
    () => setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false })),
    [],
  )

  const submit = useCallback(
    (value: string) => {
      // Ignore submissions while a permission dialog is modal.
      if (pending !== undefined) return
      const action = parseSlashCommand(value, mode)
      switch (action.kind) {
        case "prompt":
          if (action.text.length === 0) return
          // Non-slash prompt (or /init): the HOST owns creating/persisting the
          // user message and running the loop.
          onPrompt(action.text)
          resetOverlays()
          return
        case "exit":
          onExit()
          return
        case "newSession":
          onNewSession()
          resetOverlays()
          return
        case "toggleHelp":
          setUi((u) => ({ ...u, showHelp: !u.showHelp, showSessions: { kind: "idle" }, showModelPicker: false }))
          return
        case "sessions":
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "loading" }, showModelPicker: false }))
          return
        case "model":
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: true }))
          return
        case "compact":
          // Host owns compaction; it dispatches a notice when done. Fall back to
          // a no-op notice so the command is safe even before the host wires it.
          const compact = onCompact ?? (() => {
            store.dispatch({ type: "notice", message: "compaction not wired in this host" })
          })
          compact()
          resetOverlays()
          return
        case "mode":
          onModeChange(action.mode)
          resetOverlays()
          return
        case "notice":
          store.dispatch({ type: "notice", message: action.message })
          resetOverlays()
          return
        case "unknown":
          setUi((u) => ({ ...u, showHelp: true, showSessions: { kind: "idle" }, showModelPicker: false }))
          store.dispatch({ type: "notice", message: `unknown command: ${action.command}` })
          return
      }
    },
    [mode, onAbort, onCompact, onExit, onModeChange, onNewSession, onPrompt, pending, resetOverlays, state.status, store],
  )

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

  // --- Slash autocomplete handlers ---
  const onPopupNavigate = useCallback((dir: "up" | "down") => {
    setAcCursor((c) => clampCursor(dir === "up" ? c - 1 : c + 1, acMatches.length))
  }, [acMatches.length])

  const onPopupDismiss = useCallback(() => {
    // Clearing the leading slash is the natural way to dismiss; the Composer
    // already routed Esc here, so reset the cursor and let the value stand.
    setAcCursor(0)
  }, [])

  const onPopupAccept = useCallback(() => {
    const row = acMatches[acCursor] ?? acMatches[0]
    if (row === undefined) return
    // Always complete into the real input; no-arg commands then submit with
    // a natural Enter (never auto-run from a partial prefix like "/e").
    const completed = takesArg(row.command) ? `${row.command} ` : row.command
    composerRef.current?.set(completed)
    setComposerValue(completed)
  }, [acCursor, acMatches])

  // The composer's rail colour carries the mode now, so the placeholder no
  // longer has to spell it out — except in plan mode, where the read-only
  // constraint is worth stating.
  const composerPlaceholder = composerDisabled
    ? pending !== undefined
      ? "awaiting approval…"
      : "agent running…"
    : mode === "plan"
      ? "plan mode — read-only research; edits require approval"
      : "ask anything, or / for commands"

  // Ink's <Static> prints settled messages once and never re-renders them, so
  // streaming costs one message's worth of diffing instead of the whole
  // transcript's. Only the tail stays live. See splitTranscript for why the
  // prefix is safe to freeze, and why the epoch key is needed on reset.
  const { finalized, live } = useMemo(
    () => splitTranscript(state.messages),
    [state.messages],
  )

  // Epoch millis of the current run, for the activity line's clock. Recomputed
  // only on an idle -> running edge.
  const [runStartedAt, setRunStartedAt] = useState(() => Date.now())
  useEffect(() => {
    if (running) setRunStartedAt(Date.now())
  }, [running])

  const showBanner =
    state.messages.length === 0 && state.notices.length === 0 && pending === undefined
  const overlay =
    ui.showHelp || ui.showModelPicker || ui.showSessions.kind !== "idle" || pending !== undefined

  return (
    <SpinnerProvider active={running}>
      {/*
        Layout, top to bottom: settled transcript (Static) -> live tail ->
        overlays -> activity line -> composer -> status bar. The status bar sits
        *below* the composer, which is where pi, opencode, and Claude Code all
        put it. The root has no uniform `gap`: spacing is applied per section so
        it carries grouping information instead of flattening everything.

        <Static> writes above Ink's managed region regardless of JSX position,
        so everything after it must be the only live content — which this
        ordering already guarantees.
      */}
      <Static key={state.epoch} items={finalized}>
        {(m) => (
          <Box key={m.id} flexDirection="column" marginTop={1}>
            <MessageView message={m} />
          </Box>
        )}
      </Static>

      <Box flexDirection="column">
        {showBanner ? (
          <Banner model={model} cwd={cwd ?? shortCwd(".")} contextLimit={contextLimit} />
        ) : null}

        {live.length > 0 || state.notices.length > 0 ? (
          <Box marginTop={finalized.length > 0 ? 1 : 0}>
            <Transcript messages={live} notices={state.notices} />
          </Box>
        ) : null}

        {pending !== undefined ? (
          <Box marginTop={1}>
            <PermissionDialog request={pending} />
          </Box>
        ) : null}

        {ui.showHelp ? (
          <Box marginTop={1}>
            <HelpPanel />
          </Box>
        ) : null}

        {ui.showSessions.kind === "loading" ? (
          <Box marginTop={1} {...railProps()} paddingLeft={1}>
            <Text dimColor>{"loading sessions…"}</Text>
          </Box>
        ) : null}

        {ui.showSessions.kind === "ready" ? (
          <Box marginTop={1}>
            <SessionPicker
              sessions={ui.showSessions.sessions}
              onSelect={selectSession}
              onCancel={closeSessions}
            />
          </Box>
        ) : null}

        {ui.showSessions.kind === "error" ? (
          <Box flexDirection="column" marginTop={1} {...railProps(theme.error, false)} paddingLeft={1}>
            <Text color={theme.error}>{"failed to list sessions"}</Text>
            <Text dimColor>{ui.showSessions.message}</Text>
            <Text dimColor>{"esc to close"}</Text>
          </Box>
        ) : null}

        {ui.showModelPicker ? (
          <Box marginTop={1}>
            <ModelPicker
              models={models}
              current={model}
              onSelect={selectModel}
              onCancel={closeModelPicker}
            />
          </Box>
        ) : null}

        {/* Transient while a run is in flight: verb, elapsed, tokens, the way out. */}
        {running ? (
          <Box marginTop={1}>
            <ActivityLine
              verb={activityVerb(state.messages)}
              startedAt={runStartedAt}
              usage={state.usage}
            />
          </Box>
        ) : null}

        <Box marginTop={running || overlay || live.length > 0 || showBanner ? 1 : 0}>
          <Composer
            disabled={composerDisabled}
            mode={mode}
            onSubmit={submit}
            onValueChange={setComposerValue}
            handleRef={composerRef}
            placeholder={composerPlaceholder}
            popupActive={acActive}
            onPopupNavigate={onPopupNavigate}
            onPopupAccept={onPopupAccept}
            onPopupDismiss={onPopupDismiss}
            autocomplete={<SlashAutocomplete matches={acMatches} cursor={acCursor} />}
          />
        </Box>

        <StatusBar
          model={model}
          mode={mode}
          status={state.status}
          usage={state.usage}
          contextLimit={contextLimit}
          cwd={cwd !== undefined ? shortCwd(cwd) : undefined}
          error={state.error}
          endReason={state.endReason}
        />
      </Box>
    </SpinnerProvider>
  )
}

// Re-export shared types so hosts can import everything from app.tsx if desired.
export type { ApprovalBridge, TuiStore }
