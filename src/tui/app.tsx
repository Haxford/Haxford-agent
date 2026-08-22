import { Box, Static, Text, useInput, useStdout } from "ink"
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { Message } from "../types/message.ts"
import type { SessionInfo } from "../types/session.ts"
import type { PermissionRequest } from "../types/tool.ts"
import type { ApprovalBridge } from "./approval.ts"
import { Banner, BANNER_HEIGHT } from "./components/Banner.tsx"
import { Breadcrumb } from "./components/Breadcrumb.tsx"
import { Composer, type ComposerHandle } from "./components/Composer.tsx"
import { ConnectDialog } from "./components/ConnectDialog.tsx"
import { HelpPanel, HELP_TEXT, COMMANDS, type CommandRow } from "./components/HelpPanel.tsx"
import { ModelPicker, normalizeModels, type ModelOption, type ProviderCatalogEntry } from "./components/ModelPicker.tsx"
import { PermissionDialog } from "./components/PermissionDialog.tsx"
import { SessionPicker } from "./components/SessionPicker.tsx"
import { SlashAutocomplete } from "./components/SlashAutocomplete.tsx"
import { SpinnerProvider } from "./components/Spinner.tsx"
import { ActivityLine, StatusBar, TurnOutcome } from "./components/StatusBar.tsx"
import { MessageView, Transcript } from "./components/Transcript.tsx"
import { useTerminalSize } from "./hooks.ts"
import {
  BREADCRUMB_LINES,
  FOOTER_LINES,
  bottomPadding,
  composerHeight,
  estimateTranscriptLines,
} from "./layout.ts"
import { synchronizedStdout } from "./raw.ts"
import { splitTranscript } from "./state.ts"
import { railProps, theme } from "./theme.ts"
import type { TuiStore } from "./store.ts"

/** Re-export HELP_TEXT (now sourced from HelpPanel) so tests import from app.tsx unchanged. */
export { HELP_TEXT }

/**
 * Ink render options the host MUST pass for the two-press ctrl+c flow to work.
 *
 * Ink's default `exitOnCtrlC: true` swallows ctrl+c inside its own stdin
 * handler and never forwards it to `useInput` (see ink's use-input.js: "If app
 * is supposed to exit on Ctrl+C, skip input listeners"). With the default the
 * first press hard-unmounts the app, so the confirm-before-quit window below
 * can never arm. Hosts render with:
 *
 *   render(element, INK_RENDER_OPTIONS)
 *
 * It also carries a synchronized-output view of stdout. Ink offers no hook
 * around its own writes and it throttles when they happen, so the only safe
 * place to bracket a frame is the stream it writes to — see `raw.ts`. Passing
 * these options is therefore what makes the live region redraw atomically
 * instead of visibly erasing and repainting at streaming rates.
 */
export const INK_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  stdout: synchronizedStdout(process.stdout),
} as const

/**
 * A `StaticItem` is either the once-printed banner or a settled message.
 *
 * Ink's `<Static>` writes each item exactly once and never revisits it, which
 * is precisely the lifetime the banner wants: printed at session start, then
 * scrollback like any other output. Modelling it as the first item of the same
 * region — rather than a conditional in the live tree — is what makes "once"
 * structural instead of a rule someone has to remember.
 */
type StaticItem =
  | { kind: "banner"; id: string }
  | { kind: "message"; id: string; message: Message }

/** How long a transient status hint stays on screen (ms). */
export const HINT_MS = 2000

/**
 * How long to wait for a resume to land before reporting it as swallowed.
 * `onResumeSession` is async in every real host (read meta, replay JSONL),
 * so the check has to be generous enough not to false-positive on disk I/O.
 */
export const RESUME_TIMEOUT_MS = 1500

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
  | { kind: "reload" }
  | { kind: "mode"; mode: "build" | "auto" | "plan" }
  | { kind: "connect" }
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
  if (cmd === "/reload") return { kind: "reload" }
  if (cmd === "/init") return { kind: "prompt", text: INIT_PROMPT }
  if (cmd === "/connect") return { kind: "connect" }
  if (cmd === "/mode") return { kind: "mode", mode: nextMode(mode) }
  if (cmd.startsWith("/mode ")) {
    const arg = cmd.slice("/mode ".length).trim()
    if (arg === "build" || arg === "auto" || arg === "plan") return { kind: "mode", mode: arg }
    return { kind: "notice", message: `unknown mode ${JSON.stringify(arg)}; valid: build | auto | plan` }
  }
  return { kind: "unknown", command: trimmed }
}

/** Commands that take no argument and can be submitted immediately on accept. */
export const NO_ARG_COMMANDS = new Set(["/help", "/sessions", "/compact", "/reload", "/clear", "/exit", "/connect"])

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

/**
 * Pricing for the active model, looked up in the `models` prop by exact spec.
 *
 * Only an exact spec match counts. Prices differ across a provider's lineup and
 * across providers reselling the same weights, so a fuzzy match would quietly
 * bill the session at some other model's rate. No match => no pricing => the
 * status bar shows no cost at all, which is the honest outcome.
 */
export function pricingForSpec(
  models: string[] | ModelOption[],
  spec: string,
): { promptPricePerMtok?: number; completionPricePerMtok?: number } {
  const entry = normalizeModels(models).find((m) => m.spec === spec)
  if (entry === undefined) return {}
  return {
    ...(entry.promptPricePerMtok !== undefined ? { promptPricePerMtok: entry.promptPricePerMtok } : {}),
    ...(entry.completionPricePerMtok !== undefined ? { completionPricePerMtok: entry.completionPricePerMtok } : {}),
  }
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
  models: string[] | ModelOption[]
  /** Known providers with their connection status, driving the /connect flow and the model picker's level-1. */
  providerCatalog?: ProviderCatalogEntry[]
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
  /**
   * /connect — host persists a new provider credential (the dialog renders UI
   * only). Optional so unwired hosts keep `/connect` harmless: it dispatches a
   * "not wired in this host" notice instead of crashing.
   */
  onConnectProvider?: (provider: string, apiKey: string, baseURL?: string) => void
  /**
   * Verifies a provider key with a live authenticated request before the
   * dialog accepts it. Optional so unwired hosts keep /connect harmless: the
   * dialog saves without verifying. Returns ok or an error string the dialog
   * surfaces inline, letting the user re-edit.
   */
  verifyProviderKey?: (
    provider: string,
    apiKey: string,
    baseURL?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * Called when the user selects the "+ connect a provider…" row in the
   * /model picker's level-1. Alias for opening the connect flow; the host
   * owns what actually happens (usually: open the same /connect dialog).
   */
  onProviderConnect?: (provider: string) => void
  /** /compact — host runs manual compaction over session history. Optional so a host that has not wired it yet still typechecks; defaults to a no-op that dispatches a notice. */
  onCompact?(): void
  /**
   * /reload — host rescans skills, extensions and themes. Optional so an
   * unwired host keeps `/reload` harmless: it dispatches a "not wired in this
   * host" notice instead of crashing.
   */
  onReload?(): void
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
  showConnect: boolean
}

export function HaxfordApp(props: HaxfordAppProps): React.ReactElement {
  const {
    store,
    bridge,
    model,
    mode,
    models,
    providerCatalog,
    cwd,
    contextLimit,
    onPrompt,
    onAbort,
    onModelChange,
    onConnectProvider,
    verifyProviderKey,
    onProviderConnect,
    onCompact,
    onReload,
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
    showConnect: false,
  })

  // A transient one-line status hint rendered just above the composer, then
  // expired. This is the surface for feedback that is *about the UI* rather
  // than about the conversation — a mode switch, a ctrl+c confirmation. Such
  // feedback must never be dispatched as a `notice`: notices live in the
  // transcript, so they wedge themselves permanently above the next agent
  // reply and read as something the agent said.
  const [hint, setHint] = useState<string | undefined>(undefined)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showHint = useCallback((message: string, ms: number = HINT_MS) => {
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
    setHint(message)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = undefined
      setHint(undefined)
    }, ms)
  }, [])
  const clearHint = useCallback(() => {
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
    hintTimer.current = undefined
    setHint(undefined)
  }, [])
  useEffect(() => () => {
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
  }, [])

  // Armed by the first ctrl+c on an idle composer; a second press inside the
  // hint window exits. A ref (not state) so the input handler reads the live
  // value regardless of render timing.
  const exitArmed = useRef(false)

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

  /**
   * The single entry point for a mode switch (/mode and Tab both land here).
   *
   * Feedback is a transient hint, never a `notice`. A notice is transcript
   * content: it survives the switch, sits above whatever the agent says next,
   * and reads as part of the conversation. Mode is chrome, so it belongs on
   * the chrome surface and expires on its own.
   */
  const changeMode = useCallback(
    (next: "build" | "auto" | "plan") => {
      onModeChange(next)
      showHint(`mode ${next}`)
    },
    [onModeChange, showHint],
  )

  // App-level keyboard. Order of precedence: permission dialog (modal) >
  // abort (Esc while running) > overlays > rest.
  useInput((input, key) => {
    // ctrl+c outranks everything, including the modal permission dialog: it is
    // the one key that must always mean "get me out of here".
    //
    //   running -> interrupt the run (unchanged behaviour, one press)
    //   idle    -> first press arms + hints, a second inside the window exits
    //
    // Requires the host to render with INK_RENDER_OPTIONS; under ink's default
    // `exitOnCtrlC` this handler is never reached.
    if (key.ctrl && input === "c") {
      if (store.getState().status === "running") {
        onAbort()
        return
      }
      if (exitArmed.current) {
        exitArmed.current = false
        clearHint()
        onExit()
        return
      }
      exitArmed.current = true
      showHint("press ctrl+c again to exit")
      // Disarm with the hint so the window and the prompt expire together —
      // a hint the user can no longer see must not still be live.
      setTimeout(() => { exitArmed.current = false }, HINT_MS)
      return
    }
    // Any other key cancels a pending exit confirmation: ctrl+c then "y" must
    // not leave a live quit armed behind an invisible prompt.
    if (exitArmed.current) {
      exitArmed.current = false
      clearHint()
    }
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
    // The /connect dialog is modal while open — it owns its own keystrokes.
    if (ui.showConnect) return
    // Esc while the loop is running signals abort (host owns AbortController).
    // Read live status from the store to avoid any closure staleness.
    if (key.escape && store.getState().status === "running") {
      onAbort()
      return
    }
    // Escape closes any open overlay (help / sessions picker / model picker).
    if (key.escape && (ui.showHelp || ui.showSessions.kind !== "idle" || ui.showModelPicker)) {
      setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false, showConnect: false }))
      return
    }
    // Tab in the empty-ish, idle, overlay-free composer cycles the permission
    // mode build -> auto -> plan -> build (opencode-style). The host owns the
    // actual mode state and rerenders. Skip when the autocomplete popup is up
    // (the Composer routes tab to the popup instead).
    // ctrl+o expands or collapses tool output across the whole transcript —
    // pi's binding and pi's model. One global switch rather than a per-row
    // cursor: tool calls are scanned, not navigated, so the useful states are
    // "the tight list" and "all of it", not "this one row".
    if (key.ctrl && input === "o") {
      const next = store.setToolsExpanded(!store.getState().toolsExpanded)
      showHint(next ? "tool output expanded" : "tool output collapsed")
      // @inkjs/ui's TextInput filters exactly one chord out of its own input
      // handler — ctrl+c — and inserts everything else as a character, so a
      // bare ctrl+o would leave a stray "o" in the composer. Reseeding with
      // the value the composer already had remounts the input and drops it.
      composerRef.current?.set(composerValue)
      return
    }
    if (key.tab && !running && composerValue.trim().length === 0 && !acActive && ui.showSessions.kind === "idle" && !ui.showHelp && !ui.showModelPicker && !ui.showConnect) {
      changeMode(nextMode(mode))
    }
  })


  const resetOverlays = useCallback(
    () => setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false, showConnect: false })),
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
        case "reload":
          // Host owns the rescan; it shows a transient hint when done. Fall
          // back to a no-op notice so the command is safe even before the
          // host wires it.
          const reload = onReload ?? (() => {
            store.dispatch({ type: "notice", message: "reload not wired in this host" })
          })
          reload()
          resetOverlays()
          return
        case "mode":
          // Transient hint only — see changeMode. Nothing reaches the transcript.
          changeMode(action.mode)
          resetOverlays()
          return
        case "connect":
          // Without a host hook the command is harmless: it reports that the
          // connect flow is not wired, so the user knows why nothing opened.
          if (onConnectProvider === undefined && providerCatalog === undefined) {
            store.dispatch({ type: "notice", message: "connect not wired in this host" })
            resetOverlays()
            return
          }
          setUi((u) => ({ ...u, showHelp: false, showSessions: { kind: "idle" }, showModelPicker: false, showConnect: true }))
          return
        case "notice":
          // The sole producer is an invalid `/mode <arg>`. That is feedback on
          // a chrome command, so it expires with the other mode hints instead
          // of parking itself in the transcript. Given twice the usual window:
          // it names the valid modes, and that is worth reading.
          showHint(action.message, HINT_MS * 2)
          resetOverlays()
          return
        case "unknown":
          setUi((u) => ({ ...u, showHelp: true, showSessions: { kind: "idle" }, showModelPicker: false }))
          store.dispatch({ type: "notice", message: `unknown command: ${action.command}` })
          return
      }
    },
    [changeMode, mode, onAbort, onCompact, onConnectProvider, onExit, onNewSession, onPrompt, onReload, pending, providerCatalog, resetOverlays, showHint, store],
  )

  const composerDisabled =
    running ||
    pending !== undefined ||
    ui.showSessions.kind !== "idle" ||
    ui.showModelPicker ||
    ui.showConnect

  const closeSessions = useCallback(() => {
    setUi((u) => ({ ...u, showSessions: { kind: "idle" } }))
  }, [])

  /**
   * Resume a session, and refuse to do it silently.
   *
   * Hosts guard `onResumeSession` (haxford's returns early when a run is still
   * in flight, and again when the session id no longer resolves on disk). Both
   * guards are `return` with no output, so from the user's seat the picker just
   * closed and nothing happened — which is what "/sessions is broken" looks
   * like. A resume that lands always calls `store.reset`, which bumps the
   * epoch, so an unchanged epoch after the grace period is proof it was
   * swallowed. Say so rather than leaving the user to guess.
   */
  const selectSession = useCallback(
    (id: string) => {
      setUi((u) => ({ ...u, showSessions: { kind: "idle" } }))
      const epochBefore = store.getState().epoch
      onResumeSession(id)
      setTimeout(() => {
        if (store.getState().epoch !== epochBefore) return
        store.dispatch({
          type: "notice",
          message:
            `could not resume ${id.slice(0, 8)} — the host declined it. ` +
            "A run may still be in flight (press esc to interrupt, then retry), " +
            "or the session no longer exists on disk.",
        })
      }, RESUME_TIMEOUT_MS)
    },
    [onResumeSession, store],
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

  const closeConnect = useCallback(() => {
    setUi((u) => ({ ...u, showConnect: false }))
  }, [])

  const submitConnect = useCallback(
    (provider: string, apiKey: string, baseURL?: string) => {
      setUi((u) => ({ ...u, showConnect: false }))
      onConnectProvider?.(provider, apiKey, baseURL)
    },
    [onConnectProvider],
  )

  // The /model picker's "+ connect a provider…" row routes here. The host
  // decides what to do; a common choice is to open the same /connect dialog,
  // which the app already renders when `showConnect` is true. Without a host
  // hook the row is hidden, so this never fires.
  const handleProviderConnect = useCallback(
    (_provider: string) => {
      setUi((u) => ({ ...u, showModelPicker: false, showConnect: true }))
      onProviderConnect?.(_provider)
    },
    [onProviderConnect],
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
      : running
        ? "agent running…"
        : // An overlay owns the keyboard, but the agent is idle. Saying
          // "agent running…" here was a plain lie, and it made a stuck-looking
          // picker read as a stuck-looking run.
          "esc to close"
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

  // The app's own transient hint wins over a host-set one (`TuiState.hint`):
  // the local one is always the more recent thing the user did. Falling back
  // to the store's keeps both producers on a single line instead of two
  // competing hint rows.
  const activeHint = hint ?? state.hint

  // Cost inputs for the footer. Recomputed only when the model or the catalog
  // changes; the token totals it multiplies live in the reducer.
  const pricing = useMemo(() => pricingForSpec(models, model), [models, model])

  // Epoch millis of the current run, for the activity line's clock. Recomputed
  // only on an idle -> running edge.
  const [runStartedAt, setRunStartedAt] = useState(() => Date.now())
  useEffect(() => {
    if (running) setRunStartedAt(Date.now())
  }, [running])

  const overlay =
    ui.showHelp || ui.showModelPicker || ui.showConnect || ui.showSessions.kind !== "idle" || pending !== undefined

  // The banner leads the static region, so it prints once per session and is
  // never redrawn. A `/clear` or a resume bumps the epoch, which remounts the
  // region — and a new session is exactly when a session header should print
  // again.
  const staticItems = useMemo<StaticItem[]>(
    () => [
      { kind: "banner", id: "banner" },
      ...finalized.map((message): StaticItem => ({ kind: "message", id: message.id, message })),
    ],
    [finalized],
  )

  // --- bottom pinning ------------------------------------------------------
  // A fresh session would otherwise draw its composer a third of the way down
  // the screen with dead space beneath it. Blank lines above the live region
  // push the input and footer onto the last rows instead, and every line the
  // transcript gains is a line of padding it takes back, so the padding decays
  // to nothing on its own once the content fills the viewport.
  const { stdout } = useStdout()
  const { columns, rows } = useTerminalSize(stdout)
  const transcriptLines = useMemo(
    () => estimateTranscriptLines(state.messages, columns) + state.notices.length,
    [state.messages, state.notices.length, columns],
  )
  const padding = overlay
    ? // An overlay is tall, transient, and measured by nothing here. Guessing
      // its height and guessing low would push the composer off the bottom of
      // the screen, so padding simply stands down while one is open.
      0
    : bottomPadding({
        height: rows,
        banner: BANNER_HEIGHT,
        breadcrumb: BREADCRUMB_LINES,
        input: composerHeight(composerValue, columns),
        footer: FOOTER_LINES,
        transcript:
          transcriptLines +
          (running ? 1 : 0) +
          (activeHint !== undefined ? 1 : 0),
      })

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
      {/*
        The key carries the expansion flag as well as the epoch. <Static>
        prints each item once and never re-renders it, so without the remount
        a ctrl+o would only reach the live tail and leave every settled tool
        call at its old size — a toggle that visibly applies to some of the
        screen is worse than one that applies to none of it.
      */}
      <Static key={`${state.epoch}:${state.toolsExpanded ? "x" : "c"}`} items={staticItems}>
        {(item) =>
          item.kind === "banner" ? (
            // No marginTop: the banner is the first thing on the screen, and
            // a blank line above it is a blank line at the top of the session.
            <Box key="banner" flexDirection="column">
              <Banner model={model} cwd={cwd ?? "."} contextLimit={contextLimit} />
            </Box>
          ) : (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <MessageView message={item.message} toolsExpanded={state.toolsExpanded} />
            </Box>
          )
        }
      </Static>

      <Box flexDirection="column">
        {/* Bottom-pinning padding. First in the live region, so what follows
            it lands on the terminal's last rows. */}
        {padding > 0 ? <Box height={padding} flexShrink={0} /> : null}

        {live.length > 0 || state.notices.length > 0 ? (
          <Box marginTop={finalized.length > 0 ? 1 : 0}>
            <Transcript messages={live} notices={state.notices} toolsExpanded={state.toolsExpanded} />
          </Box>
        ) : null}

        {/* How the last turn ended, inline where it happened: "interrupted"
            for a deliberate abort, the error in red for a failure. */}
        <TurnOutcome status={state.status} endReason={state.endReason} error={state.error} />

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
            <Text dimColor>{"loading sessions\u2026"}</Text>
          </Box>
        ) : null}

        {ui.showSessions.kind === "ready" ? (
          <Box marginTop={1}>
            <SessionPicker
              sessions={ui.showSessions.sessions}
              cwd={cwd}
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
              providerCatalog={providerCatalog}
              onProviderConnect={handleProviderConnect}
            />
          </Box>
        ) : null}

        {ui.showConnect && providerCatalog !== undefined ? (
          <Box marginTop={1}>
            <ConnectDialog
              providerCatalog={providerCatalog}
              onConnect={submitConnect}
              onCancel={closeConnect}
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

        {/*
          The chrome stack: everything below here is fixed-height and always
          on screen, separated from the transcript by exactly one blank row.
          One margin for the whole group rather than one per member is what
          lets the pin math treat its height as a constant.
        */}
        <Box flexDirection="column" marginTop={1}>
        {/*
          Transient chrome feedback (mode switch, ctrl+c confirmation). It sits
          directly above the breadcrumb — the band the eye is already trained
          on — and expires on its own, so nothing it says ever reaches the
          transcript.
        */}
        {activeHint !== undefined ? (
          <Box paddingLeft={2}>
            <Text dimColor>{activeHint}</Text>
          </Box>
        ) : null}

        {/* Mode and model, one line above where you type. Memoized on exactly
            those two values, so a streaming reply never redraws it. */}
        <Breadcrumb mode={mode} model={model} />

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

        <StatusBar
          model={model}
          mode={mode}
          status={state.status}
          usage={state.usage}
          contextLimit={contextLimit}
          {...pricing}
        />
        </Box>
      </Box>
    </SpinnerProvider>
  )
}

// Re-export shared types so hosts can import everything from app.tsx if desired.
export type { ApprovalBridge, TuiStore }
