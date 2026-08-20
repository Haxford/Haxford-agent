export type Role = "user" | "assistant"

export interface TextPart {
  id: string
  type: "text"
  text: string
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
}

export type ToolState =
  | { status: "pending" }
  | { status: "running"; input: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      time: { start: number; end: number }
    }

export interface ToolPart {
  id: string
  type: "tool"
  tool: string
  callID: string
  state: ToolState
}

export type Part = TextPart | ReasoningPart | ToolPart

export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
}

export interface Message {
  id: string
  sessionID: string
  role: Role
  /** Agent that produced this message (e.g. "build" or a subagent name). */
  agent?: string
  /** "provider/model" that produced this message. */
  model?: string
  parts: Part[]
  usage?: TokenUsage
  error?: string
  time: { created: number; completed?: number }
}
