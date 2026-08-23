import type { AgentEvent } from "../types/events.ts"
import type { Message } from "../types/message.ts"
import { fromMessages, initialTuiState, reduce, type TuiState } from "./state.ts"

/**
 * Most prompts that may wait behind a running turn.
 *
 * High enough that no one types into it by accident, low enough that a run
 * which never finishes cannot turn the queue into an unbounded buffer of
 * user text.
 */
export const MAX_QUEUED = 100

/**
 * How long a notice stays visible before it auto-clears.
 *
 * Notices used to accumulate for the life of the session (capped only at 50
 * in `reduce`), so a handful of "unknown command"/reload/compaction notices
 * from early in a long session sat above the composer forever, stacking with
 * whatever the agent said later. A few seconds is enough to actually read
 * one; nothing here is meant to be a permanent record — that's what the
 * transcript is for.
 */
export const NOTICE_TTL_MS = 4000

/**
 * External store wrapping TuiState. Suitable for React's `useSyncExternalStore`:
 * `getState()` returns a stable reference until a dispatch/reset produces a
 * new state, so React does not need to re-render on unrelated notifications.
 */
export interface TuiStore {
  /** Snapshot suitable for useSyncExternalStore (stable until a change). */
  getState(): TuiState
  /** Apply an AgentEvent to the current state. No-op if it does not change state. */
  dispatch(event: AgentEvent): void
  /** Replace all messages (e.g. on session resume or /clear). */
  reset(messages: Message[]): void
  /**
   * Show a transient status hint for `ttlMs` (default 2s), then clear it.
   *
   * Unlike a notice, a hint is not part of the transcript: it carries no
   * durable meaning and never enters the message history. Used for ephemeral
   * confirmations like "anthropic connected" after /connect — the same role
   * mode switches play via the persistent status bar, but time-boxed.
   */
  setHint(text: string, ttlMs?: number): void
  /**
   * Expand or collapse tool output across the whole transcript.
   *
   * Returns the state it settled on, so a caller that toggles can report it
   * without a second read. A no-op call (setting the value it already holds)
   * does not notify.
   */
  setToolsExpanded(expanded: boolean): boolean
  /**
   * Push a prompt submitted while a run is already in flight onto the back of
   * the queue. FIFO: the host flushes from the front once idle.
   *
   * Returns false when the queue is already at `MAX_QUEUED` and the prompt was
   * refused, so the caller can tell the user rather than appearing to accept
   * a message it silently dropped.
   */
  enqueue(text: string): boolean
  /** Pop and return the oldest queued prompt, or undefined if the queue is empty. */
  dequeue(): string | undefined
  /**
   * Pop and return the MOST RECENTLY queued prompt (the back of the queue),
   * for up-arrow-on-empty-composer editing. Undefined if the queue is empty.
   */
  popLastQueued(): string | undefined
  /** subscribe(listener) -> unsubscribe; fires only on actual state changes. */
  subscribe(listener: () => void): () => void
}

export interface TuiStoreOptions {
  /** Overrides `NOTICE_TTL_MS`. Exists for tests — real hosts want the default. */
  noticeTtlMs?: number
}

/**
 * Create a TuiStore seeded with an initial message list. The seed is cloned so
 * callers cannot mutate the store's internal state by holding onto the array.
 */
export function createTuiStore(initial: Message[], opts: TuiStoreOptions = {}): TuiStore {
  const noticeTtlMs = opts.noticeTtlMs ?? NOTICE_TTL_MS
  let state: TuiState = fromMessages(initial)
  const listeners = new Set<() => void>()
  // Session generation. The transcript keys its <Static> region on this so a
  // reset (which shrinks the message list) remounts rather than re-printing.
  let epoch = 0
  // Timer for the currently-scheduled hint clear, so setHint/reset can cancel it.
  let hintTimer: ReturnType<typeof setTimeout> | undefined

  // Per-notice expiry. `state.notices` is a plain string[] (the frozen shape
  // other consumers read), so the id that ties a live entry to its timer is
  // tracked here, in lockstep by position — `noticeIds[i]` is the id of
  // `state.notices[i]`. `reduce`'s own cap (oldest dropped past 50) trims
  // from the front the same way, so the two arrays stay aligned without
  // reduce() needing to know ids exist at all.
  let noticeSeq = 0
  let noticeIds: number[] = []
  const noticeTimers = new Map<number, ReturnType<typeof setTimeout>>()

  const clearNoticeTimers = (): void => {
    for (const timer of noticeTimers.values()) clearTimeout(timer)
    noticeTimers.clear()
    noticeIds = []
  }

  const expireNotice = (id: number): void => {
    noticeTimers.delete(id)
    const idx = noticeIds.indexOf(id)
    // Already gone — dropped by the 50-entry cap, or a reset since this timer
    // was scheduled. Either way there is nothing left to clear.
    if (idx === -1) return
    noticeIds = [...noticeIds.slice(0, idx), ...noticeIds.slice(idx + 1)]
    state = {
      ...state,
      notices: [...state.notices.slice(0, idx), ...state.notices.slice(idx + 1)],
    }
    notify()
  }

  const notify = (): void => {
    for (const l of listeners) l()
  }

  return {
    getState(): TuiState {
      return state
    },

    dispatch(event: AgentEvent): void {
      const next = reduce(state, event)
      // Skip notify when the reducer returns the same reference (no change).
      if (next === state) return
      state = next
      if (event.type === "notice") {
        const id = noticeSeq++
        noticeIds = [...noticeIds, id]
        // Mirror reduce()'s own cap: it just dropped the oldest notice(s) off
        // the front once past 50, so trim the id list the same way to stay
        // aligned with state.notices.
        if (noticeIds.length > state.notices.length) {
          noticeIds = noticeIds.slice(noticeIds.length - state.notices.length)
        }
        noticeTimers.set(
          id,
          setTimeout(() => expireNotice(id), noticeTtlMs),
        )
      }
      notify()
    },

    reset(messages: Message[]): void {
      // Full reset: fresh state seeded with the given messages. Notices and
      // usage/turn counters are cleared. The host may re-emit notices after.
      // The epoch bump tells the transcript to remount its <Static> region:
      // the message list just shrank, and Ink's <Static> cannot handle that.
      epoch += 1
      if (hintTimer !== undefined) {
        clearTimeout(hintTimer)
        hintTimer = undefined
      }
      clearNoticeTimers()
      // toolsExpanded rides through: it is a view preference, not session
      // data, and having /clear silently re-collapse everything would be a
      // small betrayal of a setting the user just chose.
      state = { ...fromMessages(messages), epoch, toolsExpanded: state.toolsExpanded }
      notify()
    },

    setHint(text: string, ttlMs: number = 2000): void {
      if (hintTimer !== undefined) {
        clearTimeout(hintTimer)
        hintTimer = undefined
      }
      // Preserve any existing reducer state (messages, usage, …) — the hint
      // is UI-only and rides alongside the real state without disturbing it.
      state = { ...state, hint: text }
      notify()
      const timer = setTimeout(() => {
        // Only clear if this hint is still the one we set (a later setHint
        // resets the timer and would otherwise be clobbered).
        if (state.hint === text) {
          state = { ...state, hint: undefined }
          notify()
        }
        if (hintTimer === timer) hintTimer = undefined
      }, ttlMs)
      hintTimer = timer
    },

    setToolsExpanded(expanded: boolean): boolean {
      if (state.toolsExpanded === expanded) return expanded
      state = { ...state, toolsExpanded: expanded }
      notify()
      return expanded
    },

    enqueue(text: string): boolean {
      // Bounded on purpose. A run that never ends — a wedged provider, a
      // model looping on tool calls — leaves the composer live and every
      // submission accumulating here, and each entry is a whole prompt.
      // Refusing at the cap and saying so beats growing without limit and
      // then replaying a hundred stale prompts when the run finally lands.
      if (state.queue.length >= MAX_QUEUED) return false
      state = { ...state, queue: [...state.queue, text] }
      notify()
      return true
    },

    dequeue(): string | undefined {
      const [next, ...rest] = state.queue
      if (next === undefined) return undefined
      state = { ...state, queue: rest }
      notify()
      return next
    },

    popLastQueued(): string | undefined {
      if (state.queue.length === 0) return undefined
      const last = state.queue[state.queue.length - 1]
      state = { ...state, queue: state.queue.slice(0, -1) }
      notify()
      return last
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
