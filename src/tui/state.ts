import type { AgentEvent } from "../types/events.ts"
import type { Message, Part, ReasoningPart, TextPart, TokenUsage } from "../types/message.ts"

/** Cumulative token usage across a session. */
export interface TotalUsage {
  input: number
  output: number
  reasoning: number
}

/** Why the loop is not currently producing events. */
export type RunStatus = "idle" | "running" | "ended" | "error"

/** Full TUI render state. Keep this pure: no React, no I/O. */
export interface TuiState {
  /** Messages keyed by id; insertion order preserved. */
  messages: Message[]
  /** Current turn index (last turn.start seen), 0 before any turn. */
  turn: number
  /** Whether the agent loop is currently producing events. */
  status: RunStatus
  /** Human-readable reason for the last loop.end, if any. */
  endReason?: string
  /** Cumulative token usage. */
  usage: TotalUsage
  /** Last error message emitted via { type: "error" }. */
  error?: string
  /** Informational system notes (newest last), capped at 50. */
  notices: string[]
  /**
   * Transient status hint (e.g. "anthropic connected"), shown briefly then
   * auto-cleared by the store. NOT a transcript notice: it carries no
   * durable meaning and never enters the message history. Set via
   * `store.setHint()`, not through an AgentEvent (the contract is frozen).
   */
  hint?: string
  /**
   * Session generation. Bumped by the store on every `reset()` (i.e. /clear or
   * a resume). The transcript keys its `<Static>` region on this so Ink
   * remounts it instead of re-printing a shrunk item list — see
   * `splitTranscript`.
   */
  epoch: number
}

export const initialTuiState: TuiState = {
  messages: [],
  turn: 0,
  status: "idle",
  usage: { input: 0, output: 0, reasoning: 0 },
  notices: [],
  epoch: 0,
  hint: undefined,
}

/** Maximum number of notices retained in state. */
const MAX_NOTICES = 50

/** Find a message index by id. */
function findMessage(messages: Message[], id: string): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.id === id) return i
  }
  return -1
}

/** Find a part index within a message by part id. */
function findPart(message: Message, partID: string): number {
  for (let i = 0; i < message.parts.length; i++) {
    if (message.parts[i]!.id === partID) return i
  }
  return -1
}

/** Structurally clone a message so callers never mutate stored state. */
function cloneMessage(m: Message): Message {
  const { usage: _usage, ...rest } = m
  void _usage
  return {
    ...rest,
    parts: m.parts.map((p) => ({ ...p })),
    ...(m.usage ? { usage: { ...m.usage } } : {}),
    time: { ...m.time },
  }
}

/** Replace a message at an index with a shallow+parts clone. */
function withMessage(
  messages: Message[],
  index: number,
  next: Message,
): Message[] {
  const copy = messages.slice()
  copy[index] = next
  return copy
}

/** Pure reducer: (state, event) -> state. Returns a new state object. */
export function reduce(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "message.updated": {
      const idx = findMessage(state.messages, event.message.id)
      if (idx === -1) {
        return { ...state, messages: [...state.messages, cloneMessage(event.message)] }
      }
      return { ...state, messages: withMessage(state.messages, idx, cloneMessage(event.message)) }
    }

    case "part.updated": {
      const idx = findMessage(state.messages, event.messageID)
      if (idx === -1) return state
      const msg = cloneMessage(state.messages[idx]!)
      const pi = findPart(msg, event.part.id)
      if (pi === -1) {
        msg.parts = [...msg.parts, { ...event.part }]
      } else {
        const parts = msg.parts.slice()
        parts[pi] = { ...event.part }
        msg.parts = parts
      }
      return { ...state, messages: withMessage(state.messages, idx, msg) }
    }

    case "part.delta": {
      const idx = findMessage(state.messages, event.messageID)
      if (idx === -1) return state
      const msg = cloneMessage(state.messages[idx]!)
      const pi = findPart(msg, event.partID)
      // Upsert: the real loop emits message.updated with an empty parts array,
      // then part.delta before any part.updated, so the part may not exist yet.
      // Create a TextPart keyed by the delta's partID and append it.
      if (pi === -1) {
        const created: TextPart = { id: event.partID, type: "text", text: event.delta }
        msg.parts = [...msg.parts, created]
        return { ...state, messages: withMessage(state.messages, idx, msg) }
      }
      const part = msg.parts[pi]!
      // Deltas apply to text-bearing parts (text / reasoning). Reasoning parts
      // preserve their type — a delta accumulates onto their text, not rewrites
      // them into TextParts.
      if (part.type === "text" || part.type === "reasoning") {
        const updated: TextPart | ReasoningPart =
          part.type === "text"
            ? { ...part, text: part.text + event.delta }
            : { ...part, text: part.text + event.delta }
        const parts = msg.parts.slice()
        parts[pi] = updated
        msg.parts = parts
        return { ...state, messages: withMessage(state.messages, idx, msg) }
      }
      return state
    }

    case "usage": {
      const u: TokenUsage = event.usage
      const usage: TotalUsage = {
        input: state.usage.input + (u.input ?? 0),
        output: state.usage.output + (u.output ?? 0),
        reasoning: state.usage.reasoning + (u.reasoning ?? 0),
      }
      // Also attach usage to the originating message if present.
      const idx = findMessage(state.messages, event.messageID)
      if (idx === -1) return { ...state, usage }
      const msg = cloneMessage(state.messages[idx]!)
      msg.usage = { ...u }
      return { ...state, usage, messages: withMessage(state.messages, idx, msg) }
    }

    case "turn.start": {
      return { ...state, turn: event.turn, status: "running", endReason: undefined, error: undefined }
    }

    case "turn.end": {
      return { ...state, turn: event.turn }
    }

    case "loop.end": {
      // Preserve a prior error status: an error event followed by loop.end
      // must not be overwritten with "ended", or the status bar hides the
      // failure. Only transition to "ended" when not already in an error.
      if (state.status === "error") {
        return { ...state, endReason: event.reason }
      }
      return { ...state, status: "ended", endReason: event.reason }
    }

    case "error": {
      return { ...state, status: "error", error: event.message }
    }

    case "notice": {
      // Append newest last; drop oldest beyond the cap.
      const notices = [...state.notices, event.message]
      if (notices.length > MAX_NOTICES) {
        return { ...state, notices: notices.slice(notices.length - MAX_NOTICES) }
      }
      return { ...state, notices }
    }

    case "permission.request": {
      // No dedicated UI surface yet; surface as an error string so it is visible.
      return { ...state, error: `permission: ${event.request.title}` }
    }

    default: {
      // Exhaustiveness check: if a new event type is added to the contract,
      // TS will error here.
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** Convenience: fold a sequence of events into a state. */
export function reduceAll(state: TuiState, events: AgentEvent[]): TuiState {
  let s = state
  for (const e of events) s = reduce(s, e)
  return s
}

/** Build a TuiState seeded with an existing message list (e.g. on resume). */
export function fromMessages(messages: Message[]): TuiState {
  return { ...initialTuiState, messages: messages.map(cloneMessage) }
}

/** A transcript split into an append-only prefix and the still-changing tail. */
export interface TranscriptSplit {
  /** Settled messages, safe to hand to Ink's `<Static>`. */
  finalized: Message[]
  /** The message that may still gain parts or text. At most one. */
  live: Message[]
}

/**
 * Split the transcript for `<Static>` rendering.
 *
 * Only the **last** message can still change: the reducer appends a new message
 * for each turn, and parts/deltas always land on the most recent one. So every
 * message before the last is settled and can be printed once and forgotten,
 * which is what makes streaming cost one message's worth of re-render instead
 * of the whole transcript's.
 *
 * The prefix is append-only within an epoch, which is exactly what Ink's
 * `<Static>` requires (it tracks how many items it has already emitted and
 * prints only the new tail). A shrink — `/clear`, or resuming a shorter
 * session — is handled by bumping `TuiState.epoch`, which remounts the region.
 *
 * Earlier messages can still receive invisible in-place updates (a `usage`
 * event attaching token counts). Those are not rendered, so freezing them
 * costs nothing.
 */
export function splitTranscript(messages: Message[]): TranscriptSplit {
  if (messages.length === 0) return { finalized: [], live: [] }
  return {
    finalized: messages.slice(0, messages.length - 1),
    live: messages.slice(messages.length - 1),
  }
}
