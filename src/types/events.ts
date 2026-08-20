import type { Message, Part, TokenUsage } from "./message.ts"
import type { PermissionRequest } from "./tool.ts"

export type LoopEndReason =
  | "end_turn"
  | "aborted"
  | "max_turns"
  | "permission_denied"
  | "error"

/**
 * Events emitted by the agent loop. The TUI (or any consumer) reduces this
 * stream into render state. All mutations to visible state flow through here.
 */
export type AgentEvent =
  | { type: "message.updated"; message: Message }
  | { type: "part.updated"; messageID: string; part: Part }
  | { type: "part.delta"; messageID: string; partID: string; delta: string }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "usage"; messageID: string; usage: TokenUsage }
  | { type: "turn.start"; turn: number }
  | { type: "turn.end"; turn: number }
  | { type: "loop.end"; reason: LoopEndReason }
  | { type: "error"; message: string }
