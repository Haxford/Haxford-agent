import type { AgentEvent } from "../types/events.ts"
import type { Message } from "../types/message.ts"
import { fromMessages, initialTuiState, reduce, type TuiState } from "./state.ts"

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
  /** subscribe(listener) -> unsubscribe; fires only on actual state changes. */
  subscribe(listener: () => void): () => void
}

/**
 * Create a TuiStore seeded with an initial message list. The seed is cloned so
 * callers cannot mutate the store's internal state by holding onto the array.
 */
export function createTuiStore(initial: Message[]): TuiStore {
  let state: TuiState = fromMessages(initial)
  const listeners = new Set<() => void>()
  // Session generation. The transcript keys its <Static> region on this so a
  // reset (which shrinks the message list) remounts rather than re-printing.
  let epoch = 0
  // Timer for the currently-scheduled hint clear, so setHint/reset can cancel it.
  let hintTimer: ReturnType<typeof setTimeout> | undefined

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
      state = { ...fromMessages(messages), epoch }
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

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
