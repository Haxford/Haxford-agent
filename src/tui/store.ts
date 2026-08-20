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
      state = fromMessages(messages)
      notify()
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
